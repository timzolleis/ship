use crate::errors::Result;
use crate::fmt::{blue, bold, dim};
use crate::schema::Workspace;
use crate::services::{config, github};
use crate::ui::{Cell, Live, Row};
use crate::util::plural;
use std::process::ExitCode;

// ---------------------------------------------------------------------------
// ship ls [project] [--no-pr]
// ---------------------------------------------------------------------------

/// Column of the PR status, filled in by the background `gh` lookup.
const PR_COLUMN: usize = 3;

/// The header occupies row 0, so a workspace's row is its index plus one.
const HEADER_ROWS: usize = 1;

pub fn run(project: Option<String>, no_pr: bool, json: bool) -> ExitCode {
    let result = if json {
        print_json(project, no_pr)
    } else {
        run_inner(project, no_pr)
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("Error: {e}");
            ExitCode::FAILURE
        }
    }
}

/// Titles for `cells`. `ship open`'s picker shares both so the two listings
/// read the same.
pub const COLUMNS: [&str; 3] = ["PROJECT", "BRANCH", "PORT"];

pub fn cells(ws: &Workspace) -> [String; 3] {
    [dim(&ws.project), bold(&ws.branch), blue(ws.port)]
}

fn header(no_pr: bool) -> Row<()> {
    let pr: &[&str] = if no_pr { &[] } else { &["PR"] };
    Row::new((), COLUMNS.iter().chain(pr).map(dim))
}

fn row(ws: &Workspace) -> Row<()> {
    Row::new((), cells(ws))
}

fn listed(project_opt: Option<String>) -> Result<Vec<Workspace>> {
    let workspaces = config::load_workspaces()?;
    let mut listed: Vec<Workspace> = match &project_opt {
        Some(p) => workspaces.into_iter().filter(|w| &w.project == p).collect(),
        None => workspaces,
    };
    listed.sort_by(Workspace::listing_order);
    Ok(listed)
}

/// Each workspace as stored, plus `pr` (`null` when the branch has none)
/// unless `--no-pr`. The PR lookup blocks: JSON has no late cells.
fn print_json(project_opt: Option<String>, no_pr: bool) -> Result<()> {
    let listed = listed(project_opt)?;
    let prs = if no_pr {
        Vec::new()
    } else {
        github::look_up_all(&listed)
    };
    let rows: Vec<serde_json::Value> = listed
        .iter()
        .enumerate()
        .map(|(i, ws)| {
            let mut value = serde_json::to_value(ws).unwrap_or_default();
            if let (false, Some(found)) = (no_pr, prs.get(i)) {
                value["pr"] = match &found.pr {
                    Some(pr) => serde_json::json!({
                        "state": pr.state,
                        "number": pr.number,
                        "mergedAt": pr.merged_at,
                    }),
                    None => serde_json::Value::Null,
                };
            }
            value
        })
        .collect();
    super::print_json(&rows)
}

fn run_inner(project_opt: Option<String>, no_pr: bool) -> Result<()> {
    let listed = listed(project_opt)?;

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
