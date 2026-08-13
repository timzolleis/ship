use crate::domain::workspace_locate::locate_workspace;
use crate::errors::Result;
use crate::fmt::{bold, green, red};
use crate::services::config;
use crate::services::workspace::{reset_database, ResetStep};
use crate::util::cwd_string;

// ---------------------------------------------------------------------------
// ship reset
// ---------------------------------------------------------------------------

pub fn run() {
    if let Err(e) = run_inner() {
        eprintln!("\n  {} {}\n", red("Error:"), e);
    }
}

fn run_inner() -> Result<()> {
    let workspaces = config::load_workspaces()?;
    let Some(workspace) = locate_workspace(&workspaces, &cwd_string(), None).cloned() else {
        println!("  {} Not inside a workspace.", red("✗"));
        return Ok(());
    };

    let project_config = config::get_project(&workspace.project)?;

    println!();
    println!("  Resetting database for {}...", bold(&workspace.branch));
    println!();

    let events = reset_database(&workspace, &project_config)?;
    for e in &events {
        match e.step {
            ResetStep::Drop => println!("  {} Dropped {}", green("✓"), workspace.db_name),
            ResetStep::Clone => println!("  {} Cloned → {}", green("✓"), workspace.db_name),
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
