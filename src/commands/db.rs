use crate::domain::workspace_locate::locate_workspace;
use crate::errors::Result;
use crate::fmt::{bold, red};
use crate::services::config;
use crate::services::database::{self, DbTarget};
use crate::util::cwd_string;

// ---------------------------------------------------------------------------
// ship db exec <sql> — locate the current workspace (by cwd) and run SQL
// ---------------------------------------------------------------------------

#[derive(clap::Subcommand)]
pub enum DbCmd {
    /// Execute SQL against the current workspace database
    Exec { sql: String },
}

pub fn run_exec(sql: &str) {
    if let Err(e) = exec_inner(sql) {
        eprintln!("\n  {} {}\n", red("Error:"), e);
    }
}

fn exec_inner(sql: &str) -> Result<()> {
    let workspaces = config::load_workspaces()?;
    let Some(workspace) = locate_workspace(&workspaces, &cwd_string(), None) else {
        eprintln!(
            "  {} Not inside a workspace. Navigate to a workspace directory first.",
            red("✗")
        );
        return Ok(());
    };

    let project_config = config::get_project(&workspace.project)?;
    let output = database::query(
        DbTarget::from(&project_config.database),
        &workspace.db_name,
        sql,
    )?;
    println!("{}", output.trim_end());
    Ok(())
}

pub fn print_help() {
    println!(
        "
  {} — database utilities

  {}
    ship db exec <sql>    Execute SQL against the current workspace database

  {}
    ship db exec \"SELECT * FROM users LIMIT 5\"
    ship db exec \"DROP TABLE sessions\"
    ship db exec \"\\dt\"
",
        bold("ship db"),
        bold("Usage"),
        bold("Examples")
    );
}
