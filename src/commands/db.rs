use crate::domain::workspace_locate::locate_workspace;
use crate::errors::{Error, Result};
use crate::fmt::bold;
use crate::services::config;
use crate::services::database::{self, DbTarget};
use crate::util::cwd_string;
use std::process::ExitCode;

// ---------------------------------------------------------------------------
// ship db exec <sql> — locate the current workspace (by cwd) and run SQL
// ---------------------------------------------------------------------------

#[derive(clap::Subcommand)]
pub enum DbCmd {
    /// Execute SQL against the current workspace database
    Exec {
        /// SQL (or a psql meta-command like \dt)
        sql: String,
    },
}

pub fn run_exec(sql: &str) -> ExitCode {
    super::finish(exec_inner(sql))
}

fn exec_inner(sql: &str) -> Result<()> {
    let workspaces = config::load_workspaces()?;
    let Some(workspace) = locate_workspace(&workspaces, &cwd_string(), None) else {
        return Err(Error::NotInWorkspace);
    };

    let project_config = config::get_project(&workspace.project)?;
    let (Some(db), Some(name)) = (&project_config.database, &workspace.db_name) else {
        return Err(Error::NoDatabase {
            alias: workspace.project.clone(),
        });
    };
    let output = database::query(DbTarget::from(db), name, sql)?;
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
