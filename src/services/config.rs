use crate::errors::{Error, Result};
use crate::schema::{ProjectConfig, ShipConfig, Workspace};
use serde::Serialize;
use std::fs;
use std::io::Write;
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};

pub fn home_dir() -> String {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| "~".to_string())
}

pub fn config_dir() -> PathBuf {
    Path::new(&home_dir()).join(".config").join("ship")
}

pub fn config_path() -> PathBuf {
    config_dir().join("config.json")
}

/// Raw config text, for reporting on-disk line numbers. Reading the file (not
/// re-serializing) keeps the numbers true after a hand edit.
pub fn read_config_raw() -> Result<Option<String>> {
    read_raw(&config_path())
}

fn workspaces_path() -> PathBuf {
    config_dir().join("workspaces.json")
}

fn read_raw(path: &Path) -> Result<Option<String>> {
    if !path.exists() {
        return Ok(None);
    }
    fs::read_to_string(path)
        .map(Some)
        .map_err(|e| Error::ReadFile {
            path: path.display().to_string(),
            detail: e.to_string(),
        })
}

/// Writes `content` so a reader (or a crash) never sees half a file: a temp
/// file in the same directory, synced, then renamed over `path`. A plain
/// `fs::write` truncates first, and two writers of different lengths left
/// trailing bytes of the longer document.
pub fn write_atomic(path: &Path, content: &str) -> Result<()> {
    let fail = |e: std::io::Error| Error::WriteFile {
        path: path.display().to_string(),
        detail: e.to_string(),
    };
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| Error::CreateDirectory {
            path: dir.display().to_string(),
            detail: e.to_string(),
        })?;
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(format!(".tmp-{}", std::process::id()));
    let tmp = PathBuf::from(tmp);
    let written = fs::File::create(&tmp).and_then(|mut f| {
        f.write_all(content.as_bytes())?;
        f.sync_all()
    });
    written
        .and_then(|()| fs::rename(&tmp, path))
        .inspect_err(|_| {
            let _ = fs::remove_file(&tmp);
        })
        .map_err(fail)
}

fn write_json<T: Serialize>(path: &Path, data: &T) -> Result<()> {
    let json = serde_json::to_string_pretty(data).map_err(|e| Error::EncodeConfig {
        detail: e.to_string(),
    })?;
    write_atomic(path, &(json + "\n"))
}

/// Exclusive lock on `<dir>/.lock`, released when dropped (or the process
/// dies). One lock covers `config.json` and `workspaces.json`: a writer holds
/// it from load to save, so concurrent `ship create`s queue instead of each
/// saving a registry that lacks the other's entry. Not reentrant: take it
/// once, in the function that does the load-modify-save.
struct Lock {
    _held: fs::File,
}

impl Lock {
    fn take(dir: &Path) -> Result<Lock> {
        let path = dir.join(".lock");
        let fail = |e: std::io::Error| Error::WriteFile {
            path: path.display().to_string(),
            detail: e.to_string(),
        };
        fs::create_dir_all(dir).map_err(fail)?;
        let file = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&path)
            .map_err(fail)?;
        // SAFETY: the fd is open for the life of `file`.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } != 0 {
            return Err(fail(std::io::Error::last_os_error()));
        }
        Ok(Lock { _held: file })
    }
}

/// Load the ship config. A parse failure means the stored file predates the
/// current schema — surface a friendly "re-run ship init" hint rather than
/// raw serde noise.
pub fn load_config() -> Result<ShipConfig> {
    let Some(raw) = read_raw(&config_path())? else {
        return Ok(ShipConfig::default());
    };
    serde_json::from_str(&raw).map_err(|e| Error::ConfigOutdated {
        detail: e.to_string(),
    })
}

pub fn delete_config() -> Result<()> {
    let path = config_path();
    if !path.exists() {
        return Ok(());
    }
    fs::remove_file(&path).map_err(|e| Error::WriteFile {
        path: path.display().to_string(),
        detail: e.to_string(),
    })
}

pub fn save_config(config: &ShipConfig) -> Result<()> {
    write_json(&config_path(), config)
}

pub fn get_project(alias: &str) -> Result<ProjectConfig> {
    load_config()?
        .projects
        .get(alias)
        .cloned()
        .ok_or_else(|| Error::ProjectNotFound {
            alias: alias.to_string(),
        })
}

/// Load, change, save `config.json` under the lock.
pub fn update_config(change: impl FnOnce(&mut ShipConfig)) -> Result<()> {
    let _lock = Lock::take(&config_dir())?;
    let mut config = load_config()?;
    change(&mut config);
    save_config(&config)
}

pub fn add_project(alias: &str, project: ProjectConfig) -> Result<()> {
    update_config(|c| {
        c.projects.insert(alias.to_string(), project);
    })
}

fn load_workspaces_at(path: &Path) -> Result<Vec<Workspace>> {
    let Some(raw) = read_raw(path)? else {
        return Ok(vec![]);
    };
    serde_json::from_str(&raw).map_err(|e| Error::ParseConfig {
        file: path.display().to_string(),
        detail: e.to_string(),
    })
}

pub fn load_workspaces() -> Result<Vec<Workspace>> {
    load_workspaces_at(&workspaces_path())
}

/// Load, change, save the registry under the lock.
fn update_registry(dir: &Path, change: impl FnOnce(&mut Vec<Workspace>)) -> Result<()> {
    let _lock = Lock::take(dir)?;
    let path = dir.join("workspaces.json");
    let mut all = load_workspaces_at(&path)?;
    change(&mut all);
    write_json(&path, &all)
}

pub fn add_workspace(ws: Workspace) -> Result<()> {
    add_workspace_in(&config_dir(), ws)
}

fn add_workspace_in(dir: &Path, ws: Workspace) -> Result<()> {
    update_registry(dir, |all| {
        all.retain(|w| !(w.project == ws.project && w.branch == ws.branch));
        all.push(ws);
    })
}

/// Replaces a registered workspace in place, keeping the registry's order.
pub fn update_workspace(ws: &Workspace) -> Result<()> {
    update_registry(&config_dir(), |all| {
        for w in all.iter_mut() {
            if w.project == ws.project && w.branch == ws.branch {
                *w = ws.clone();
            }
        }
    })
}

pub fn remove_workspace(project: &str, branch: &str) -> Result<()> {
    update_registry(&config_dir(), |all| {
        all.retain(|w| !(w.project == project && w.branch == branch));
    })
}

pub fn find_workspace(project: &str, branch: &str) -> Result<Option<Workspace>> {
    Ok(load_workspaces()?
        .into_iter()
        .find(|w| w.project == project && w.branch == branch))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ws(branch: String) -> Workspace {
        Workspace {
            project: "app".into(),
            branch,
            path: "/tmp/x".into(),
            port: 0,
            ports: Default::default(),
            db_name: None,
            proxy_domain: String::new(),
            created: String::new(),
            bare: false,
        }
    }

    #[test]
    fn concurrent_adds_all_survive() {
        let dir = std::env::temp_dir().join(format!("ship-lock-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        const N: usize = 24;
        std::thread::scope(|s| {
            for i in 0..N {
                let dir = &dir;
                s.spawn(move || add_workspace_in(dir, ws(format!("branch-{i}"))).unwrap());
            }
        });
        let all = load_workspaces_at(&dir.join("workspaces.json")).unwrap();
        assert_eq!(all.len(), N);
        let leftovers = fs::read_dir(&dir)
            .unwrap()
            .filter(|e| {
                e.as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .contains(".tmp-")
            })
            .count();
        assert_eq!(leftovers, 0);
        let _ = fs::remove_dir_all(&dir);
    }
}
