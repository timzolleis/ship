use crate::errors::{Error, Result};
use crate::schema::{DatabaseConfig, ExecutionRuntime};
use crate::services::runner;

// Engine-agnostic interface speaking postgres CLI tools through the runner;
// the runtime (local | docker) is carried per-call as target data.

#[derive(Clone, Copy)]
pub struct DbTarget<'a> {
    pub runtime: &'a ExecutionRuntime,
    pub user: &'a str,
}

impl<'a> From<&'a DatabaseConfig> for DbTarget<'a> {
    fn from(db: &'a DatabaseConfig) -> Self {
        DbTarget {
            runtime: &db.runtime,
            user: &db.user,
        }
    }
}

fn db_err(op: &str, database: &str, e: Error) -> Error {
    Error::Database {
        op: op.to_string(),
        database: database.to_string(),
        detail: e.to_string(),
    }
}

pub fn drop_db(t: DbTarget, db: &str) -> Result<()> {
    runner::run(t.runtime, "dropdb", &["--if-exists", "-U", t.user, db])
        .map(|_| ())
        .map_err(|e| db_err("drop", db, e))
}

pub fn clone_db(t: DbTarget, source: &str, db: &str) -> Result<()> {
    runner::run(t.runtime, "createdb", &["-U", t.user, db])
        .and_then(|_| {
            let script = format!("pg_dump -U {u} {source} | psql -U {u} {db}", u = t.user);
            runner::run_script(t.runtime, &script)
        })
        .map(|_| ())
        .map_err(|e| db_err("clone", db, e))
}

pub fn exists(t: DbTarget, db: &str) -> bool {
    runner::run(t.runtime, "psql", &["-U", t.user, "-lqt"])
        .map(|r| r.stdout.lines().any(|line| line.trim().starts_with(db)))
        .unwrap_or(false)
}

pub fn ping(t: DbTarget) -> bool {
    runner::run(t.runtime, "pg_isready", &["-q"]).is_ok()
}

pub fn query(t: DbTarget, db: &str, sql: &str) -> Result<String> {
    runner::run(t.runtime, "psql", &["-U", t.user, db, "-c", sql])
        .map(|r| r.stdout)
        .map_err(|e| db_err("query", db, e))
}

pub fn session(t: DbTarget, db: &str) -> Result<()> {
    runner::run_interactive(t.runtime, "psql", &["-U", t.user, db])
        .map_err(|e| db_err("session", db, e))
}
