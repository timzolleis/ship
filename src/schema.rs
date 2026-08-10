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

impl EnvVarType {
    pub const ALL: [EnvVarType; 4] = [
        EnvVarType::DatabaseUrl,
        EnvVarType::ProxyUrl,
        EnvVarType::DevUrl,
        EnvVarType::Plain,
    ];

    /// Stored JSON value. Hardcoded rather than round-tripped through serde so
    /// `ship config show` can print it without allocating.
    pub fn json_value(self) -> &'static str {
        match self {
            EnvVarType::DatabaseUrl => "database_url",
            EnvVarType::ProxyUrl => "proxy_url",
            EnvVarType::DevUrl => "dev_url",
            EnvVarType::Plain => "plain",
        }
    }

    /// Prompt/table label — describes the effect on the value, not the type name.
    pub fn label(self) -> &'static str {
        match self {
            EnvVarType::DatabaseUrl => "swap database name",
            EnvVarType::ProxyUrl => "swap proxy domain",
            EnvVarType::DevUrl => "point at local dev port",
            EnvVarType::Plain => "leave untouched",
        }
    }

    pub fn help(self) -> &'static str {
        match self {
            EnvVarType::DatabaseUrl => "swap the trailing /name for the workspace database",
            EnvVarType::ProxyUrl => "swap the origin for the workspace proxy domain",
            EnvVarType::DevUrl => "replace with http://localhost:<port><path>",
            EnvVarType::Plain => {
                "copy verbatim — use for sqlite paths and anything worktree-relative"
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvVarConfig {
    #[serde(rename = "type")]
    pub var_type: EnvVarType,
    /// Path suffix appended after the port. `dev_url` only.
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

/// Var name → how its value is rewritten, for one .env file.
pub type EnvFileVars = IndexMap<String, EnvVarConfig>;

#[derive(Debug, Clone, Default, Serialize)]
pub struct EnvConfig {
    /// .env path (relative to the project root) → its vars.
    ///
    /// Keyed per file because the same name legitimately needs different
    /// handling per package — a shared postgres `DATABASE_URL` must be
    /// rewritten, a sqlite one pointing inside the worktree must not.
    pub files: IndexMap<String, EnvFileVars>,
}

// Pre-per-file shape: a flat `autoDetected` map applied to every file. Decoded
// by fanning each var out to all files (exactly what the old patcher did), then
// canonically written back on the next save.
#[derive(Deserialize)]
#[serde(untagged)]
enum EnvConfigRepr {
    PerFile {
        files: IndexMap<String, EnvFileVars>,
    },
    Flat {
        files: Vec<String>,
        #[serde(default, rename = "autoDetected")]
        auto_detected: EnvFileVars,
    },
}

impl<'de> Deserialize<'de> for EnvConfig {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        Ok(match EnvConfigRepr::deserialize(d)? {
            EnvConfigRepr::PerFile { files } => EnvConfig { files },
            EnvConfigRepr::Flat { files, auto_detected } => EnvConfig {
                files: files
                    .into_iter()
                    .map(|f| (f, auto_detected.clone()))
                    .collect(),
            },
        })
    }
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
    /// Gitignored paths copied into each new worktree — local state a checkout
    /// can't carry (sqlite files, certs, fixtures). Files or directories,
    /// relative to the project root.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub copy: Vec<String>,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flat_config_fans_out_to_every_file() {
        let env: EnvConfig = serde_json::from_str(
            r#"{
              "files": ["packages/api-server/.env", "apps/console/.env"],
              "autoDetected": { "DATABASE_URL": { "type": "database_url" } }
            }"#,
        )
        .unwrap();

        assert_eq!(env.files.len(), 2);
        for vars in env.files.values() {
            assert_eq!(vars["DATABASE_URL"].var_type, EnvVarType::DatabaseUrl);
        }
    }

    #[test]
    fn per_file_config_round_trips() {
        let json = r#"{
          "files": {
            "apps/console/.env": {
              "DATABASE_URL": { "type": "plain" },
              "AUTH_CALLBACK_URL": { "type": "dev_url", "path": "/api/auth" }
            }
          }
        }"#;
        let env: EnvConfig = serde_json::from_str(json).unwrap();
        let vars = &env.files["apps/console/.env"];
        assert_eq!(vars["DATABASE_URL"].var_type, EnvVarType::Plain);
        assert_eq!(vars["AUTH_CALLBACK_URL"].path.as_deref(), Some("/api/auth"));

        let reparsed: EnvConfig =
            serde_json::from_str(&serde_json::to_string(&env).unwrap()).unwrap();
        assert_eq!(reparsed.files.len(), 1);
    }
}
