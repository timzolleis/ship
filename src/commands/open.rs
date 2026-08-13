use crate::domain::workspace_locate::locate_workspace;
use crate::errors::{Error, Result};
use crate::fmt::{bold, red};
use crate::prompt;
use crate::schema::Workspace;
use crate::services::database::{self, DbTarget};
use crate::services::{config, editor, shell};
use crate::util::cwd_string;

// ---------------------------------------------------------------------------
// ship open [branch-or-target] [target]
// ---------------------------------------------------------------------------

const TARGETS: &[&str] = &["editor", "url", "db"];

/// Split the two positional args into a branch query and a target. The first
/// arg is a target keyword when it is one of TARGETS; otherwise it is a branch
/// query and the second arg (if any) is the target. Defaults to "editor".
fn split_args(first: Option<&str>, second: Option<&str>) -> (Option<String>, String) {
    match first {
        Some(f) if TARGETS.contains(&f) => (None, f.to_string()),
        Some(f) => (Some(f.to_string()), second.unwrap_or("editor").to_string()),
        None => (None, "editor".to_string()),
    }
}

/// Domain locate (cwd / branch) with interactive picker fallback. The picker
/// only fires when no branch query was given and cwd did not match — a branch
/// query that matches nothing is an error.
fn resolve_workspace(
    branch_arg: Option<&str>,
    workspaces: &[Workspace],
    cwd: &str,
) -> Result<Workspace> {
    if let Some(w) = locate_workspace(workspaces, cwd, branch_arg) {
        return Ok(w.clone());
    }
    if let Some(branch) = branch_arg {
        return Err(Error::WorkspaceNotFound {
            branch: branch.to_string(),
        });
    }
    if workspaces.is_empty() {
        return Err(Error::NoActiveWorkspaces);
    }
    let items: Vec<String> = workspaces
        .iter()
        .map(|w| {
            format!(
                "{}  {}  {}",
                w.project,
                w.branch,
                crate::fmt::dim(&w.proxy_domain)
            )
        })
        .collect();
    let idx = prompt::select("Select a workspace", &items)?;
    Ok(workspaces[idx].clone())
}

pub fn run(first: Option<String>, second: Option<String>) {
    if let Err(e) = run_inner(first, second) {
        eprintln!("\n  {} {}\n", red("Error:"), e);
    }
}

fn run_inner(first: Option<String>, second: Option<String>) -> Result<()> {
    let workspaces = config::load_workspaces()?;
    let (branch_arg, target) = split_args(first.as_deref(), second.as_deref());
    let workspace = resolve_workspace(branch_arg.as_deref(), &workspaces, &cwd_string())?;
    let project_config = config::get_project(&workspace.project)?;

    match target.as_str() {
        "editor" => {
            println!("  Opening {}...", bold(&workspace.branch));
            editor::open(&workspace.path);
        }
        "url" => {
            let url = format!("https://{}", workspace.proxy_domain);
            println!("  Opening {}...", bold(&url));
            shell::exec("open", &[&url])?;
        }
        "db" => {
            println!("  Connecting to {}...", bold(&workspace.db_name));
            database::session(DbTarget::from(&project_config.database), &workspace.db_name)?;
        }
        other => {
            println!(
                "  {} Unknown target '{}'. Use: editor, url, db",
                red("✗"),
                other
            );
        }
    }
    Ok(())
}
