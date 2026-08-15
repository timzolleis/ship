use crate::domain::session_slug;
use crate::services::config;
use std::fs;
use std::path::{Path, PathBuf};

// Coding agents keep their transcripts outside the worktree, so removing a
// workspace leaves them orphaned. Every harness uses the same layout — one
// directory per project path under a fixed root — which is all this needs.

/// Root directories to sweep, relative to $HOME, with the harness that owns
/// each. `.Claude Code` is Pi running under the Claude Code brand.
const STORES: [(&str, &str); 3] = [
    (".claude/projects", "Claude Code"),
    (".pi/agent/sessions", "Pi"),
    (".Claude Code/agent/sessions", "Claude Code"),
];

/// One project's transcript directory inside one harness's store.
#[derive(Debug, Clone)]
pub struct SessionDir {
    pub harness: &'static str,
    pub name: String,
    pub path: PathBuf,
}

/// Session cleanup during teardown. On unless the config turns it off — an
/// unreadable config must not silently start keeping transcripts around.
pub fn cleanup_enabled() -> bool {
    config::load_config()
        .map(|c| c.delete_agent_sessions.unwrap_or(true))
        .unwrap_or(true)
}

/// Every session directory across every installed harness.
pub fn list() -> Vec<SessionDir> {
    let home = config::home_dir();
    let mut found = Vec::new();

    for (relative, harness) in STORES {
        let root = Path::new(&home).join(relative);
        let Ok(entries) = fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            if !entry.path().is_dir() {
                continue;
            }
            found.push(SessionDir {
                harness,
                name: entry.file_name().to_string_lossy().into_owned(),
                path: entry.path(),
            });
        }
    }
    found
}

/// Remove every harness's transcripts for one absolute path. Returns how many
/// directories went away; errors are swallowed (best-effort cleanup).
pub fn remove_sessions_for(abs_path: &str) -> usize {
    list()
        .iter()
        .filter(|d| session_slug::refers_to(&d.name, abs_path))
        .filter(|d| remove(d))
        .count()
}

pub fn remove(dir: &SessionDir) -> bool {
    fs::remove_dir_all(&dir.path).is_ok()
}

/// A worktree directory pattern with the branch cut off — `dirPattern` up to
/// its first placeholder, resolved against the project root. Splitting it into
/// parent + stem lets `resolve` decide for itself whether the boundary between
/// them was a `/` or a literal `-`.
pub struct WorktreePrefix {
    parent: String,
    stem: String,
}

impl WorktreePrefix {
    /// `/Users/tim/code/app-` → parent `/Users/tim/code`, stem `app-`.
    pub fn new(prefix: &str) -> Self {
        match prefix.rsplit_once('/') {
            Some((parent, stem)) => WorktreePrefix {
                parent: parent.to_string(),
                stem: stem.to_string(),
            },
            None => WorktreePrefix {
                parent: String::new(),
                stem: prefix.to_string(),
            },
        }
    }

    fn full(&self) -> String {
        format!("{}/{}", self.parent, self.stem)
    }
}

/// Session directories under one of the given worktree prefixes whose path is
/// gone from disk. A session whose directory still exists is never an orphan,
/// and one outside every prefix is never even considered — this must not touch
/// transcripts for repositories ship knows nothing about.
pub fn orphans(prefixes: &[WorktreePrefix]) -> Vec<SessionDir> {
    let exists = |p: &str| Path::new(p).exists();
    list()
        .into_iter()
        .filter(|dir| {
            prefixes.iter().any(|prefix| {
                match session_slug::remainder(&dir.name, &prefix.full()) {
                    Some(tail) => {
                        let tail = format!("{}{}", prefix.stem, tail);
                        session_slug::resolve(&prefix.parent, &tail, &exists).is_none()
                    }
                    None => false,
                }
            })
        })
        .collect()
}
