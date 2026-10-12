use crate::domain::workspace_locate::locate_workspace;
use crate::errors::{Error, Result};
use crate::fmt::{bold, green};
use crate::services::config;
use crate::services::workspace::{reset_database, ResetStep};
use crate::util::cwd_string;
use std::process::ExitCode;

// ---------------------------------------------------------------------------
// ship reset
// ---------------------------------------------------------------------------

pub fn run() -> ExitCode {
    super::finish(run_inner())
}

fn run_inner() -> Result<()> {
    let workspaces = config::load_workspaces()?;
    let Some(workspace) = locate_workspace(&workspaces, &cwd_string(), None).cloned() else {
        return Err(Error::NotInWorkspace);
    };

    let project_config = config::get_project(&workspace.project)?;
    if project_config.database.is_none() {
        return Err(Error::NoDatabase {
            alias: workspace.project.clone(),
        });
    }

    println!();
    println!("  Resetting database for {}...", bold(&workspace.branch));
    println!();

    let events = reset_database(&workspace, &project_config)?;
    let db_name = workspace.db_name.as_deref().unwrap_or_default();
    for e in &events {
        match e.step {
            ResetStep::Drop => println!("  {} Dropped {}", green("✓"), db_name),
            ResetStep::Clone => println!("  {} Cloned → {}", green("✓"), db_name),
            ResetStep::Db => {
                println!(
                    "  {} {}",
                    green("✓"),
                    e.detail.as_deref().unwrap_or("db command")
                )
            }
        }
    }

    println!();
    println!("  {}", green("Database reset."));
    println!();
    Ok(())
}
