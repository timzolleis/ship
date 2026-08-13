use crate::errors::Result;
use crate::fmt::{bold, dim, green, red, yellow};
use crate::prompt;
use crate::schema::{ProjectConfig, Workspace};
use crate::services::github::{self, Pr};
use crate::services::workspace::{teardown, TeardownOptions};
use crate::services::{config, sync};
use crate::ui::{Row, Table};
use crate::util::plural;
use std::collections::HashSet;

// ---------------------------------------------------------------------------
// ship gc [--force] [--dry-run] [--sync]
// ---------------------------------------------------------------------------

struct Checked {
    ws: Workspace,
    project_config: Option<ProjectConfig>,
    pr: Option<Pr>,
    pr_label: String,
}

/// Tear down each cleaned workspace (worktree + branch + remote branch,
/// forced), then write the workspace registry exactly once to avoid
/// read-modify-write races. Returns the number removed from the registry.
fn gc_cleanup(to_clean: &[&Checked]) -> Result<usize> {
    for c in to_clean {
        if let Some(pc) = &c.project_config {
            let _ = teardown(
                &c.ws,
                pc,
                &TeardownOptions {
                    remove_worktree: true,
                    force: true,
                    delete_remote_branch: true,
                },
            );
        }
    }

    if to_clean.is_empty() {
        return Ok(0);
    }

    let removed: HashSet<(String, String)> = to_clean
        .iter()
        .map(|c| (c.ws.project.clone(), c.ws.branch.clone()))
        .collect();
    let current = config::load_workspaces()?;
    let filtered: Vec<Workspace> = current
        .into_iter()
        .filter(|w| !removed.contains(&(w.project.clone(), w.branch.clone())))
        .collect();
    config::save_workspaces(&filtered)?;
    Ok(to_clean.len())
}

/// `<project>  <branch>  PR #42 merged 2d ago  → keep`. The verdict is last,
/// so measuring the table before verdicts are known still lines up.
fn row(c: &Checked, verdict: &str) -> Row<()> {
    Row::new(
        (),
        [
            dim(&c.ws.project),
            bold(&c.ws.branch),
            c.pr_label.clone(),
            format!("→ {verdict}"),
        ],
    )
}

fn line(table: &Table, c: &Checked, verdict: &str) -> String {
    format!("  {}", table.line(&row(c, verdict), ""))
}

pub fn run(force: bool, dry_run: bool, should_sync: bool) {
    if let Err(e) = run_inner(force, dry_run, should_sync) {
        eprintln!("\n  {} {}\n", red("Error:"), e);
    }
}

fn run_inner(force: bool, dry_run: bool, should_sync: bool) -> Result<()> {
    let workspaces = config::load_workspaces()?;

    if workspaces.is_empty() {
        println!("  {}", dim("No active workspaces."));
        return Ok(());
    }

    println!();
    println!(
        "  Checking {} workspace{}...",
        workspaces.len(),
        plural(workspaces.len())
    );

    // Phase 1: check all PR statuses in parallel (gh pr view per workspace).
    let checked: Vec<Checked> = github::look_up_all(&workspaces)
        .into_iter()
        .zip(workspaces.iter().cloned())
        .map(|(looked_up, ws)| Checked {
            ws,
            project_config: looked_up.project_config,
            pr_label: github::pr_label(looked_up.pr.as_ref()),
            pr: looked_up.pr,
        })
        .collect();

    println!();

    // Phase 2: display results and prompt for cleanup.
    let is_merged = |c: &&Checked| c.pr.as_ref().map(Pr::is_merged).unwrap_or(false);
    let merged: Vec<&Checked> = checked.iter().filter(is_merged).collect();
    let kept: Vec<&Checked> = checked.iter().filter(|c| !is_merged(c)).collect();

    let all_rows: Vec<Row<()>> = checked.iter().map(|c| row(c, "")).collect();
    let table = Table::measure(&all_rows);

    for c in &kept {
        println!("{}", line(&table, c, &dim("keep")));
    }

    let cleaned: usize;

    if merged.is_empty() {
        println!();
        println!("  {}", dim("Nothing to clean up."));
        println!();
        return Ok(());
    }

    if dry_run {
        for c in &merged {
            println!("{}", line(&table, c, &yellow("would tear down")));
        }
        cleaned = merged.len();
    } else {
        // Collect approvals serially (prompts must be sequential) before any teardown.
        let to_clean: Vec<&Checked> = if force {
            merged.clone()
        } else {
            let mut approved = Vec::new();
            for c in &merged {
                let ok = prompt::confirm(
                    &format!(
                        "{}/{} — {}. Tear down?",
                        c.ws.project, c.ws.branch, c.pr_label
                    ),
                    false,
                )?;
                if ok {
                    approved.push(*c);
                } else {
                    println!("{}", line(&table, c, &dim("skipped")));
                }
            }
            approved
        };

        cleaned = gc_cleanup(&to_clean)?;

        for c in &to_clean {
            println!("{}", line(&table, c, &green("cleaned up")));
        }
    }

    println!();
    if cleaned > 0 {
        let verb = if dry_run {
            "would clean up"
        } else {
            "cleaned up"
        };
        println!(
            "  {} {} {} workspace{}.",
            green("✓"),
            verb,
            cleaned,
            plural(cleaned)
        );
    } else {
        println!("  {}", dim("Nothing to clean up."));
    }

    // Sync unique projects after cleanup.
    if should_sync && !dry_run && cleaned > 0 {
        let mut projects: Vec<String> = Vec::new();
        for c in &merged {
            if c.project_config.is_some() && !projects.contains(&c.ws.project) {
                projects.push(c.ws.project.clone());
            }
        }
        for project in projects {
            let project_config = config::get_project(&project)?;
            println!("  Syncing {}...", bold(&project));
            match sync::sync(&project_config, None) {
                Err(e) => println!("  {} Sync failed    {}", yellow("⚠"), dim(e.to_string())),
                Ok(result) => {
                    if result.head_moved {
                        println!(
                            "  {} Base updated   {}",
                            green("✓"),
                            dim("main fast-forwarded")
                        );
                        if result.migrated {
                            println!(
                                "  {} Base migrated  {}",
                                green("✓"),
                                dim(&project_config.database.source)
                            );
                        }
                    } else if let Some(skipped) = &result.skipped_pull {
                        println!("  {} Skipped pull   {}", yellow("⚠"), dim(skipped));
                    } else {
                        println!("  {}", dim("  · Base           already up to date"));
                    }
                }
            }
        }
    }

    println!();
    Ok(())
}
