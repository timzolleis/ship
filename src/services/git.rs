use crate::errors::Result;
use crate::services::shell::{self, ExecResult};

pub struct WorktreeEntry {
    pub path: String,
    pub branch: String,
}

fn run(repo: &str, args: &[&str]) -> Result<ExecResult> {
    let mut full: Vec<&str> = vec!["-C", repo];
    full.extend_from_slice(args);
    shell::exec("git", &full)
}

/// Reuses an existing local or remote branch when present; otherwise creates
/// the branch off `base` (default HEAD). Prunes stale worktree metadata first.
pub fn worktree_add(repo: &str, path: &str, branch: &str, base: Option<&str>) -> Result<()> {
    let _ = run(repo, &["worktree", "prune"]);
    let local_exists = !run(repo, &["branch", "--list", branch])?.stdout.trim().is_empty();
    if local_exists {
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
            &["worktree", "add", "-b", branch, path, base.unwrap_or("HEAD")],
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

pub fn worktree_remove(repo: &str, path: &str, force: bool) -> Result<()> {
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(path);
    run(repo, &args).map(|_| ())
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

pub fn delete_branch(repo: &str, branch: &str) -> Result<()> {
    run(repo, &["branch", "-D", branch]).map(|_| ())
}

pub fn delete_remote_branch(repo: &str, branch: &str) -> Result<()> {
    run(repo, &["push", "origin", "--delete", branch]).map(|_| ())
}

pub fn fetch(repo: &str) -> Result<()> {
    run(repo, &["fetch", "origin"]).map(|_| ())
}

pub fn pull_ff_only(repo: &str) -> Result<()> {
    run(repo, &["pull", "--ff-only"]).map(|_| ())
}

pub fn is_dirty(repo: &str) -> Result<bool> {
    Ok(!run(repo, &["status", "--porcelain"])?.stdout.trim().is_empty())
}

pub fn rev_parse_head(repo: &str) -> Result<String> {
    Ok(run(repo, &["rev-parse", "HEAD"])?.stdout.trim().to_string())
}

pub fn rev_parse(repo: &str, reference: &str) -> Result<String> {
    Ok(run(repo, &["rev-parse", reference])?.stdout.trim().to_string())
}

/// Fast-forward a local branch ref to match origin (works for
/// non-checked-out branches).
pub fn update_branch(repo: &str, branch: &str) -> Result<()> {
    let refspec = format!("{branch}:{branch}");
    run(repo, &["fetch", "origin", &refspec]).map(|_| ())
}
