use crate::domain::removal::Removal;
use crate::errors::Result;
use crate::services::shell::{self, ExecResult};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, MutexGuard, OnceLock};

pub struct WorktreeEntry {
    pub path: String,
    pub branch: String,
}

fn run(repo: &str, args: &[&str]) -> Result<ExecResult> {
    let mut full: Vec<&str> = vec!["-C", repo];
    full.extend_from_slice(args);
    shell::exec("git", &full)
}

/// One lock per repo, held while a command rewrites refs or worktree metadata.
/// Tearing several workspaces down at once runs their git commands from
/// different threads, and two ref updates in one repo race for
/// `packed-refs.lock` — the loser fails with "File exists". Repos are
/// independent, so different projects still run in parallel.
fn repo_lock(repo: &str) -> MutexGuard<'static, ()> {
    static LOCKS: OnceLock<Mutex<HashMap<String, &'static Mutex<()>>>> = OnceLock::new();
    let locks = LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    // One leaked mutex per repo touched, so a guard can outlive the map lock.
    // Bounded by the number of projects in one CLI run.
    let lock = {
        let mut map = locks.lock().unwrap_or_else(|e| e.into_inner());
        *map.entry(repo.to_string())
            .or_insert_with(|| Box::leak(Box::new(Mutex::new(()))))
    };
    lock.lock().unwrap_or_else(|e| e.into_inner())
}

fn branch_exists(repo: &str, branch: &str) -> Result<bool> {
    Ok(!run(repo, &["branch", "--list", branch])?
        .stdout
        .trim()
        .is_empty())
}

/// Asks the remote, not the local remote-tracking refs: those go stale as soon
/// as someone else deletes the branch.
fn remote_branch_exists(repo: &str, branch: &str) -> Result<bool> {
    let refspec = format!("refs/heads/{branch}");
    Ok(!run(repo, &["ls-remote", "--heads", "origin", &refspec])?
        .stdout
        .trim()
        .is_empty())
}

/// Reuses an existing local or remote branch when present; otherwise creates
/// the branch off `base` (default HEAD). Prunes stale worktree metadata first.
///
/// `--no-track`: `base` is usually `origin/main`, and a new branch tracking it
/// would make a plain `git push` target main.
pub fn worktree_add(repo: &str, path: &str, branch: &str, base: Option<&str>) -> Result<()> {
    let _ = run(repo, &["worktree", "prune"]);
    let _guard = repo_lock(repo);
    if branch_exists(repo, branch)? {
        run(repo, &["worktree", "add", path, branch])?;
        return Ok(());
    }
    let pattern = format!("*/{branch}");
    let remote_exists = !run(repo, &["branch", "--list", "-r", &pattern])?
        .stdout
        .trim()
        .is_empty();
    if remote_exists {
        run(repo, &["worktree", "add", path, branch])?;
    } else {
        run(
            repo,
            &[
                "worktree",
                "add",
                "--no-track",
                "-b",
                branch,
                path,
                base.unwrap_or("HEAD"),
            ],
        )?;
    }
    Ok(())
}

/// Subset of `paths` that git ignores. One call — `check-ignore` prints the
/// ignored ones and exits nonzero when there are none, so an Err (including
/// "not a git repo") means nothing is ignored.
pub fn ignored_paths(repo: &str, paths: &[String]) -> Vec<String> {
    let mut args = vec!["check-ignore"];
    args.extend(paths.iter().map(|p| p.as_str()));
    match run(repo, &args) {
        Ok(r) => r
            .stdout
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect(),
        Err(_) => Vec::new(),
    }
}

/// A worktree dir that is already gone still leaves metadata in the repo, so
/// prune before reporting it removed — otherwise `git worktree list` keeps it
/// and the next `worktree add` for that branch refuses.
pub fn worktree_remove(repo: &str, path: &str, force: bool) -> Result<Removal> {
    let _guard = repo_lock(repo);
    if !Path::new(path).exists() {
        let _ = run(repo, &["worktree", "prune"]);
        return Ok(Removal::AlreadyGone);
    }
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(path);
    run(repo, &args).map(|_| Removal::Removed)
}

pub fn worktree_list(repo: &str) -> Result<Vec<WorktreeEntry>> {
    let r = run(repo, &["worktree", "list", "--porcelain"])?;
    let mut entries = Vec::new();
    let mut current_path = String::new();
    for line in r.stdout.split('\n') {
        if let Some(rest) = line.strip_prefix("worktree ") {
            current_path = rest.to_string();
        }
        if let Some(branch) = line.strip_prefix("branch refs/heads/") {
            entries.push(WorktreeEntry {
                path: current_path.clone(),
                branch: branch.to_string(),
            });
        }
    }
    Ok(entries)
}

pub fn delete_branch(repo: &str, branch: &str) -> Result<Removal> {
    let _guard = repo_lock(repo);
    if !branch_exists(repo, branch)? {
        return Ok(Removal::AlreadyGone);
    }
    run(repo, &["branch", "-D", branch]).map(|_| Removal::Removed)
}

/// Pushes first and only asks the remote what exists when the push fails: the
/// common case pays one round trip, and a branch someone already deleted (or a
/// GitHub merge queue did) reads as gone instead of failing teardown.
pub fn delete_remote_branch(repo: &str, branch: &str) -> Result<Removal> {
    let _guard = repo_lock(repo);
    match run(repo, &["push", "origin", "--delete", branch]) {
        Ok(_) => Ok(Removal::Removed),
        Err(push_failed) => match remote_branch_exists(repo, branch) {
            Ok(false) => Ok(Removal::AlreadyGone),
            // Still there, or the remote is unreachable: the push failure is
            // the more useful of the two errors.
            _ => Err(push_failed),
        },
    }
}

pub fn fetch(repo: &str) -> Result<()> {
    run(repo, &["fetch", "origin"]).map(|_| ())
}

pub fn pull_ff_only(repo: &str) -> Result<()> {
    run(repo, &["pull", "--ff-only"]).map(|_| ())
}

pub fn is_dirty(repo: &str) -> Result<bool> {
    Ok(!run(repo, &["status", "--porcelain"])?
        .stdout
        .trim()
        .is_empty())
}

pub fn rev_parse_head(repo: &str) -> Result<String> {
    Ok(run(repo, &["rev-parse", "HEAD"])?.stdout.trim().to_string())
}

pub fn rev_parse(repo: &str, reference: &str) -> Result<String> {
    Ok(run(repo, &["rev-parse", reference])?
        .stdout
        .trim()
        .to_string())
}

/// The ref a new branch starts from, read after a fetch so it is current
/// without touching any checkout: `origin/<base>` when the remote has it, else
/// the local `base`; with no base, the main checkout's upstream (`origin/main`),
/// else its HEAD.
pub fn resolve_base(repo: &str, base: Option<&str>) -> String {
    match base {
        Some(b) => {
            let remote = format!("origin/{b}");
            let full = format!("refs/remotes/{remote}");
            if run(repo, &["rev-parse", "--verify", "--quiet", &full]).is_ok() {
                remote
            } else {
                b.to_string()
            }
        }
        None => run(
            repo,
            &[
                "rev-parse",
                "--abbrev-ref",
                "--symbolic-full-name",
                "HEAD@{upstream}",
            ],
        )
        .map(|r| r.stdout.trim().to_string())
        .ok()
        .filter(|r| !r.is_empty())
        .unwrap_or_else(|| "HEAD".to_string()),
    }
}

/// Fast-forward a local branch ref to match origin (works for
/// non-checked-out branches).
pub fn update_branch(repo: &str, branch: &str) -> Result<()> {
    let refspec = format!("{branch}:{branch}");
    run(repo, &["fetch", "origin", &refspec]).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// A repo with a bare `origin` beside it and one commit on `main`.
    fn repo(name: &str) -> String {
        let root = std::env::temp_dir().join(format!("ship-git-{name}"));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let origin = root.join("origin.git");
        let work = root.join("work");
        let origin_s = origin.display().to_string();
        let work_s = work.display().to_string();
        shell::exec("git", &["init", "--bare", "-b", "main", &origin_s]).unwrap();
        shell::exec("git", &["init", "-b", "main", &work_s]).unwrap();
        for args in [
            vec!["config", "user.email", "t@example.com"],
            vec!["config", "user.name", "t"],
            vec!["remote", "add", "origin", &origin_s],
        ] {
            run(&work_s, &args).unwrap();
        }
        fs::write(work.join("README"), "hi").unwrap();
        run(&work_s, &["add", "."]).unwrap();
        run(&work_s, &["commit", "-m", "init"]).unwrap();
        run(&work_s, &["push", "-u", "origin", "main"]).unwrap();
        work_s
    }

    // The bug: a second teardown of the same workspace hit "remote ref does not
    // exist" and failed, so the registry entry never cleared.
    #[test]
    fn deleting_a_remote_branch_twice_reports_gone_not_failure() {
        let work = repo("remote-twice");
        run(&work, &["branch", "feat"]).unwrap();
        run(&work, &["push", "origin", "feat"]).unwrap();

        assert_eq!(
            delete_remote_branch(&work, "feat").unwrap(),
            Removal::Removed
        );
        assert_eq!(
            delete_remote_branch(&work, "feat").unwrap(),
            Removal::AlreadyGone
        );
    }

    #[test]
    fn a_missing_local_branch_is_already_gone() {
        let work = repo("local-missing");
        assert_eq!(
            delete_branch(&work, "never-existed").unwrap(),
            Removal::AlreadyGone
        );
        run(&work, &["branch", "feat"]).unwrap();
        assert_eq!(delete_branch(&work, "feat").unwrap(), Removal::Removed);
    }

    // The bug this guards: branching from a stale local main. A new branch must
    // start at the fetched origin/main and must not track it.
    #[test]
    fn a_new_branch_starts_at_the_upstream_without_tracking_it() {
        let work = repo("base-upstream");
        run(&work, &["commit", "--allow-empty", "-m", "remote only"]).unwrap();
        run(&work, &["push", "origin", "main"]).unwrap();
        run(&work, &["reset", "--hard", "HEAD~1"]).unwrap();

        let base = resolve_base(&work, None);
        assert_eq!(base, "origin/main");

        let tree = format!("{work}-feat");
        worktree_add(&work, &tree, "feat", Some(&base)).unwrap();
        assert_eq!(
            rev_parse(&work, "feat").unwrap(),
            rev_parse(&work, "origin/main").unwrap()
        );
        assert!(run(&work, &["rev-parse", "feat@{upstream}"]).is_err());
    }

    #[test]
    fn a_base_missing_on_the_remote_stays_local() {
        let work = repo("base-local");
        run(&work, &["branch", "local-only"]).unwrap();
        assert_eq!(resolve_base(&work, Some("local-only")), "local-only");
        assert_eq!(resolve_base(&work, Some("main")), "origin/main");
    }

    #[test]
    fn a_worktree_dir_that_vanished_is_already_gone_and_pruned() {
        let work = repo("worktree-vanished");
        let tree = format!("{work}-feat");
        worktree_add(&work, &tree, "feat", None).unwrap();
        fs::remove_dir_all(&tree).unwrap();

        assert_eq!(
            worktree_remove(&work, &tree, false).unwrap(),
            Removal::AlreadyGone
        );
        assert!(worktree_list(&work)
            .unwrap()
            .iter()
            .all(|e| e.branch != "feat"));
    }
}
