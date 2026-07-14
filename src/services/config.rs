use crate::errors::{Error, Result};
use crate::schema::{ProjectConfig, ShipConfig, Workspace};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

pub fn home_dir() -> String {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| "~".to_string())
}

pub fn config_dir() -> PathBuf {
    Path::new(&home_dir()).join(".config").join("ship")
}

fn config_path() -> PathBuf {
    config_dir().join("config.json")
}

fn workspaces_path() -> PathBuf {
    config_dir().join("workspaces.json")
}

fn ensure_dir() -> Result<()> {
    let dir = config_dir();
    fs::create_dir_all(&dir).map_err(|e| Error::CreateDirectory {
        path: dir.display().to_string(),
        detail: e.to_string(),
    })
}

fn read_raw(path: &Path) -> Result<Option<String>> {
    ensure_dir()?;
    if !path.exists() {
        return Ok(None);
    }
    fs::read_to_string(path).map(Some).map_err(|e| Error::ReadFile {
        path: path.display().to_string(),
        detail: e.to_string(),
    })
}

fn write_json<T: Serialize>(path: &Path, data: &T) -> Result<()> {
    ensure_dir()?;
    let json =
        serde_json::to_string_pretty(data).map_err(|e| Error::EncodeConfig { detail: e.to_string() })?;
    fs::write(path, json + "\n").map_err(|e| Error::WriteFile {
        path: path.display().to_string(),
        detail: e.to_string(),
    })
}

// A stored config is "legacy" when any project's `database` carries a bare
// `container` string and no `runtime` key. The schema decode tolerates this,
// so we inspect the raw JSON to decide whether a canonical write-back is owed.
fn is_legacy_raw(raw: &str) -> bool {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) else {
        return false;
    };
    v.get("projects")
        .and_then(|p| p.as_object())
        .map(|projects| {
            projects.values().any(|p| {
                p.get("database")
                    .and_then(|d| d.as_object())
                    .map(|db| db.contains_key("container") && !db.contains_key("runtime"))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

/// Self-migrating load: if the stored raw was the legacy database shape,
/// re-encode canonical and write back best-effort. Load still succeeds even
/// if the write-back fails.
pub fn load_config() -> Result<ShipConfig> {
    let Some(raw) = read_raw(&config_path())? else {
        return Ok(ShipConfig::default());
    };
    let config: ShipConfig = serde_json::from_str(&raw).map_err(|e| Error::ParseConfig {
        file: config_path().display().to_string(),
        detail: e.to_string(),
    })?;
    if is_legacy_raw(&raw) {
        let _ = save_config(&config);
    }
    Ok(config)
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

pub fn add_project(alias: &str, project: ProjectConfig) -> Result<()> {
    let mut config = load_config()?;
    config.projects.insert(alias.to_string(), project);
    save_config(&config)
}

pub fn load_workspaces() -> Result<Vec<Workspace>> {
    let Some(raw) = read_raw(&workspaces_path())? else {
        return Ok(vec![]);
    };
    serde_json::from_str(&raw).map_err(|e| Error::ParseConfig {
        file: workspaces_path().display().to_string(),
        detail: e.to_string(),
    })
}

pub fn save_workspaces(workspaces: &[Workspace]) -> Result<()> {
    write_json(&workspaces_path(), &workspaces)
}

pub fn add_workspace(ws: Workspace) -> Result<()> {
    let mut all = load_workspaces()?;
    all.retain(|w| !(w.project == ws.project && w.branch == ws.branch));
    all.push(ws);
    save_workspaces(&all)
}

pub fn remove_workspace(project: &str, branch: &str) -> Result<()> {
    let mut all = load_workspaces()?;
    all.retain(|w| !(w.project == project && w.branch == branch));
    save_workspaces(&all)
}

pub fn find_workspace(project: &str, branch: &str) -> Result<Option<Workspace>> {
    Ok(load_workspaces()?
        .into_iter()
        .find(|w| w.project == project && w.branch == branch))
}
