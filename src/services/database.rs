use crate::errors::{Error, Result};
use crate::schema::{DatabaseConfig, ExecutionRuntime};
use crate::services::runner;
use std::sync::mpsc;

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

/// Every database on the server, one name per line.
///
/// Queried instead of `psql -l` because `-l` prints the ACL column, and
/// template0/template1 wrap theirs onto a second line — a line with no
/// database name on it at all.
pub fn list(t: DbTarget) -> Result<Vec<String>> {
    runner::run(
        t.runtime,
        "psql",
        &["-U", t.user, "-tAc", "SELECT datname FROM pg_database ORDER BY datname"],
    )
    .map(|r| {
        r.stdout
            .lines()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_string)
            .collect()
    })
    .map_err(|e| db_err("list", "*", e))
}

/// Exact match, not a prefix — `znb_foo` must not be reported as present
/// just because `znb_foo_bar` exists.
pub fn exists(t: DbTarget, db: &str) -> bool {
    list(t).is_ok_and(|dbs| dbs.iter().any(|name| name == db))
}

fn size(rt: &ExecutionRuntime, user: &str, db: &str) -> Option<String> {
    let sql = format!("SELECT pg_size_pretty(pg_database_size('{}'))", db.replace('\'', "''"));
    runner::run(rt, "psql", &["-U", user, "-tAc", &sql])
        .ok()
        .map(|r| r.stdout.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// One size query per database, all in flight at once, each result sent as it
/// lands. The index is the database's position in `dbs`. A failed query sends
/// nothing, so the caller's placeholder cell stays as it was.
pub fn size_stream(t: DbTarget, dbs: Vec<String>) -> mpsc::Receiver<(usize, String)> {
    let (tx, rx) = mpsc::channel();
    for (i, db) in dbs.into_iter().enumerate() {
        let (tx, rt, user) = (tx.clone(), t.runtime.clone(), t.user.to_string());
        std::thread::spawn(move || {
            if let Some(size) = size(&rt, &user, &db) {
                let _ = tx.send((i, size));
            }
        });
    }
    rx
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
