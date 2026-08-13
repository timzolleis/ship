use crate::errors::{Error, Result};
use std::fs;
use std::path::{Component, Path};

// Copies configured local state (sqlite files, certs, fixtures) into a new
// worktree. The git checkout brings tracked files and `database::clone_db`
// brings postgres state; this covers the file-backed state neither carries.

pub struct CopyOutcome {
    pub path: String,
    pub status: CopyStatus,
}

pub enum CopyStatus {
    Copied {
        files: usize,
        bytes: u64,
    },
    /// Target already has it — a resumed `ship create` must never clobber a
    /// workspace's own state.
    SkippedExisting,
    MissingSource,
    /// Absolute, or climbs out of the project root.
    OutsideProject,
}

fn is_contained(path: &str) -> bool {
    let p = Path::new(path);
    !p.is_absolute() && !p.components().any(|c| c == Component::ParentDir)
}

pub fn copy_paths(
    source_dir: &str,
    target_dir: &str,
    paths: &[String],
) -> Result<Vec<CopyOutcome>> {
    let mut outcomes = Vec::new();

    for path in paths {
        let status = if !is_contained(path) {
            CopyStatus::OutsideProject
        } else {
            let source = Path::new(source_dir).join(path);
            let target = Path::new(target_dir).join(path);

            if !source.exists() {
                CopyStatus::MissingSource
            } else if target.exists() {
                CopyStatus::SkippedExisting
            } else {
                let (files, bytes) = copy_tree(&source, &target)?;
                CopyStatus::Copied { files, bytes }
            }
        };
        outcomes.push(CopyOutcome {
            path: path.clone(),
            status,
        });
    }

    Ok(outcomes)
}

/// Measure without copying — `ship init` shows sizes so a multi-GB directory is
/// obvious before it gets selected.
pub fn measure(root: &str, path: &str) -> (usize, u64) {
    let full = Path::new(root).join(path);
    let meta = match fs::metadata(&full) {
        Ok(m) => m,
        Err(_) => return (0, 0),
    };
    if meta.is_file() {
        return (1, meta.len());
    }
    let mut files = 0;
    let mut bytes = 0;
    let Ok(entries) = fs::read_dir(&full) else {
        return (0, 0);
    };
    for entry in entries.flatten() {
        let rel = entry.file_name();
        let (f, b) = measure(&full.display().to_string(), &rel.to_string_lossy());
        files += f;
        bytes += b;
    }
    (files, bytes)
}

pub fn human_size(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["B", "KB", "MB", "GB"];
    let mut size = bytes as f64;
    let mut unit = 0;
    while size >= 1024.0 && unit < UNITS.len() - 1 {
        size /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{size:.1} {}", UNITS[unit])
    }
}

fn copy_tree(source: &Path, target: &Path) -> Result<(usize, u64)> {
    let meta = fs::metadata(source).map_err(|e| Error::ReadFile {
        path: source.display().to_string(),
        detail: e.to_string(),
    })?;

    if meta.is_file() {
        if let Some(parent) = target.parent() {
            create_dir(parent)?;
        }
        fs::copy(source, target).map_err(|e| Error::WriteFile {
            path: target.display().to_string(),
            detail: e.to_string(),
        })?;
        return Ok((1, meta.len()));
    }

    create_dir(target)?;
    let entries = fs::read_dir(source).map_err(|e| Error::ReadFile {
        path: source.display().to_string(),
        detail: e.to_string(),
    })?;

    let mut files = 0;
    let mut bytes = 0;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let (f, b) = copy_tree(&source.join(&name), &target.join(&name))?;
        files += f;
        bytes += b;
    }
    Ok((files, bytes))
}

fn create_dir(path: &Path) -> Result<()> {
    fs::create_dir_all(path).map_err(|e| Error::CreateDirectory {
        path: path.display().to_string(),
        detail: e.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> String {
        let dir = std::env::temp_dir().join(format!("ship-copy-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir.display().to_string()
    }

    fn write(root: &str, rel: &str, body: &str) {
        let p = Path::new(root).join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, body).unwrap();
    }

    // A sqlite db and its -wal sibling must land together.
    #[test]
    fn copies_directories_recursively() {
        let src = tmp("src-dir");
        let dst = tmp("dst-dir");
        write(&src, "development/sqlite-data/database.db", "main");
        write(&src, "development/sqlite-data/database.db-wal", "wal");

        let out = copy_paths(&src, &dst, &["development/sqlite-data".to_string()]).unwrap();

        assert!(matches!(out[0].status, CopyStatus::Copied { files: 2, .. }));
        let landed = Path::new(&dst).join("development/sqlite-data/database.db-wal");
        assert_eq!(fs::read_to_string(landed).unwrap(), "wal");
    }

    // Resuming a create must never overwrite a workspace's own state.
    #[test]
    fn existing_target_is_left_alone() {
        let src = tmp("src-skip");
        let dst = tmp("dst-skip");
        write(&src, "data/db.sqlite", "source");
        write(&dst, "data/db.sqlite", "workspace-local");

        let out = copy_paths(&src, &dst, &["data/db.sqlite".to_string()]).unwrap();

        assert!(matches!(out[0].status, CopyStatus::SkippedExisting));
        let target = Path::new(&dst).join("data/db.sqlite");
        assert_eq!(fs::read_to_string(target).unwrap(), "workspace-local");
    }

    #[test]
    fn missing_source_reports_without_failing() {
        let src = tmp("src-missing");
        let dst = tmp("dst-missing");
        let out = copy_paths(&src, &dst, &["certs/local.pem".to_string()]).unwrap();
        assert!(matches!(out[0].status, CopyStatus::MissingSource));
    }

    #[test]
    fn paths_escaping_the_project_are_refused() {
        let src = tmp("src-escape");
        let dst = tmp("dst-escape");
        for bad in ["../../.ssh", "/etc/passwd"] {
            let out = copy_paths(&src, &dst, &[bad.to_string()]).unwrap();
            assert!(matches!(out[0].status, CopyStatus::OutsideProject), "{bad}");
        }
        assert!(!Path::new(&dst).join(".ssh").exists());
    }
}
