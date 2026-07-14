use regex::Regex;
use std::sync::LazyLock;

// Pure Caddyfile route codec + port allocation. Semantics ported verbatim:
//   - domain-block regex                   ^([a-z0-9][a-z0-9.\-]*)\s*\{
//   - reverse_proxy host.docker.internal   reverse_proxy\s+host\.docker\.internal:(\d+)
//   - remove_route: skip block lines, collapse blank runs (\n{3,} → \n\n),
//     trim, then a single trailing newline.
//   - next_port: lowest free port above the base (hole-filling).

#[derive(Debug, Clone)]
pub struct Route {
    pub domain: String,
    pub port: u16,
}

pub const BASE_PORT: u16 = 5173;

static DOMAIN_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^([a-z0-9][a-z0-9.\-]*)\s*\{").unwrap());
static PROXY_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"reverse_proxy\s+host\.docker\.internal:(\d+)").unwrap());
static BLANK_RUN_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n{3,}").unwrap());

pub fn parse_routes(content: &str) -> Vec<Route> {
    if content.trim().is_empty() {
        return vec![];
    }
    let mut routes = Vec::new();
    let mut current_domain: Option<String> = None;
    for line in content.split('\n') {
        if let Some(m) = DOMAIN_RE.captures(line) {
            current_domain = Some(m[1].to_string());
        }
        if let Some(m) = PROXY_RE.captures(line) {
            if let Some(domain) = current_domain.take() {
                if let Ok(port) = m[1].parse::<u16>() {
                    routes.push(Route { domain, port });
                }
            }
        }
    }
    routes
}

pub fn add_route(content: &str, domain: &str, port: u16) -> String {
    format!("{content}\n{domain} {{\n    reverse_proxy host.docker.internal:{port}\n}}\n")
}

pub fn remove_route(content: &str, domain: &str) -> String {
    let mut result: Vec<&str> = Vec::new();
    let mut skip = false;
    let block_start = format!("{domain} {{");
    for line in content.split('\n') {
        if line.starts_with(&block_start) {
            skip = true;
            continue;
        }
        if skip && line.trim() == "}" {
            skip = false;
            continue;
        }
        if !skip {
            result.push(line);
        }
    }
    let joined = result.join("\n");
    let collapsed = BLANK_RUN_RE.replace_all(&joined, "\n\n");
    format!("{}\n", collapsed.trim())
}

pub fn next_port(routes: &[Route], base: u16) -> u16 {
    let used: std::collections::HashSet<u16> = routes.iter().map(|r| r.port).collect();
    let mut port = base + 1;
    while used.contains(&port) {
        port += 1;
    }
    port
}
