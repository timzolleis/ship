use crate::errors::Result;
use crate::fmt::{blue, bold, dim};
use crate::schema::Workspace;
use crate::services::{config, github};
use crate::ui::{Cell, Live, Row};
use crate::util::plural;

// ---------------------------------------------------------------------------
// ship ls [project] [--no-pr]
// ---------------------------------------------------------------------------

/// Column of the PR status, filled in by the background `gh` lookup.
const PR_COLUMN: usize = 3;

/// The header occupies row 0, so a workspace's row is its index plus one.
const HEADER_ROWS: usize = 1;

pub fn run(project: Option<String>, no_pr: bool) {
    if let Err(e) = run_inner(project, no_pr) {
        eprintln!("Error: {e}");
    }
}

fn header(no_pr: bool) -> Row<()> {
    let columns: &[&str] = match no_pr {
        true => &["PROJECT", "BRANCH", "PORT"],
        false => &["PROJECT", "BRANCH", "PORT", "PR"],
    };
    Row::new((), columns.iter().map(dim))
}

fn row(ws: &Workspace) -> Row<()> {
    Row::new((), [dim(&ws.project), bold(&ws.branch), blue(ws.port)])
}

fn run_inner(project_opt: Option<String>, no_pr: bool) -> Result<()> {
    let workspaces = config::load_workspaces()?;

    let mut listed: Vec<Workspace> = match &project_opt {
        Some(p) => workspaces.into_iter().filter(|w| &w.project == p).collect(),
        None => workspaces,
    };
    // The registry is in creation order; one project per block reads better.
    listed.sort_by(|a, b| (&a.project, &a.branch).cmp(&(&b.project, &b.branch)));

    if listed.is_empty() {
        println!();
        println!("  {}", dim("No active workspaces."));
        println!(
            "  {}",
            dim("Create one with: ship create <project> <branch>")
        );
        println!();
        return Ok(());
    }

    let count = listed.len();
    let mut rows = vec![header(no_pr)];
    rows.extend(listed.iter().map(|ws| match no_pr {
        true => row(ws),
        false => row(ws).pending(),
    }));

    println!();
    let table = Live::new(rows);
    match no_pr {
        true => table.print()?,
        false => table.run(
            github::look_up_stream(listed),
            |(i, found): (usize, github::WorkspacePr)| {
                Cell::new(
                    i + HEADER_ROWS,
                    PR_COLUMN,
                    github::pr_label(found.pr.as_ref()),
                )
            },
        )?,
    }

    println!();
    println!("  {}", dim(format!("{} workspace{}", count, plural(count))));
    println!();
    Ok(())
}
