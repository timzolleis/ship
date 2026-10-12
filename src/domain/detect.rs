use crate::schema::{CommandsConfig, EnvVarType, ExecutionRuntime};
use regex::Regex;
use serde_json::Value;
use std::sync::LazyLock;

// What `ship init` may conclude from a repo. Never guess: a field is filled
// only from evidence, and every field left empty carries the reason, so the
// person or agent running init knows what to add by hand.

// ---------------------------------------------------------------------------
// Left empty
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Field {
    Install,
    Db,
    Dev,
    Database,
}

impl Field {
    /// Where the field lives in config.json, under the project.
    pub fn key(self) -> &'static str {
        match self {
            Field::Install => "commands.install",
            Field::Db => "commands.db",
            Field::Dev => "commands.dev",
            Field::Database => "database",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct LeftEmpty {
    pub field: Field,
    pub reason: String,
}

fn left_empty(field: Field, reason: impl Into<String>) -> LeftEmpty {
    LeftEmpty {
        field,
        reason: reason.into(),
    }
}

// ---------------------------------------------------------------------------
// Package manager + command lists (repo root only)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PackageManager {
    Pnpm,
    Yarn,
    Npm,
    Bun,
}

impl PackageManager {
    fn name(self) -> &'static str {
        match self {
            PackageManager::Pnpm => "pnpm",
            PackageManager::Yarn => "yarn",
            PackageManager::Npm => "npm",
            PackageManager::Bun => "bun",
        }
    }

    /// Runs a binary from the project's dependencies.
    fn exec(self) -> &'static str {
        match self {
            PackageManager::Pnpm => "pnpm exec",
            PackageManager::Yarn => "yarn",
            PackageManager::Npm => "npx",
            PackageManager::Bun => "bunx",
        }
    }

    fn from_name(name: &str) -> Option<Self> {
        [Self::Pnpm, Self::Yarn, Self::Npm, Self::Bun]
            .into_iter()
            .find(|pm| pm.name() == name)
    }
}

const LOCKFILES: [(&str, PackageManager); 5] = [
    ("pnpm-lock.yaml", PackageManager::Pnpm),
    ("yarn.lock", PackageManager::Yarn),
    ("package-lock.json", PackageManager::Npm),
    ("bun.lock", PackageManager::Bun),
    ("bun.lockb", PackageManager::Bun),
];

const PRISMA_SCHEMA: &str = "prisma/schema.prisma";
const DRIZZLE_CONFIGS: [&str; 4] = [
    "drizzle.config.ts",
    "drizzle.config.js",
    "drizzle.config.mjs",
    "drizzle.config.cjs",
];

/// Root-relative paths whose existence `commands` reads. The caller checks
/// which exist and passes those back.
pub fn markers() -> impl Iterator<Item = &'static str> {
    LOCKFILES
        .iter()
        .map(|(f, _)| *f)
        .chain([PRISMA_SCHEMA])
        .chain(DRIZZLE_CONFIGS)
}

/// `packageManager` ("pnpm@9.1.0") wins; otherwise exactly one lockfile.
/// Err is the reason none could be chosen.
fn package_manager(package_json: &Value, present: &[&str]) -> Result<PackageManager, String> {
    if let Some(field) = package_json.get("packageManager").and_then(Value::as_str) {
        let name = field.split('@').next().unwrap_or_default();
        return PackageManager::from_name(name)
            .ok_or_else(|| format!("packageManager \"{field}\" is not pnpm, yarn, npm, or bun"));
    }
    let found: Vec<&str> = LOCKFILES
        .iter()
        .filter(|(f, _)| present.contains(f))
        .map(|(f, _)| *f)
        .collect();
    let managers: Vec<PackageManager> = LOCKFILES
        .iter()
        .filter(|(f, _)| present.contains(f))
        .map(|(_, pm)| *pm)
        .fold(Vec::new(), |mut acc, pm| {
            if !acc.contains(&pm) {
                acc.push(pm);
            }
            acc
        });
    match managers.as_slice() {
        [pm] => Ok(*pm),
        [] => Err("package.json has no packageManager and there is no lockfile".to_string()),
        _ => Err(format!(
            "several lockfiles ({}) and no packageManager in package.json",
            found.join(", ")
        )),
    }
}

/// Install, db, and dev command lists from the repo root. `package_json` is
/// the parsed root package.json; `present` the `markers()` that exist.
pub fn commands(
    package_json: Option<&Value>,
    present: &[&str],
) -> (CommandsConfig, Vec<LeftEmpty>) {
    let mut commands = CommandsConfig::default();
    let mut empty = Vec::new();

    let Some(package_json) = package_json else {
        let reason = "no package.json at the repo root";
        empty.push(left_empty(Field::Install, reason));
        empty.push(left_empty(Field::Db, reason));
        empty.push(left_empty(Field::Dev, reason));
        return (commands, empty);
    };

    let pm = match package_manager(package_json, present) {
        Ok(pm) => pm,
        Err(reason) => {
            empty.push(left_empty(Field::Install, &reason));
            empty.push(left_empty(Field::Db, &reason));
            empty.push(left_empty(Field::Dev, &reason));
            return (commands, empty);
        }
    };

    commands.install.push(format!("{} install", pm.name()));

    let has_dev = package_json
        .get("scripts")
        .and_then(|s| s.get("dev"))
        .is_some();
    if has_dev {
        commands.dev.push(format!("{} run dev", pm.name()));
    } else {
        empty.push(left_empty(Field::Dev, "package.json has no \"dev\" script"));
    }

    let prisma = present.contains(&PRISMA_SCHEMA);
    let drizzle = DRIZZLE_CONFIGS.iter().any(|f| present.contains(f));
    match (prisma, drizzle) {
        (true, false) => commands
            .db
            .push(format!("{} prisma migrate deploy", pm.exec())),
        (false, true) => commands
            .db
            .push(format!("{} drizzle-kit migrate", pm.exec())),
        (true, true) => empty.push(left_empty(
            Field::Db,
            "both prisma/schema.prisma and a drizzle config at the repo root",
        )),
        (false, false) => empty.push(left_empty(
            Field::Db,
            "no prisma/schema.prisma or drizzle.config.* at the repo root",
        )),
    }

    (commands, empty)
}

// ---------------------------------------------------------------------------
// .env files
// ---------------------------------------------------------------------------

/// `.env` and `.env.*`, minus the committed templates.
pub fn is_env_file(name: &str) -> bool {
    let template = [".example", ".sample", ".template"]
        .iter()
        .any(|s| name.ends_with(s));
    (name == ".env" || name.starts_with(".env.")) && !template
}

static ENV_LINE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([A-Z_]+)=(.+)$").unwrap());
static DATABASE_URL_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^postgres(?:ql)?://([^:@/]+)(?::[^@]*)?@([^:/]+)(?::(\d+))?/([^?]+)").unwrap()
});

fn strip_quotes(v: &str) -> &str {
    let v = v
        .strip_prefix('"')
        .or_else(|| v.strip_prefix('\''))
        .unwrap_or(v);
    v.strip_suffix('"')
        .or_else(|| v.strip_suffix('\''))
        .unwrap_or(v)
}

/// The vars ship rewrites per workspace, with their current values. Anything
/// else in the file is copied verbatim.
pub fn classify_env(content: &str) -> Vec<(String, String, EnvVarType)> {
    let mut vars = Vec::new();
    for line in content.lines() {
        let Some(caps) = ENV_LINE_RE.captures(line) else {
            continue;
        };
        let key = caps[1].to_string();
        let value = strip_quotes(&caps[2]).to_string();

        let kind = if key == "DATABASE_URL" || key.ends_with("_DATABASE_URL") {
            // A sqlite path or file: URL lives in the worktree; only a postgres
            // URL names a database ship clones.
            parse_database_url(&value).map(|_| EnvVarType::DatabaseUrl)
        } else if key.ends_with("_URL") && value.contains(".localhost") {
            Some(EnvVarType::ProxyUrl)
        } else if key.ends_with("_CALLBACK_URL") && value.starts_with("http://localhost") {
            Some(EnvVarType::DevUrl)
        } else {
            None
        };
        if let Some(kind) = kind {
            vars.push((key, value, kind));
        }
    }
    vars
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct DatabaseUrl {
    pub user: String,
    pub host: String,
    pub port: u16,
    pub database: String,
}

pub fn parse_database_url(url: &str) -> Option<DatabaseUrl> {
    let caps = DATABASE_URL_RE.captures(url)?;
    Some(DatabaseUrl {
        user: caps[1].to_string(),
        host: caps[2].to_string(),
        port: match caps.get(3) {
            Some(p) => p.as_str().parse().ok()?,
            None => 5432,
        },
        database: caps[4].to_string(),
    })
}

/// A container's published host port.
#[derive(Debug, Clone, PartialEq)]
pub struct ContainerBinding {
    pub name: String,
    pub host_port: u16,
    pub running: bool,
}

/// One `docker inspect --format '{{.Name}}\t{{.State.Running}}\t{{json .HostConfig.PortBindings}}'`
/// line → every host port it publishes.
pub fn parse_inspect_line(line: &str) -> Vec<ContainerBinding> {
    let mut parts = line.splitn(3, '\t');
    let (Some(name), Some(running), Some(bindings)) = (parts.next(), parts.next(), parts.next())
    else {
        return Vec::new();
    };
    let name = name.trim_start_matches('/').to_string();
    let running = running == "true";
    let Ok(Value::Object(map)) = serde_json::from_str::<Value>(bindings) else {
        return Vec::new();
    };
    map.values()
        .filter_map(Value::as_array)
        .flatten()
        .filter_map(|b| b.get("HostPort")?.as_str()?.parse().ok())
        .map(|host_port| ContainerBinding {
            name: name.clone(),
            host_port,
            running,
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq)]
pub struct DatabaseFound {
    pub runtime: ExecutionRuntime,
    pub user: String,
    pub source: String,
    pub host: String,
    pub port: u16,
}

/// The project's postgres server from its `DATABASE_URL`s and the docker
/// containers that publish ports. `bindings` is None when docker is installed
/// but not answering; `container` is `--db-container`. Err is the reason.
pub fn database(
    urls: &[DatabaseUrl],
    bindings: Option<&[ContainerBinding]>,
    container: Option<&str>,
) -> Result<DatabaseFound, String> {
    let Some(url) = urls.first() else {
        return Err("no postgres DATABASE_URL in any .env file".to_string());
    };
    if let Some(other) = urls.iter().find(|u| *u != url) {
        return Err(format!(
            "DATABASE_URLs disagree: {}@{}:{}/{} vs {}@{}:{}/{}",
            url.user,
            url.host,
            url.port,
            url.database,
            other.user,
            other.host,
            other.port,
            other.database
        ));
    }
    let found = |runtime| DatabaseFound {
        runtime,
        user: url.user.clone(),
        source: url.database.clone(),
        host: url.host.clone(),
        port: url.port,
    };

    if let Some(name) = container {
        return Ok(found(ExecutionRuntime::Docker {
            container: name.to_string(),
        }));
    }
    let Some(bindings) = bindings else {
        return Err("docker is not answering, so ship can't tell where postgres runs".to_string());
    };
    let publishing: Vec<&ContainerBinding> = bindings
        .iter()
        .filter(|b| b.host_port == url.port)
        .collect();
    let running: Vec<&ContainerBinding> =
        publishing.iter().copied().filter(|b| b.running).collect();
    match (publishing.as_slice(), running.as_slice()) {
        ([one], _) | (_, [one]) => Ok(found(ExecutionRuntime::Docker {
            container: one.name.clone(),
        })),
        ([], _) => {
            // The local runtime runs createdb/psql against the default server,
            // so it only reaches postgres on localhost:5432.
            let local_host = matches!(url.host.as_str(), "localhost" | "127.0.0.1");
            if local_host && url.port == 5432 {
                Ok(found(ExecutionRuntime::Local))
            } else {
                Err(format!(
                    "no docker container publishes port {}, and ship's local runtime only reaches localhost:5432",
                    url.port
                ))
            }
        }
        (many, _) => Err(format!(
            "containers {} all publish port {}",
            many.iter()
                .map(|b| b.name.as_str())
                .collect::<Vec<_>>()
                .join(", "),
            url.port
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn cmds(package_json: Option<Value>, present: &[&str]) -> (CommandsConfig, Vec<Field>) {
        let (c, empty) = commands(package_json.as_ref(), present);
        (c, empty.into_iter().map(|e| e.field).collect())
    }

    #[test]
    fn package_manager_field_wins_over_lockfiles() {
        let (c, _) = cmds(
            Some(json!({ "packageManager": "pnpm@9.1.0" })),
            &["package-lock.json"],
        );
        assert_eq!(c.install, ["pnpm install"]);
    }

    #[test]
    fn one_lockfile_names_the_manager() {
        let (c, _) = cmds(Some(json!({})), &["yarn.lock"]);
        assert_eq!(c.install, ["yarn install"]);
    }

    #[test]
    fn several_lockfiles_leave_every_command_empty() {
        let (c, empty) = cmds(Some(json!({})), &["yarn.lock", "package-lock.json"]);
        assert!(c.install.is_empty() && c.db.is_empty() && c.dev.is_empty());
        assert_eq!(empty, [Field::Install, Field::Db, Field::Dev]);
    }

    #[test]
    fn bun_lockfiles_count_as_one_manager() {
        let (c, _) = cmds(Some(json!({})), &["bun.lock", "bun.lockb"]);
        assert_eq!(c.install, ["bun install"]);
    }

    #[test]
    fn no_package_json_leaves_every_command_empty() {
        let (c, empty) = cmds(None, &[]);
        assert!(c.install.is_empty());
        assert_eq!(empty, [Field::Install, Field::Db, Field::Dev]);
    }

    #[test]
    fn dev_script_becomes_the_dev_command() {
        let (c, empty) = cmds(
            Some(json!({ "scripts": { "dev": "next dev" } })),
            &["package-lock.json"],
        );
        assert_eq!(c.dev, ["npm run dev"]);
        assert!(!empty.contains(&Field::Dev));
    }

    #[test]
    fn no_dev_script_leaves_dev_empty() {
        let (c, empty) = cmds(Some(json!({})), &["pnpm-lock.yaml"]);
        assert!(c.dev.is_empty());
        assert!(empty.contains(&Field::Dev));
    }

    #[test]
    fn prisma_or_drizzle_names_the_db_command() {
        let (c, _) = cmds(Some(json!({})), &["pnpm-lock.yaml", PRISMA_SCHEMA]);
        assert_eq!(c.db, ["pnpm exec prisma migrate deploy"]);
        let (c, _) = cmds(Some(json!({})), &["package-lock.json", "drizzle.config.ts"]);
        assert_eq!(c.db, ["npx drizzle-kit migrate"]);
    }

    #[test]
    fn both_or_neither_migration_tool_leaves_db_empty() {
        let (c, empty) = cmds(
            Some(json!({})),
            &["pnpm-lock.yaml", PRISMA_SCHEMA, "drizzle.config.ts"],
        );
        assert!(c.db.is_empty());
        assert!(empty.contains(&Field::Db));
        let (c, empty) = cmds(Some(json!({})), &["pnpm-lock.yaml"]);
        assert!(c.db.is_empty());
        assert!(empty.contains(&Field::Db));
    }

    #[test]
    fn env_files_skip_templates() {
        assert!(is_env_file(".env"));
        assert!(is_env_file(".env.local"));
        assert!(is_env_file(".env.development"));
        assert!(!is_env_file(".env.example"));
        assert!(!is_env_file(".env.sample"));
        assert!(!is_env_file(".env.template"));
        assert!(!is_env_file(".envrc"));
    }

    #[test]
    fn classifies_only_vars_ship_rewrites() {
        let vars = classify_env(
            "DATABASE_URL=\"postgresql://app:secret@localhost:5433/app\"\n\
             CACHE_DATABASE_URL=file:./dev.db\n\
             APP_URL=https://app.localhost\n\
             AUTH_CALLBACK_URL=http://localhost:3000/cb\n\
             SECRET=abc",
        );
        let kinds: Vec<(&str, EnvVarType)> =
            vars.iter().map(|(k, _, t)| (k.as_str(), *t)).collect();
        assert_eq!(
            kinds,
            [
                ("DATABASE_URL", EnvVarType::DatabaseUrl),
                ("APP_URL", EnvVarType::ProxyUrl),
                ("AUTH_CALLBACK_URL", EnvVarType::DevUrl),
            ]
        );
    }

    fn url(port: u16) -> DatabaseUrl {
        parse_database_url(&format!("postgres://app:pw@localhost:{port}/app")).unwrap()
    }

    fn binding(name: &str, host_port: u16, running: bool) -> ContainerBinding {
        ContainerBinding {
            name: name.to_string(),
            host_port,
            running,
        }
    }

    fn docker(name: &str) -> ExecutionRuntime {
        ExecutionRuntime::Docker {
            container: name.to_string(),
        }
    }

    #[test]
    fn parses_a_database_url_without_a_port() {
        let u = parse_database_url("postgresql://app@db.internal/app_dev?schema=public").unwrap();
        assert_eq!(
            (
                u.user.as_str(),
                u.host.as_str(),
                u.port,
                u.database.as_str()
            ),
            ("app", "db.internal", 5432, "app_dev")
        );
    }

    #[test]
    fn no_postgres_url_means_no_database() {
        assert!(database(&[], Some(&[]), None).is_err());
    }

    #[test]
    fn disagreeing_urls_mean_no_database() {
        assert!(database(&[url(5432), url(5433)], Some(&[]), None).is_err());
    }

    #[test]
    fn the_container_flag_wins() {
        let found = database(&[url(5432)], None, Some("pg")).unwrap();
        assert_eq!(found.runtime, docker("pg"));
        assert_eq!(found.source, "app");
    }

    #[test]
    fn the_container_publishing_the_port_runs_the_database() {
        let bindings = [binding("redis", 6379, true), binding("pg", 5433, false)];
        let found = database(&[url(5433)], Some(&bindings), None).unwrap();
        assert_eq!(found.runtime, docker("pg"));
    }

    #[test]
    fn of_several_publishers_the_running_one_wins() {
        let bindings = [binding("old", 5432, false), binding("pg", 5432, true)];
        assert_eq!(
            database(&[url(5432)], Some(&bindings), None)
                .unwrap()
                .runtime,
            docker("pg")
        );
    }

    #[test]
    fn several_stopped_publishers_mean_no_database() {
        let bindings = [binding("a", 5432, false), binding("b", 5432, false)];
        assert!(database(&[url(5432)], Some(&bindings), None).is_err());
    }

    #[test]
    fn no_publisher_on_the_default_port_is_local() {
        assert_eq!(
            database(&[url(5432)], Some(&[]), None).unwrap().runtime,
            ExecutionRuntime::Local
        );
    }

    #[test]
    fn no_publisher_on_another_port_means_no_database() {
        assert!(database(&[url(5433)], Some(&[]), None).is_err());
    }

    #[test]
    fn docker_not_answering_means_no_database() {
        assert!(database(&[url(5432)], None, None).is_err());
    }

    #[test]
    fn parses_docker_inspect_bindings() {
        let line = "/pg\ttrue\t{\"5432/tcp\":[{\"HostIp\":\"\",\"HostPort\":\"5433\"}]}";
        assert_eq!(parse_inspect_line(line), [binding("pg", 5433, true)]);
        assert!(parse_inspect_line("/x\tfalse\tnull").is_empty());
    }
}
