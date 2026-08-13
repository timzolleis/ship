use std::path::{Component, Path};

/// Node's path.resolve(base, rel): join then normalize `.`/`..` lexically
/// (no filesystem access), dropping any trailing slash. Worktree dir patterns
/// like "../name-{branch_slug}/" rely on this to produce comparable paths.
pub fn resolve_path(base: &str, rel: &str) -> String {
    let joined = Path::new(base).join(rel);
    let mut parts: Vec<String> = Vec::new();
    let mut rooted = false;
    for comp in joined.components() {
        match comp {
            Component::RootDir => {
                rooted = true;
                parts.clear();
            }
            Component::CurDir => {}
            Component::ParentDir => {
                parts.pop();
            }
            Component::Normal(p) => parts.push(p.to_string_lossy().into_owned()),
            Component::Prefix(_) => {}
        }
    }
    let mut out = if rooted {
        String::from("/")
    } else {
        String::new()
    };
    out.push_str(&parts.join("/"));
    out
}

pub fn cwd_string() -> String {
    std::env::current_dir()
        .map(|p| p.display().to_string())
        .unwrap_or_default()
}

pub fn plural(n: usize) -> &'static str {
    if n == 1 {
        ""
    } else {
        "s"
    }
}
