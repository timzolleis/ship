use crate::errors::Result;
use crate::fmt::{blue, bold, dim};
use crate::services::config;
use crate::util::plural;

// ---------------------------------------------------------------------------
// ship projects — list registered projects
// ---------------------------------------------------------------------------

pub fn run() {
    if let Err(e) = run_inner() {
        eprintln!("Error: {e}");
    }
}

fn run_inner() -> Result<()> {
    let ship_config = config::load_config()?;
    let entries: Vec<_> = ship_config.projects.iter().collect();

    if entries.is_empty() {
        println!();
        println!("  {}", dim("No projects registered."));
        println!("  {}", dim("Register one with: ship init"));
        println!();
        return Ok(());
    }

    let alias_width = entries
        .iter()
        .map(|(a, _)| a.len())
        .max()
        .unwrap_or(0)
        .max(7);

    println!();
    println!(
        "  {:<aw$}  {:<40}  DB CONTAINER",
        "ALIAS",
        "PATH",
        aw = alias_width
    );
    println!(
        "  {}  {}  {}",
        dim("─".repeat(alias_width)),
        dim("─".repeat(40)),
        dim("─".repeat(16))
    );

    for (alias, project) in &entries {
        println!(
            "  {}  {}  {}",
            bold(format!("{:<aw$}", alias, aw = alias_width)),
            blue(format!("{:<40}", project.path)),
            project.database.docker_container()
        );
    }

    println!();
    println!(
        "  {}",
        dim(format!(
            "{} project{}",
            entries.len(),
            plural(entries.len())
        ))
    );
    println!();
    Ok(())
}
