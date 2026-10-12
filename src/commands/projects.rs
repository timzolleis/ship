use crate::errors::Result;
use crate::fmt::{blue, bold, dim};
use crate::services::config;
use crate::ui::{Live, Row};
use crate::util::plural;
use std::process::ExitCode;

// ---------------------------------------------------------------------------
// ship projects — list registered projects
// ---------------------------------------------------------------------------

pub fn run(json: bool) -> ExitCode {
    let result = if json { print_json() } else { run_inner() };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("Error: {e}");
            ExitCode::FAILURE
        }
    }
}

/// One summary per project; `ship config show --json` has the full config.
fn print_json() -> Result<()> {
    let rows: Vec<serde_json::Value> = config::load_config()?
        .projects
        .iter()
        .map(|(alias, p)| {
            serde_json::json!({
                "alias": alias,
                "path": p.path,
                "domain": p.domain,
                "port": p.port,
                "database": p.database.is_some(),
            })
        })
        .collect();
    super::print_json(&rows)
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
                match &project.database {
                    Some(db) if !db.docker_container().is_empty() => {
                        db.docker_container().to_string()
                    }
                    Some(_) => dim("local"),
                    None => dim("—"),
                },
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
