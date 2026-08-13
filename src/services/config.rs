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
    fs::read_to_string(path)
        .map(Some)
        .map_err(|e| Error::ReadFile {
            path: path.display().to_string(),
            detail: e.to_string(),
        })
}

fn write_json<T: Serialize>(path: &Path, data: &T) -> Result<()> {
    ensure_dir()?;
    let json = serde_json::to_string_pretty(data).map_err(|e| Error::EncodeConfig {
        detail: e.to_string(),
    })?;
    fs::write(path, json + "\n").map_err(|e| Error::WriteFile {
        path: path.display().to_string(),
        detail: e.to_string(),
    })
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
