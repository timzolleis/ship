use crate::schema::{EnvFileVars, EnvVarType};
use indexmap::IndexMap;
use regex::{NoExpand, Regex};
use std::sync::LazyLock;

// Pure .env content patching. Rules (unchanged from the TS implementation):
//   - Only lines matching ^([A-Z_]+)=(.+)$ are candidates; everything else
//     (comments, blanks, non KEY=VALUE lines) is preserved verbatim.
//   - Keys absent from `vars` are preserved verbatim.
//   - Surrounding single/double quotes are stripped from the value first.
//   - database_url → swap the trailing /<segment> for /<db_name>; untouched
//     when the project has no database (no name to swap in).
//   - proxy_url    → swap the http(s)://<origin> for https://<proxy_domain>.
//   - dev_url      → http://localhost:<port><configured path suffix>.
//   - port         → <port>.
//   - plain        → untouched.
//   - dev_url and port take the routed port, or the named one in `port`; a
//     name the workspace lacks leaves the value untouched (`ports::check`
//     rejects that config before anything runs).
//   - A change is recorded (key/from/to) ONLY when the value actually changed.

pub struct EnvPatchContext {
    pub db_name: Option<String>,
    pub proxy_domain: String,
    pub port: u16,
    /// The workspace's named ports.
    pub ports: IndexMap<String, u16>,
}

impl EnvPatchContext {
    fn port_for(&self, name: Option<&str>) -> Option<u16> {
        match name {
            None => Some(self.port),
            Some(name) => self.ports.get(name).copied(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct EnvChange {
    pub key: String,
    pub from: String,
    pub to: String,
}

pub struct EnvPatchResult {
    pub content: String,
    pub changes: Vec<EnvChange>,
}

static LINE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([A-Z_]+)=(.+)$").unwrap());
static DB_TAIL_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"/([^/]+)$").unwrap());
static ORIGIN_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"https?://[^/]+").unwrap());

fn strip_quotes(v: &str) -> &str {
    let v = v
        .strip_prefix('"')
        .or_else(|| v.strip_prefix('\''))
        .unwrap_or(v);
    v.strip_suffix('"')
        .or_else(|| v.strip_suffix('\''))
        .unwrap_or(v)
}

pub fn patch_env_content(
    content: &str,
    vars: &EnvFileVars,
    ctx: &EnvPatchContext,
) -> EnvPatchResult {
    let mut changes = Vec::new();
    let mut lines = Vec::new();

    for line in content.split('\n') {
        let Some(caps) = LINE_RE.captures(line) else {
            lines.push(line.to_string());
            continue;
        };
        let key = &caps[1];
        let raw_value = &caps[2];

        let Some(var_config) = vars.get(key) else {
            lines.push(line.to_string());
            continue;
        };

        let value = strip_quotes(raw_value).to_string();
        let new_value = match var_config.var_type {
            EnvVarType::DatabaseUrl => match &ctx.db_name {
                Some(db_name) => DB_TAIL_RE
                    .replace(&value, NoExpand(&format!("/{db_name}")))
                    .into_owned(),
                None => value.clone(),
            },
            EnvVarType::ProxyUrl => ORIGIN_RE
                .replace(&value, NoExpand(&format!("https://{}", ctx.proxy_domain)))
                .into_owned(),
            EnvVarType::DevUrl => match ctx.port_for(var_config.port.as_deref()) {
                Some(port) => {
                    let url_path = var_config.path.as_deref().unwrap_or("");
                    format!("http://localhost:{port}{url_path}")
                }
                None => value.clone(),
            },
            EnvVarType::Port => match ctx.port_for(var_config.port.as_deref()) {
                Some(port) => port.to_string(),
                None => value.clone(),
            },
            EnvVarType::Plain => value.clone(),
        };

        if new_value != value {
            changes.push(EnvChange {
                key: key.to_string(),
                from: value,
                to: new_value.clone(),
            });
        }
        lines.push(format!("{key}={new_value}"));
    }

    EnvPatchResult {
        content: lines.join("\n"),
        changes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::EnvVarConfig;

    fn ctx() -> EnvPatchContext {
        EnvPatchContext {
            db_name: Some("znb_tim_feature".to_string()),
            proxy_domain: "tim-feature.znb.localhost".to_string(),
            port: 3210,
            ports: [("api".to_string(), 3211)].into_iter().collect(),
        }
    }

    fn vars(pairs: &[(&str, EnvVarType)]) -> EnvFileVars {
        pairs
            .iter()
            .map(|(k, t)| {
                (
                    k.to_string(),
                    EnvVarConfig {
                        var_type: *t,
                        path: None,
                        port: None,
                    },
                )
            })
            .collect()
    }

    // The same name gets different handling per file: a shared postgres URL is
    // rewritten, a worktree-relative sqlite path must survive untouched.
    #[test]
    fn same_key_different_handling_per_file() {
        let api = patch_env_content(
            "DATABASE_URL=postgresql://postgres:postgres@localhost:5433/znb",
            &vars(&[("DATABASE_URL", EnvVarType::DatabaseUrl)]),
            &ctx(),
        );
        assert_eq!(
            api.content,
            "DATABASE_URL=postgresql://postgres:postgres@localhost:5433/znb_tim_feature"
        );

        let console = patch_env_content(
            "DATABASE_URL=file:../../development/sqlite-data/database.db",
            &vars(&[("DATABASE_URL", EnvVarType::Plain)]),
            &ctx(),
        );
        assert_eq!(
            console.content,
            "DATABASE_URL=file:../../development/sqlite-data/database.db"
        );
        assert!(console.changes.is_empty());
    }

    #[test]
    fn unconfigured_keys_and_comments_survive() {
        let out = patch_env_content(
            "# comment\nSECRET=abc\nBETTER_AUTH_URL=https://console.znb.localhost",
            &vars(&[("BETTER_AUTH_URL", EnvVarType::ProxyUrl)]),
            &ctx(),
        );
        assert_eq!(
            out.content,
            "# comment\nSECRET=abc\nBETTER_AUTH_URL=https://tim-feature.znb.localhost"
        );
        assert_eq!(out.changes.len(), 1);
    }

    #[test]
    fn named_ports_fill_dev_urls_and_port_vars() {
        let vars: EnvFileVars = serde_json::from_str(
            r#"{
              "API_URL": { "type": "dev_url", "port": "api", "path": "/api" },
              "API_PORT": { "type": "port", "port": "api" },
              "PORT": { "type": "port" }
            }"#,
        )
        .unwrap();
        let out = patch_env_content(
            "API_URL=http://localhost:3000/api\nAPI_PORT=3000\nPORT=5173",
            &vars,
            &ctx(),
        );
        assert_eq!(
            out.content,
            "API_URL=http://localhost:3211/api\nAPI_PORT=3211\nPORT=3210"
        );
    }
}
