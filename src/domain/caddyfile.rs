use regex::Regex;
use std::sync::LazyLock;

// Pure Caddyfile route codec + port allocation. Semantics ported verbatim:
//   - domain-block regex                   ^([a-z0-9][a-z0-9.\-]*)\s*\{
//   - reverse_proxy host.docker.internal   reverse_proxy\s+host\.docker\.internal:(\d+)
//   - remove_route: skip the block through its matching close brace (nested
//     blocks included), collapse blank runs (\n{3,} → \n\n), trim, then a
//     single trailing newline.
//   - next_port: lowest free port above the base (hole-filling).

#[derive(Debug, Clone)]
pub struct Route {
    pub domain: String,
    pub port: u16,
}

pub const BASE_PORT: u16 = 5173;

/// Upstream connections Caddy opens per dev server. Browsers multiplex a
/// cold dev page's hundreds of module requests over one HTTP/2 connection;
/// without a cap Caddy dials one upstream connection per request, overflows
/// the server's listen backlog (macOS clamps it to 128) and answers 502.
/// Excess requests wait for a free connection instead. Long-lived streams
/// (HMR websockets) hold a slot each, so it stays well above a few tabs.
pub const MAX_UPSTREAM_CONNS: u16 = 64;

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
    format!(
        "{content}\n{domain} {{\n    reverse_proxy host.docker.internal:{port} {{\n        transport http {{\n            max_conns_per_host {MAX_UPSTREAM_CONNS}\n        }}\n    }}\n}}\n"
    )
}

fn brace_delta(line: &str) -> i32 {
    line.chars()
        .map(|c| match c {
            '{' => 1,
            '}' => -1,
            _ => 0,
        })
        .sum()
}

pub fn remove_route(content: &str, domain: &str) -> String {
    let mut result: Vec<&str> = Vec::new();
    let mut depth = 0;
    let block_start = format!("{domain} {{");
    for line in content.split('\n') {
        if depth == 0 && line.starts_with(&block_start) {
            depth = brace_delta(line);
            continue;
        }
        if depth > 0 {
            depth += brace_delta(line);
            continue;
        }
        result.push(line);
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

#[cfg(test)]
mod tests {
    use super::*;

    const FLAT: &str = "a.localhost {\n    reverse_proxy host.docker.internal:5174\n}\n";

    #[test]
    fn added_route_caps_upstream_connections() {
        let content = add_route(FLAT, "b.localhost", 5175);
        assert!(content.contains("max_conns_per_host 64"));
        let routes = parse_routes(&content);
        assert_eq!(routes.len(), 2);
        assert_eq!((routes[1].domain.as_str(), routes[1].port), ("b.localhost", 5175));
    }

    #[test]
    fn removes_a_nested_block_whole() {
        let content = add_route(&add_route(FLAT, "b.localhost", 5175), "c.localhost", 5176);
        let removed = remove_route(&content, "b.localhost");
        assert!(!removed.contains("5175"));
        assert_eq!(removed.matches('{').count(), removed.matches('}').count());
        let domains: Vec<_> = parse_routes(&removed).into_iter().map(|r| r.domain).collect();
        assert_eq!(domains, ["a.localhost", "c.localhost"]);
    }

    #[test]
    fn removes_a_flat_block() {
        let content = add_route(FLAT, "b.localhost", 5175);
        let removed = remove_route(&content, "a.localhost");
        let domains: Vec<_> = parse_routes(&removed).into_iter().map(|r| r.domain).collect();
        assert_eq!(domains, ["b.localhost"]);
    }
}
