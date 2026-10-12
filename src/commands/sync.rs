use crate::errors::Result;
use crate::fmt::{bold, dim, green, yellow};
use crate::services::{config, sync};
use std::process::ExitCode;

// ---------------------------------------------------------------------------
// ship sync <project>
// ---------------------------------------------------------------------------

pub fn run(project: String) -> ExitCode {
    super::finish(run_inner(&project))
}

fn run_inner(project: &str) -> Result<()> {
    let project_config = config::get_project(project)?;

    println!();
    println!("  Syncing {}...", bold(project));

    let result = sync::sync(&project_config, None)?;

    println!("  {} Fetched        origin", green("✓"));

    if result.pulled && result.head_moved {
        println!(
            "  {} Pulled         main {}",
            green("✓"),
            dim("(fast-forward)")
        );
    } else if result.pulled {
        println!(
            "  {} Pulled         {}",
            dim("  ·"),
            dim("already up to date")
        );
    } else if let Some(skipped) = &result.skipped_pull {
        println!("  {} Skipped pull   {}", yellow("⚠"), dim(skipped));
    }

    if result.installed {
        println!("  {} Dependencies   installed", green("✓"));
    }
    if result.migrated {
        let source = match &project_config.database {
            Some(db) => dim(format!("({})", db.source)),
            None => String::new(),
        };
        println!("  {} Migrations     applied {}", green("✓"), source);
    }

    println!();
    Ok(())
}
