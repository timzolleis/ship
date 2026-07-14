use crate::errors::Result;
use crate::fmt::{blue, bold, dim};
use crate::schema::Workspace;
use crate::services::config;
use crate::util::plural;
use indexmap::IndexMap;

// ---------------------------------------------------------------------------
// ship ls [project]
// ---------------------------------------------------------------------------

pub fn run(project: Option<String>) {
    if let Err(e) = run_inner(project) {
        eprintln!("Error: {e}");
    }
}

fn run_inner(project_opt: Option<String>) -> Result<()> {
    let workspaces = config::load_workspaces()?;

    let filtered: Vec<&Workspace> = match &project_opt {
        Some(p) => workspaces.iter().filter(|w| &w.project == p).collect(),
        None => workspaces.iter().collect(),
    };

    if filtered.is_empty() {
        println!();
        println!("  {}", dim("No active workspaces."));
        println!("  {}", dim("Create one with: ship create <project> <branch>"));
        println!();
        return Ok(());
    }

    let mut by_project: IndexMap<String, Vec<&Workspace>> = IndexMap::new();
    for ws in &filtered {
        by_project.entry(ws.project.clone()).or_default().push(ws);
    }

    println!();

    for (project, list) in &by_project {
        println!("  {} workspaces:", bold(project));
        println!();
        println!("  {:<22} {:<38} {:<22} PORT", "BRANCH", "PROXY", "DB");
        println!(
            "  {} {} {} {}",
            dim("─".repeat(22)),
            dim("─".repeat(38)),
            dim("─".repeat(22)),
            dim("─".repeat(6))
        );

        for ws in list {
            println!(
                "  {} {} {:<22} {}",
                bold(format!("{:<22}", ws.branch)),
                blue(format!("{:<38}", ws.proxy_domain)),
                ws.db_name,
                blue(ws.port)
            );
        }
        println!();
    }

    println!(
        "  {}",
        dim(format!("{} workspace{}", filtered.len(), plural(filtered.len())))
    );
    println!();
    Ok(())
}
