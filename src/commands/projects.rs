use crate::errors::Result;
use crate::fmt::{blue, bold, dim};
use crate::services::config;
use crate::ui::{Live, Row};
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

    let mut rows = vec![Row::new((), ["ALIAS", "PATH", "DB CONTAINER"].map(dim))];
    rows.extend(entries.iter().map(|(alias, project)| {
        Row::new(
            (),
            [
                bold(alias),
                blue(&project.path),
                project.database.docker_container().to_string(),
            ],
        )
    }));

    println!();
    Live::new(rows).print()?;

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
