use crate::domain::workspace_locate::locate_workspace;
use crate::errors::Result;
use crate::fmt::{bold, dim, green, red, yellow};
use crate::prompt;
use crate::schema::{ProjectConfig, Workspace};
use crate::services::config;
use crate::services::workspace::{teardown, Status, StepEvent, TeardownOptions, TeardownStep};
use crate::util::cwd_string;

// ---------------------------------------------------------------------------
// ship down [project] [branch] [--force] [--db-only]
// ---------------------------------------------------------------------------

fn render_teardown(e: &StepEvent<TeardownStep>) {
    let name = match e.step {
        TeardownStep::ProxyRoute => "Proxy route   ",
        TeardownStep::Database => "Database      ",
        TeardownStep::Worktree => "Worktree      ",
        TeardownStep::Branch => "Branch        ",
        TeardownStep::RemoteBranch => "Remote branch ",
        TeardownStep::ClaudeConvos => "Claude convos ",
    };
    match e.status {
        Status::Warning => println!(
            "  {} {} {}",
            yellow("⚠"),
            name,
            dim(e.detail.as_deref().unwrap_or("failed"))
        ),
        // claude-convos reports "skipped-existing" when there was nothing to clear.
        Status::SkippedExisting => {
            if e.step != TeardownStep::ClaudeConvos {
                println!("  {} {} skipped", dim("·"), name);
            }
        }
        Status::Done => println!("  {} {} done", green("✓"), name),
    }
}

/// Tear down a workspace, then drop its registry entry.
/// down's option mapping: remove_worktree = !db_only, delete_remote_branch = false.
pub fn tear_down_workspace(
    workspace: &Workspace,
    project_config: &ProjectConfig,
    db_only: bool,
    force: bool,
) -> Result<()> {
    let events = teardown(
        workspace,
        project_config,
        &TeardownOptions {
            remove_worktree: !db_only,
            force,
            delete_remote_branch: false,
        },
    );
    for e in &events {
        render_teardown(e);
    }
    config::remove_workspace(&workspace.project, &workspace.branch)
}

pub fn run(project: Option<String>, branch: Option<String>, force: bool, db_only: bool) {
    if let Err(e) = run_inner(project, branch, force, db_only) {
        eprintln!("\n  {} {}\n", red("Error:"), e);
    }
}

fn run_inner(
    project_opt: Option<String>,
    branch_opt: Option<String>,
    force: bool,
    db_only: bool,
) -> Result<()> {
    // Resolve target workspace.
    let workspace: Workspace = if let (Some(project), Some(branch)) = (&project_opt, &branch_opt) {
        match config::find_workspace(project, branch)? {
            Some(w) => w,
            None => {
                println!(
                    "  {} No workspace found for {} / {}",
                    red("✗"),
                    bold(project),
                    bold(branch)
                );
                return Ok(());
            }
        }
    } else {
        let workspaces = config::load_workspaces()?;
        let cwd = cwd_string();

        if let Some(w) = locate_workspace(&workspaces, &cwd, None) {
            w.clone()
        } else if !workspaces.is_empty() {
            let filtered: Vec<&Workspace> = match &project_opt {
                Some(p) => workspaces.iter().filter(|w| &w.project == p).collect(),
                None => workspaces.iter().collect(),
            };
            if filtered.is_empty() {
                println!(
                    "  {} No workspaces found for project {}",
                    red("✗"),
                    bold(project_opt.as_deref().unwrap_or("?"))
                );
                return Ok(());
            }
            let items: Vec<String> = filtered
                .iter()
                .map(|w| format!("{}  {}  {}", w.project, w.branch, dim(&w.proxy_domain)))
                .collect();
            let idx = prompt::select("Select workspace to tear down", &items)?;
            filtered[idx].clone()
        } else {
            println!("  {} No workspaces found.", red("✗"));
            return Ok(());
        }
    };

    // Confirm unless --force.
    if !force {
        let confirmed = prompt::confirm(
            &format!("Tear down workspace {}?", bold(&workspace.branch)),
            false,
        )?;
        if !confirmed {
            println!("  Cancelled.");
            return Ok(());
        }
    }

    let project_config = config::get_project(&workspace.project)?;

    println!();
    tear_down_workspace(&workspace, &project_config, db_only, force)?;
    println!();
    println!("  {}", green("Teardown complete."));
    println!();
    Ok(())
}
