use crate::domain::detect::{self, ContainerBinding, DatabaseFound, DatabaseUrl, Field, LeftEmpty};
use crate::schema::{CommandsConfig, EnvFileVars, EnvVarConfig, EnvVarType};
use crate::services::{git, shell};
use indexmap::IndexMap;
use std::fs;
use std::path::Path;

// Reads a repo for `ship init`: env files, lockfiles, package.json, migration
// tool markers, ignored local state, and docker's port bindings.
// `domain::detect` decides what the evidence means.

const EXCLUDED_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    ".cache",
    ".turbo",
];

// Local state a git checkout can't carry. Deliberately narrow: uploads/ and
// storage/ are plausible but easily multi-GB, and a silent huge copy on every
// `ship create` is worse than adding the path by hand once.
const STATE_EXTENSIONS: &[&str] = &["db", "sqlite", "sqlite3", "pem", "key", "crt"];

/// Current on-disk values, file → var → value. Display only.
pub type EnvValues = IndexMap<String, IndexMap<String, String>>;

pub struct Detected {
    /// .env path → the vars ship rewrites. A file with no such vars is listed
    /// (empty) when git ignores it, so `ship create` still copies it.
    pub env: IndexMap<String, EnvFileVars>,
    pub env_values: EnvValues,
    pub copy: Vec<String>,
    pub commands: CommandsConfig,
    pub database: Option<DatabaseFound>,
    pub left_empty: Vec<LeftEmpty>,
}

/// Everything init can tell about the repo at `root`. `db_container` is
/// `--db-container`, which settles where postgres runs.
pub fn scan(root: &Path, db_container: Option<&str>) -> Detected {
    let repo = root.display().to_string();
    let mut left_empty = Vec::new();

    // Env files.
    let mut files = Vec::new();
    walk(root, root, &mut files, &|name| detect::is_env_file(name));
    let ignored = git::ignored_paths(&repo, &files);

    let mut env = IndexMap::new();
    let mut env_values = IndexMap::new();
    let mut urls: Vec<DatabaseUrl> = Vec::new();
    for file in files {
        let Ok(content) = fs::read_to_string(root.join(&file)) else {
            continue;
        };
        let vars = detect::classify_env(&content);
        if vars.is_empty() && !ignored.contains(&file) {
            // Tracked and nothing to rewrite: the checkout already brings it.
            continue;
        }
        let mut config = EnvFileVars::new();
        let mut values = IndexMap::new();
        for (key, value, kind) in vars {
            if kind == EnvVarType::DatabaseUrl {
                urls.extend(detect::parse_database_url(&value));
            }
            config.insert(
                key.clone(),
                EnvVarConfig {
                    var_type: kind,
                    path: None,
                },
            );
            values.insert(key, value);
        }
        env.insert(file.clone(), config);
        env_values.insert(file, values);
    }

    // Command lists.
    let package_json = fs::read_to_string(root.join("package.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok());
    let present: Vec<&str> = detect::markers()
        .filter(|m| root.join(m).exists())
        .collect();
    let (commands, empty) = detect::commands(package_json.as_ref(), &present);
    left_empty.extend(empty);

    // Database. Docker is only asked when a URL needs a runtime.
    let bindings = if urls.is_empty() || db_container.is_some() {
        Some(Vec::new())
    } else {
        docker_bindings()
    };
    let database = match detect::database(&urls, bindings.as_deref(), db_container) {
        Ok(found) => Some(found),
        Err(reason) => {
            left_empty.push(LeftEmpty {
                field: Field::Database,
                reason,
            });
            None
        }
    };

    Detected {
        env,
        env_values,
        copy: detect_copy_paths(root),
        commands,
        database,
        left_empty,
    }
}

/// Host ports every container publishes, running or stopped. No docker
/// binary → no containers. Docker installed but not answering → None.
fn docker_bindings() -> Option<Vec<ContainerBinding>> {
    if shell::exec("which", &["docker"]).is_err() {
        return Some(Vec::new());
    }
    let ids = shell::exec("docker", &["ps", "-aq"]).ok()?;
    let ids: Vec<&str> = ids.stdout.split_whitespace().collect();
    if ids.is_empty() {
        return Some(Vec::new());
    }
    let mut args = vec![
        "inspect",
        "--format",
        "{{.Name}}\t{{.State.Running}}\t{{json .HostConfig.PortBindings}}",
    ];
    args.extend(ids);
    let out = shell::exec("docker", &args).ok()?;
    Some(
        out.stdout
            .lines()
            .flat_map(detect::parse_inspect_line)
            .collect(),
    )
}

fn walk(dir: &Path, root: &Path, results: &mut Vec<String>, keep: &dyn Fn(&str) -> bool) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        if EXCLUDED_DIRS.contains(&name.as_str()) {
            continue;
        }
        let full = entry.path();
        let Ok(meta) = fs::metadata(&full) else {
            continue;
        };
        if meta.is_dir() {
            walk(&full, root, results, keep);
        } else if keep(&name) {
            if let Ok(rel) = full.strip_prefix(root) {
                results.push(rel.display().to_string());
            }
        }
    }
}

fn is_state_file(name: &str) -> bool {
    Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| STATE_EXTENSIONS.contains(&e))
}

/// Gitignored local state worth copying into a worktree. Tracked files already
/// arrive with the checkout, so "git ignores it" is the whole signal.
///
/// A match is proposed as its containing directory when that directory is
/// itself ignored — copying `database.db` without its `-wal`/`-shm` siblings
/// can hand the app a torn read.
fn detect_copy_paths(root: &Path) -> Vec<String> {
    let mut files = Vec::new();
    walk(root, root, &mut files, &is_state_file);
    if files.is_empty() {
        return Vec::new();
    }

    let repo = root.display().to_string();
    let parents: Vec<String> = files
        .iter()
        .filter_map(|f| Path::new(f).parent())
        .map(|p| p.display().to_string())
        .filter(|p| !p.is_empty())
        .collect();
    let ignored_dirs = git::ignored_paths(&repo, &parents);

    let mut candidates: Vec<String> = Vec::new();
    for file in &files {
        let parent = Path::new(file)
            .parent()
            .map(|p| p.display().to_string())
            .unwrap_or_default();
        let candidate = if !parent.is_empty() && ignored_dirs.contains(&parent) {
            parent
        } else {
            file.clone()
        };
        if !candidates.contains(&candidate) {
            candidates.push(candidate);
        }
    }

    let ignored = git::ignored_paths(&repo, &candidates);
    candidates.retain(|c| ignored.contains(c));
    candidates
}
