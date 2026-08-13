use crate::errors::Result;
use crate::schema::ProjectConfig;
use crate::services::database::{self, DbTarget};
use crate::services::git;
use crate::services::shell::{self, NON_INTERACTIVE_ENV};

// Fast-forwards the project's base checkout, then (only when HEAD moved) runs
// the install scope and — when the database is reachable (ping) — the db scope.

pub struct SyncResult {
    pub pulled: bool,
    pub head_moved: bool,
    pub installed: bool,
    pub migrated: bool,
    pub skipped_pull: Option<String>,
}

fn skipped(reason: String) -> SyncResult {
    SyncResult {
        pulled: false,
        head_moved: false,
        installed: false,
        migrated: false,
        skipped_pull: Some(reason),
    }
}

pub fn sync(pc: &ProjectConfig, base: Option<&str>) -> Result<SyncResult> {
    let repo = &pc.path;

    git::fetch(repo)?;

    // Custom base: fast-forward that branch ref directly (no checkout).
    if let Some(base_branch) = base {
        let before = git::rev_parse(repo, base_branch).unwrap_or_default();
        if git::update_branch(repo, base_branch).is_err() {
            return Ok(skipped(format!("could not fast-forward {base_branch}")));
        }
        let after = git::rev_parse(repo, base_branch).unwrap_or_default();
        return Ok(SyncResult {
            pulled: true,
            head_moved: before != after,
            installed: false,
            migrated: false,
            skipped_pull: None,
        });
    }

    // Default: fast-forward main (skip if dirty or non-ff).
    if git::is_dirty(repo)? {
        return Ok(skipped("working tree has uncommitted changes".to_string()));
    }

    let before = git::rev_parse_head(repo)?;
    if git::pull_ff_only(repo).is_err() {
        return Ok(skipped(
            "cannot fast-forward (main has diverged)".to_string(),
        ));
    }
    let after = git::rev_parse_head(repo)?;
    let head_moved = before != after;

    let mut installed = false;
    let mut migrated = false;

    if head_moved {
        if !pc.commands.install.is_empty() {
            for cmd in &pc.commands.install {
                shell::exec_in_dir(repo, cmd, NON_INTERACTIVE_ENV)?;
            }
            installed = true;
        }
        if !pc.commands.db.is_empty() && database::ping(DbTarget::from(&pc.database)) {
            for cmd in &pc.commands.db {
                shell::exec_in_dir(repo, cmd, NON_INTERACTIVE_ENV)?;
            }
            migrated = true;
        }
    }

    Ok(SyncResult {
        pulled: true,
        head_moved,
        installed,
        migrated,
        skipped_pull: None,
    })
}
