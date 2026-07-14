use crate::domain::workspace_locate::locate_workspace;
use crate::errors::Result;
use crate::fmt::{bold, green, red};
use crate::services::config;
use crate::services::workspace::{reset_database, ResetStep};
use crate::util::cwd_string;

// ---------------------------------------------------------------------------
// ship reset [--fresh]
// ---------------------------------------------------------------------------

pub fn run(fresh: bool) {
    if let Err(e) = run_inner(fresh) {
        eprintln!("\n  {} {}\n", red("Error:"), e);
    }
}

fn run_inner(fresh: bool) -> Result<()> {
    let workspaces = config::load_workspaces()?;
    let Some(workspace) = locate_workspace(&workspaces, &cwd_string(), None).cloned() else {
        println!("  {} Not inside a workspace.", red("✗"));
        return Ok(());
    };

    let project_config = config::get_project(&workspace.project)?;

    println!();
    println!("  Resetting database for {}...", bold(&workspace.branch));
    println!();

    let events = reset_database(&workspace, &project_config, fresh)?;
    for e in &events {
        match e.step {
            ResetStep::Drop => println!("  {} Dropped {}", green("✓"), workspace.db_name),
            ResetStep::Create => println!("  {} Created empty {}", green("✓"), workspace.db_name),
            ResetStep::Clone => println!("  {} Cloned → {}", green("✓"), workspace.db_name),
            ResetStep::Migrate => println!("  {} Migrations applied", green("✓")),
            ResetStep::Seed => println!("  {} Seeded", green("✓")),
        }
    }

    println!();
    println!("  {}", green("Database reset."));
    println!();
    Ok(())
}
