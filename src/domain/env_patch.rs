use crate::schema::{EnvConfig, EnvVarType};
use regex::{NoExpand, Regex};
use std::sync::LazyLock;

// Pure .env content patching. Rules (unchanged from the TS implementation):
//   - Only lines matching ^([A-Z_]+)=(.+)$ are candidates; everything else
//     (comments, blanks, non KEY=VALUE lines) is preserved verbatim.
//   - Keys absent from `env.auto_detected` are preserved verbatim.
//   - Surrounding single/double quotes are stripped from the value first.
//   - database_url → swap the trailing /<segment> for /<db_name>.
//   - proxy_url    → swap the http(s)://<origin> for https://<proxy_domain>.
//   - dev_url      → http://localhost:<port><configured path suffix>.
//   - plain        → untouched.
//   - A change is recorded (key/from/to) ONLY when the value actually changed.

pub struct EnvPatchContext {
    pub db_name: String,
    pub proxy_domain: String,
    pub port: u16,
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

pub fn patch_env_content(content: &str, env: &EnvConfig, ctx: &EnvPatchContext) -> EnvPatchResult {
    let mut changes = Vec::new();
    let mut lines = Vec::new();

    for line in content.split('\n') {
        let Some(caps) = LINE_RE.captures(line) else {
            lines.push(line.to_string());
            continue;
        };
        let key = &caps[1];
        let raw_value = &caps[2];

        let Some(var_config) = env.auto_detected.get(key) else {
            lines.push(line.to_string());
            continue;
        };

        let value = strip_quotes(raw_value).to_string();
        let new_value = match var_config.var_type {
            EnvVarType::DatabaseUrl => DB_TAIL_RE
                .replace(&value, NoExpand(&format!("/{}", ctx.db_name)))
                .into_owned(),
            EnvVarType::ProxyUrl => ORIGIN_RE
                .replace(&value, NoExpand(&format!("https://{}", ctx.proxy_domain)))
                .into_owned(),
            EnvVarType::DevUrl => {
                let url_path = var_config.path.as_deref().unwrap_or("");
                format!("http://localhost:{}{}", ctx.port, url_path)
            }
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
