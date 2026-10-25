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
    Port,
    Plain,
}

impl EnvVarType {
    pub const ALL: [EnvVarType; 5] = [
        EnvVarType::DatabaseUrl,
        EnvVarType::ProxyUrl,
        EnvVarType::DevUrl,
        EnvVarType::Port,
        EnvVarType::Plain,
    ];

    /// Stored JSON value. Hardcoded rather than round-tripped through serde so
    /// `ship config show` can print it without allocating.
    pub fn json_value(self) -> &'static str {
        match self {
            EnvVarType::DatabaseUrl => "database_url",
            EnvVarType::ProxyUrl => "proxy_url",
            EnvVarType::DevUrl => "dev_url",
            EnvVarType::Port => "port",
            EnvVarType::Plain => "plain",
        }
    }

    /// Prompt/table label — describes the effect on the value, not the type name.
    pub fn label(self) -> &'static str {
        match self {
            EnvVarType::DatabaseUrl => "swap database name",
            EnvVarType::ProxyUrl => "swap proxy domain",
            EnvVarType::DevUrl => "point at local dev port",
            EnvVarType::Port => "set to the workspace port",
            EnvVarType::Plain => "leave untouched",
        }
    }

    pub fn help(self) -> &'static str {
        match self {
            EnvVarType::DatabaseUrl => "swap the trailing /name for the workspace database",
            EnvVarType::ProxyUrl => "swap the origin for the workspace proxy domain",
            EnvVarType::DevUrl => "replace with http://localhost:<port><path>",
            EnvVarType::Port => "replace with the port number",
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
    /// A named port of the project (`ports`) instead of the routed one.
    /// `dev_url` and `port` only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<String>,
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

/// The project's postgres server. Absent when the project has none — every
/// database step then skips (create, teardown, sync) or fails with
/// `Error::NoDatabase` (reset, db exec, open db).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseConfig {
    pub runtime: ExecutionRuntime,
    pub user: String,
    pub source: String,
    pub host: String,
    pub port: u16,
    /// Workspace database name, e.g. `{project}_{branch_slug_safe}`.
    pub name_pattern: String,
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
            EnvConfigRepr::Flat {
                files,
                auto_detected,
            } => EnvConfig {
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
}

#[derive(Debug, Clone, Serialize)]
pub struct ProjectConfig {
    pub path: String,
    /// Root checkout route. Absent on projects registered before root routes
    /// existed — `ship up` backfills.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    /// Extra ports beside the routed one, by name → the root checkout's port.
    /// Each workspace gets its own (`Workspace::ports`); none is routed.
    #[serde(default, skip_serializing_if = "IndexMap::is_empty")]
    pub ports: IndexMap<String, u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub database: Option<DatabaseConfig>,
    pub commands: CommandsConfig,
    pub env: EnvConfig,
    /// Gitignored paths copied into each new worktree — local state a checkout
    /// can't carry (sqlite files, certs, fixtures). Files or directories,
    /// relative to the project root.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub copy: Vec<String>,
    pub worktree: WorktreeConfig,
}

// Decoded through a repr: the workspace database-name pattern used to live in
// `worktree.dbNamePattern`. It moves into `database.namePattern` here, and the
// next save writes the new shape. A project without a database drops it.
#[derive(Deserialize)]
struct DatabaseRepr {
    runtime: ExecutionRuntime,
    user: String,
    source: String,
    // Configs written before host/port existed only ever meant localhost:5432.
    #[serde(default = "default_host")]
    host: String,
    #[serde(default = "default_db_port")]
    port: u16,
    #[serde(default, rename = "namePattern")]
    name_pattern: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorktreeRepr {
    dir_pattern: String,
    proxy_domain_pattern: String,
    #[serde(default)]
    db_name_pattern: Option<String>,
}

#[derive(Deserialize)]
struct ProjectConfigRepr {
    path: String,
    #[serde(default)]
    domain: Option<String>,
    #[serde(default)]
    port: Option<u16>,
    #[serde(default)]
    ports: IndexMap<String, u16>,
    #[serde(default)]
    database: Option<DatabaseRepr>,
    commands: CommandsConfig,
    env: EnvConfig,
    #[serde(default)]
    copy: Vec<String>,
    worktree: WorktreeRepr,
}

impl<'de> Deserialize<'de> for ProjectConfig {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        let r = ProjectConfigRepr::deserialize(d)?;
        let database = match r.database {
            None => None,
            Some(db) => Some(DatabaseConfig {
                name_pattern: db
                    .name_pattern
                    .or(r.worktree.db_name_pattern)
                    .ok_or_else(|| serde::de::Error::missing_field("database.namePattern"))?,
                runtime: db.runtime,
                user: db.user,
                source: db.source,
                host: db.host,
                port: db.port,
            }),
        };
        Ok(ProjectConfig {
            path: r.path,
            domain: r.domain,
            port: r.port,
            ports: r.ports,
            database,
            commands: r.commands,
            env: r.env,
            copy: r.copy,
            worktree: WorktreeConfig {
                dir_pattern: r.worktree.dir_pattern,
                proxy_domain_pattern: r.worktree.proxy_domain_pattern,
            },
        })
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShipConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub editor: Option<String>,
    /// Auto-open editor after ship create. None = ask first time.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_open_editor: Option<bool>,
    /// Delete agent transcripts with the worktree. None = on.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delete_agent_sessions: Option<bool>,
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
    /// This workspace's value for each of the project's named ports.
    #[serde(default, skip_serializing_if = "IndexMap::is_empty")]
    pub ports: IndexMap<String, u16>,
    /// Absent when the project has no database.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub db_name: Option<String>,
    pub proxy_domain: String,
    pub created: String,
}

impl Workspace {
    /// How every listing orders workspaces: one block per project, branches
    /// alphabetical inside it. The registry itself stays in creation order.
    pub fn listing_order(a: &Self, b: &Self) -> std::cmp::Ordering {
        (&a.project, &a.branch).cmp(&(&b.project, &b.branch))
    }
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

    const PROJECT_REST: &str = r#""path": "/repo", "commands": {}, "env": { "files": {} }"#;

    #[test]
    fn legacy_db_name_pattern_moves_into_database() {
        let json = format!(
            r#"{{ {PROJECT_REST},
              "database": {{ "runtime": {{ "_tag": "local" }}, "user": "postgres", "source": "app" }},
              "worktree": {{ "dirPattern": "../app-{{branch_slug}}/", "proxyDomainPattern": "{{branch_slug}}.app.localhost", "dbNamePattern": "app_{{branch_slug_safe}}" }} }}"#
        );
        let pc: ProjectConfig = serde_json::from_str(&json).unwrap();
        let db = pc.database.as_ref().unwrap();
        assert_eq!(db.name_pattern, "app_{branch_slug_safe}");
        assert_eq!((db.host.as_str(), db.port), ("localhost", 5432));

        let written = serde_json::to_value(&pc).unwrap();
        assert_eq!(written["database"]["namePattern"], "app_{branch_slug_safe}");
        assert!(written["worktree"].get("dbNamePattern").is_none());
    }

    #[test]
    fn project_without_a_database_drops_the_pattern() {
        let json = format!(
            r#"{{ {PROJECT_REST},
              "worktree": {{ "dirPattern": "../app-{{branch_slug}}/", "proxyDomainPattern": "{{branch_slug}}.app.localhost", "dbNamePattern": "app_{{branch_slug_safe}}" }} }}"#
        );
        let pc: ProjectConfig = serde_json::from_str(&json).unwrap();
        assert!(pc.database.is_none());
        assert!(serde_json::to_value(&pc).unwrap().get("database").is_none());
    }

    #[test]
    fn workspace_without_a_database_round_trips() {
        let json = r#"{ "project": "app", "branch": "b", "path": "/p", "port": 5174, "proxyDomain": "b.app.localhost", "created": "2024-01-01" }"#;
        let ws: Workspace = serde_json::from_str(json).unwrap();
        assert!(ws.db_name.is_none());
        assert!(serde_json::to_value(&ws).unwrap().get("dbName").is_none());
    }

    #[test]
    fn named_ports_round_trip_and_stay_out_when_empty() {
        let json = r#"{ "project": "app", "branch": "b", "path": "/p", "port": 5174, "ports": { "api": 5175 }, "proxyDomain": "b.app.localhost", "created": "2024-01-01" }"#;
        let ws: Workspace = serde_json::from_str(json).unwrap();
        assert_eq!(ws.ports["api"], 5175);
        assert_eq!(serde_json::to_value(&ws).unwrap()["ports"]["api"], 5175);

        let pc: ProjectConfig = serde_json::from_str(&format!(
            r#"{{ {PROJECT_REST}, "worktree": {{ "dirPattern": "../a-{{branch_slug}}/", "proxyDomainPattern": "{{branch_slug}}.a.localhost" }} }}"#
        ))
        .unwrap();
        assert!(pc.ports.is_empty());
        assert!(serde_json::to_value(&pc).unwrap().get("ports").is_none());
    }
}
