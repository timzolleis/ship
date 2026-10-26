use crate::schema::EnvConfig;
use indexmap::IndexMap;
use std::collections::HashSet;

// Pure port logic. A workspace has its routed port (`Workspace::port`, the
// proxy points at it) and the project's named ports (`ProjectConfig::ports`),
// each with its own value per workspace. All of them come from one pool above
// BASE_PORT, so a new route never lands on another workspace's api port.

pub const BASE_PORT: u16 = 5173;

/// Lowest port above `base` that `used` doesn't hold (hole-filling).
pub fn next_free(used: &HashSet<u16>, base: u16) -> u16 {
    let mut port = base + 1;
    while used.contains(&port) {
        port += 1;
    }
    port
}

/// One port per declared name: an `existing` assignment is kept, a missing
/// one gets the next free port. Names the project no longer declares drop.
/// Every port handed out joins `used`, so one pool serves several calls.
pub fn assign(
    declared: &IndexMap<String, u16>,
    existing: &IndexMap<String, u16>,
    used: &mut HashSet<u16>,
) -> IndexMap<String, u16> {
    declared
        .keys()
        .map(|name| {
            let port = existing.get(name).copied().unwrap_or_else(|| {
                let port = next_free(used, BASE_PORT);
                used.insert(port);
                port
            });
            (name.clone(), port)
        })
        .collect()
}

/// A name becomes an env var (`api` → `API_PORT`) and a placeholder
/// (`{port:api}`), so it is kept to lowercase letters, digits, `-` and `_`.
pub fn is_valid_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

#[derive(Debug, PartialEq)]
pub enum PortProblem {
    InvalidName(String),
    /// An env var's `port` names no declared port.
    UnknownName {
        file: String,
        var: String,
        name: String,
    },
}

/// What would break before anything runs: a name that can't be an env var,
/// or an env var pointing at a port the project doesn't declare.
pub fn check(declared: &IndexMap<String, u16>, env: &EnvConfig) -> Option<PortProblem> {
    if let Some(name) = declared.keys().find(|n| !is_valid_name(n)) {
        return Some(PortProblem::InvalidName(name.clone()));
    }
    env.files.iter().find_map(|(file, vars)| {
        vars.iter().find_map(|(var, cfg)| {
            cfg.port
                .as_ref()
                .filter(|name| !declared.contains_key(*name))
                .map(|name| PortProblem::UnknownName {
                    file: file.clone(),
                    var: var.clone(),
                    name: name.clone(),
                })
        })
    })
}

/// `api` → `API_PORT`, `admin-api` → `ADMIN_API_PORT`.
pub fn env_name(name: &str) -> String {
    format!("{}_PORT", name.to_ascii_uppercase().replace('-', "_"))
}

/// `PORT` plus one `<NAME>_PORT` per named port.
pub fn env_vars(port: u16, ports: &IndexMap<String, u16>) -> Vec<(String, String)> {
    std::iter::once(("PORT".to_string(), port.to_string()))
        .chain(
            ports
                .iter()
                .map(|(name, p)| (env_name(name), p.to_string())),
        )
        .collect()
}

/// Replaces `{port}` with the routed port and `{port:<name>}` with a named
/// one. An unknown name is the `Err`, so a typo never reaches the shell.
pub fn substitute(
    command: &str,
    port: u16,
    ports: &IndexMap<String, u16>,
) -> Result<String, String> {
    let mut out = String::with_capacity(command.len());
    let mut rest = command;
    while let Some(start) = rest.find("{port:") {
        out.push_str(&rest[..start]);
        let after = &rest[start + "{port:".len()..];
        let Some(end) = after.find('}') else {
            out.push_str(&rest[start..]);
            rest = "";
            break;
        };
        let name = &after[..end];
        match ports.get(name) {
            Some(p) => out.push_str(&p.to_string()),
            None => return Err(name.to_string()),
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    Ok(out.replace("{port}", &port.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(pairs: &[(&str, u16)]) -> IndexMap<String, u16> {
        pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect()
    }

    #[test]
    fn next_free_fills_holes() {
        let used: HashSet<u16> = [5174, 5176].into();
        assert_eq!(next_free(&used, BASE_PORT), 5175);
    }

    #[test]
    fn assign_keeps_existing_and_allocates_the_rest_from_one_pool() {
        let declared = map(&[("api", 3000), ("worker", 3001)]);
        let mut used: HashSet<u16> = [5174, 5175].into();

        let first = assign(&declared, &map(&[("api", 5180)]), &mut used);
        let second = assign(&declared, &IndexMap::new(), &mut used);

        assert_eq!(first, map(&[("api", 5180), ("worker", 5176)]));
        assert_eq!(second, map(&[("api", 5177), ("worker", 5178)]));
    }

    #[test]
    fn assign_drops_undeclared_names() {
        let mut used = HashSet::new();
        let ports = assign(&map(&[("api", 3000)]), &map(&[("old", 5190)]), &mut used);
        assert_eq!(ports.keys().collect::<Vec<_>>(), ["api"]);
    }

    #[test]
    fn names_become_env_vars() {
        assert_eq!(env_name("admin-api"), "ADMIN_API_PORT");
        assert_eq!(
            env_vars(5179, &map(&[("api", 5180)])),
            [
                ("PORT".to_string(), "5179".to_string()),
                ("API_PORT".to_string(), "5180".to_string())
            ]
        );
    }

    #[test]
    fn valid_names() {
        assert!(is_valid_name("api"));
        assert!(is_valid_name("admin-api_2"));
        assert!(!is_valid_name(""));
        assert!(!is_valid_name("Api"));
        assert!(!is_valid_name("2api"));
        assert!(!is_valid_name("api port"));
    }

    #[test]
    fn check_finds_bad_names_and_dangling_env_references() {
        let env: EnvConfig = serde_json::from_str(
            r#"{ "files": { "apps/web/.env": { "API_URL": { "type": "dev_url", "port": "api" } } } }"#,
        )
        .unwrap();
        assert_eq!(check(&map(&[("api", 3000)]), &env), None);
        assert_eq!(
            check(&IndexMap::new(), &env),
            Some(PortProblem::UnknownName {
                file: "apps/web/.env".to_string(),
                var: "API_URL".to_string(),
                name: "api".to_string()
            })
        );
        assert_eq!(
            check(&map(&[("API", 3000)]), &EnvConfig::default()),
            Some(PortProblem::InvalidName("API".to_string()))
        );
    }

    #[test]
    fn substitutes_routed_and_named_ports() {
        let ports = map(&[("api", 5180)]);
        assert_eq!(
            substitute("vite -p {port} --api {port:api}", 5179, &ports),
            Ok("vite -p 5179 --api 5180".to_string())
        );
        assert_eq!(
            substitute("x {port:nope}", 5179, &ports),
            Err("nope".to_string())
        );
        assert_eq!(
            substitute("x {port:", 5179, &ports),
            Ok("x {port:".to_string())
        );
    }
}
