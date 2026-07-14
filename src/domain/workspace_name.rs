use crate::schema::WorktreeConfig;

// Single source of truth for slugging + pattern resolution. Semantics ported
// verbatim from the TS domain module:
//   branch_slug:      "/" → "-"
//   branch_slug_safe: [^a-zA-Z0-9] → "_", then lowercased
//   resolve_pattern:  replace every `{key}` occurrence with the var's value.

pub struct WorkspaceNames {
    pub worktree_dir_relative: String,
    pub db_name: String,
    pub proxy_domain: String,
}

fn to_branch_slug(branch: &str) -> String {
    branch.replace('/', "-")
}

fn to_branch_slug_safe(branch: &str) -> String {
    branch
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect()
}

/// Replace every `{key}` occurrence with its value. Unknown placeholders are
/// left untouched.
pub fn resolve_pattern(pattern: &str, vars: &[(&str, &str)]) -> String {
    let mut result = pattern.to_string();
    for (key, value) in vars {
        result = result.replace(&format!("{{{key}}}"), value);
    }
    result
}

/// Derive all workspace names. `worktree_dir_relative` is relative — the
/// caller resolves it against the project's repo path.
pub fn derive_names(wt: &WorktreeConfig, project: &str, branch: &str) -> WorkspaceNames {
    let branch_slug = to_branch_slug(branch);
    let branch_slug_safe = to_branch_slug_safe(branch);
    let vars: &[(&str, &str)] = &[
        ("branch_slug", &branch_slug),
        ("branch_slug_safe", &branch_slug_safe),
        ("project", project),
    ];
    WorkspaceNames {
        worktree_dir_relative: resolve_pattern(&wt.dir_pattern, vars),
        db_name: resolve_pattern(&wt.db_name_pattern, vars),
        proxy_domain: resolve_pattern(&wt.proxy_domain_pattern, vars),
    }
}
