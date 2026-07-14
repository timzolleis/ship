use crate::services::config;
use std::fs;
use std::path::Path;

// Claude Code stores conversation transcripts under ~/.claude/projects/<slug>/
// where <slug> is the absolute path with `/` replaced by `-`. When a workspace
// is torn down the worktree dir is removed but the transcripts remain orphaned.

/// Remove the Claude Code conversation directory for the given absolute path.
/// Returns true if a directory was removed, false if none existed. Errors are
/// swallowed (best-effort cleanup).
pub fn remove_project_convo(abs_path: &str) -> bool {
    let slug = abs_path.replace('/', "-");
    let convo_dir = Path::new(&config::home_dir())
        .join(".claude")
        .join("projects")
        .join(slug);
    if !convo_dir.exists() {
        return false;
    }
    fs::remove_dir_all(&convo_dir).is_ok()
}
