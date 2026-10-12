use crate::commands::teardown;
use crate::domain::remote_branch::{self, RemoteBranchAction, RemoteBranchPolicy};
use crate::domain::workspace_locate::locate_workspace;
use crate::errors::{Error, Result};
use crate::fmt::{bold, dim, green, red, yellow};
use crate::prompt::{self, Unattended};
use crate::schema::Workspace;
use crate::services::config;
use crate::services::github;
use crate::services::workspace::{TeardownJob, TeardownOptions};
use crate::ui::{Picker, Row, Table, Update};
use crate::util::{cwd_string, plural};
use std::process::ExitCode;

// ---------------------------------------------------------------------------
// ship down [project] [branch] [--force] [--db-only] [--remote]
// ---------------------------------------------------------------------------

fn down_options(db_only: bool, force: bool, remote_branch: RemoteBranchAction) -> TeardownOptions {
    TeardownOptions {
        remove_worktree: !db_only,
        force,
        remote_branch,
    }
}

pub fn run(
    project: Option<String>,
    branch: Option<String>,
    force: bool,
    db_only: bool,
    remote: bool,
) -> ExitCode {
    super::finish_with(run_inner(project, branch, force, db_only, remote))
}

/// Column of the PR status, filled in by the background `gh` lookup.
const PR_COLUMN: usize = 2;

/// `<project>  <branch>  PR #42 merged 2d ago`
fn row(ws: &Workspace, pr_label: Option<&str>) -> Row<Workspace> {
    let cells = [dim(&ws.project), bold(&ws.branch)];
    match pr_label {
        Some(label) => Row::new(ws.clone(), cells.into_iter().chain([label.to_string()])),
        None => Row::new(ws.clone(), cells).pending(),
    }
}

/// A workspace to tear down, plus authoritative PR state once looked up.
struct Target {
    ws: Workspace,
    pr: Option<github::Pr>,
}

impl Target {
    fn pending(ws: Workspace) -> Self {
        Target { ws, pr: None }
    }
}

/// Checkbox picker over every candidate workspace. The list draws at once and
/// each PR status swaps in as `gh` answers, so nobody waits to start picking.
/// Returns the picked workspaces (empty = cancelled).
fn pick_workspaces(candidates: &[&Workspace]) -> Result<Vec<Target>> {
    let mut owned: Vec<Workspace> = candidates.iter().map(|w| (*w).clone()).collect();
    owned.sort_by(Workspace::listing_order);
    let rows = owned.iter().map(|ws| row(ws, None)).collect();
    let prs = github::look_up_stream(owned);

    let picked = Picker::new("Select workspaces to tear down", rows)
        .multi()
        .header(&["PROJECT", "BRANCH", "PR"])
        .stream(prs, |(i, found): (usize, github::WorkspacePr)| {
            Update::new(i, PR_COLUMN, github::pr_label(found.pr.as_ref()))
        })
        .interact("<project> <branch>")?;

    Ok(picked
        .into_iter()
        .map(|r| Target::pending(r.value))
        .collect())
}

fn run_inner(
    project_opt: Option<String>,
    branch_opt: Option<String>,
    force: bool,
    db_only: bool,
    remote: bool,
) -> Result<ExitCode> {
    // Resolve targets. Explicit args and the cwd workspace stay single-target;
    // only the "nothing to go on" path opens the picker.
    let mut targets: Vec<Target> =
        if let (Some(project), Some(branch)) = (&project_opt, &branch_opt) {
            match config::find_workspace(project, branch)? {
                Some(w) => vec![Target::pending(w)],
                None => {
                    return Err(Error::WorkspaceNotFound {
                        branch: format!("{project}/{branch}"),
                    })
                }
            }
        } else {
            let workspaces = config::load_workspaces()?;
            let cwd = cwd_string();

            if let Some(w) = locate_workspace(&workspaces, &cwd, None) {
                vec![Target::pending(w.clone())]
            } else if !workspaces.is_empty() {
                let candidates: Vec<&Workspace> = match &project_opt {
                    Some(p) => workspaces.iter().filter(|w| &w.project == p).collect(),
                    None => workspaces.iter().collect(),
                };
                if candidates.is_empty() {
                    return Err(Error::NoActiveWorkspaces);
                }
                pick_workspaces(&candidates)?
            } else {
                return Err(Error::NoActiveWorkspaces);
            }
        };

    if targets.is_empty() {
        println!("  Cancelled.");
        return Ok(ExitCode::SUCCESS);
    }

    let remote_policy = if remote {
        RemoteBranchPolicy::AlwaysDelete
    } else {
        RemoteBranchPolicy::ClosedPullRequestsOnly
    };

    // Confirmation shows PR status, and the safe default needs authoritative
    // PR state even with --force. Picker cell updates are display-only, so
    // selected picker rows are looked up again here.
    if !force || (!db_only && !remote) {
        let selected: Vec<Workspace> = targets.iter().map(|t| t.ws.clone()).collect();
        for (target, looked_up) in targets.iter_mut().zip(github::look_up_all(&selected)) {
            target.pr = looked_up.pr;
        }
    }

    if !force {
        let rows: Vec<Row<Workspace>> = targets
            .iter()
            .map(|t| row(&t.ws, Some(&github::pr_label(t.pr.as_ref()))))
            .collect();
        let table = Table::measure(&rows);
        println!();
        for r in &rows {
            println!("  {}", table.line(r, ""));
        }
        println!();

        let question = match targets.len() {
            1 => format!("Tear down workspace {}?", bold(&targets[0].ws.branch)),
            n => format!("Tear down {n} workspaces?"),
        };
        if !prompt::confirm(&question, false, Unattended::Require("--force"))? {
            println!("  Cancelled.");
            return Ok(ExitCode::SUCCESS);
        }
    }

    // One unreadable project must not strand the rest — report it and carry on.
    let mut failures: Vec<(String, String)> = Vec::new();
    let total = targets.len();
    let mut jobs = Vec::new();
    for Target { ws, pr } in &targets {
        match config::get_project(&ws.project) {
            Ok(pc) => jobs.push(TeardownJob {
                ws: ws.clone(),
                pc,
                opts: down_options(
                    db_only,
                    force,
                    remote_branch::decide(
                        github::pull_request_branch_state(pr.as_ref()),
                        remote_policy,
                    ),
                ),
            }),
            Err(e) => failures.push((format!("{}/{}", ws.project, ws.branch), e.to_string())),
        }
    }

    println!();
    let mut broke = false;
    match teardown::run_all(jobs) {
        // The tree already showed which step broke; say what it cost.
        Ok(kept) => failures.extend(
            kept.into_iter()
                .map(|name| (name, "kept in the registry".to_string())),
        ),
        Err(e) => {
            broke = true;
            println!("  {} {}", red("✗"), dim(e.to_string()))
        }
    }

    println!();
    let done = total - failures.len();
    if failures.is_empty() {
        match total {
            1 => println!("  {}", green("Teardown complete.")),
            n => println!("  {} Tore down {} workspace{}.", green("✓"), n, plural(n)),
        }
    } else {
        for (name, err) in &failures {
            println!("  {} {} {}", yellow("⚠"), name, dim(err));
        }
        println!(
            "  {} Tore down {} of {} workspaces.",
            yellow("⚠"),
            done,
            total
        );
    }
    println!();
    Ok(if failures.is_empty() && !broke {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    })
}
