use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Execution runtime — where DB commands run (per-call data)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "_tag", rename_all = "lowercase")]
pub enum ExecutionRuntime {
    Local,
    Docker { container: String },
}

// ---------------------------------------------------------------------------
// Env var auto-detection
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnvVarType {
    DatabaseUrl,
    ProxyUrl,
    DevUrl,
    Plain,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvVarConfig {
    #[serde(rename = "type")]
    pub var_type: EnvVarType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

// ---------------------------------------------------------------------------
// Database config
// ---------------------------------------------------------------------------

fn default_host() -> String {
    "localhost".to_string()
}

fn default_db_port() -> u16 {
    5432
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseConfig {
    pub runtime: ExecutionRuntime,
    pub user: String,
    pub source: String,
    #[serde(default = "default_host")]
    pub host: String,
    #[serde(default = "default_db_port")]
    pub port: u16,
}

impl DatabaseConfig {
    /// Docker container name; "" for a local runtime (parity with dockerContainerOf).
    pub fn docker_container(&self) -> &str {
        match &self.runtime {
            ExecutionRuntime::Docker { container } => container,
            ExecutionRuntime::Local => "",
        }
    }
}

// ---------------------------------------------------------------------------
// Commands / env / worktree / project / root config
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CommandsConfig {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub install: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub db: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dev: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvConfig {
    pub files: Vec<String>,
    pub auto_detected: IndexMap<String, EnvVarConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeConfig {
    pub dir_pattern: String,
    pub proxy_domain_pattern: String,
    pub db_name_pattern: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectConfig {
    pub path: String,
    /// Root checkout route. Absent on projects registered before root routes
    /// existed — `ship up` backfills.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    pub database: DatabaseConfig,
    pub commands: CommandsConfig,
    pub env: EnvConfig,
    pub worktree: WorktreeConfig,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShipConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub editor: Option<String>,
    /// Auto-open editor after ship create. None = ask first time.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_open_editor: Option<bool>,
    #[serde(default)]
    pub projects: IndexMap<String, ProjectConfig>,
}

// ---------------------------------------------------------------------------
// Workspace entry — one per active worktree
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub project: String,
    pub branch: String,
    pub path: String,
    pub port: u16,
    pub db_name: String,
    pub proxy_domain: String,
    pub created: String,
}

// ---------------------------------------------------------------------------
// Update cache
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCache {
    pub last_checked_at: String,
    pub latest_version: String,
}
