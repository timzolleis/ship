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

/// True when `candidate` could have been produced by `pattern`.
///
/// The reverse of `resolve_pattern`: each placeholder becomes the character
/// class its slugger can emit, literals are escaped. Slugs are lossy, so this
/// proves shape only — never that a specific branch produced the name.
/// Resolve `{project}` before calling; an unknown placeholder never matches.
pub fn pattern_matches(pattern: &str, candidate: &str) -> bool {
    let mut re = String::from("^");
    let mut rest = pattern;
    while let Some(open) = rest.find('{') {
        let Some(close) = rest[open..].find('}').map(|i| open + i) else {
            break;
        };
        re.push_str(&regex::escape(&rest[..open]));
        match &rest[open + 1..close] {
            "branch_slug" => re.push_str("[^/]+"),
            "branch_slug_safe" => re.push_str("[a-z0-9_]+"),
            _ => return false,
        }
        rest = &rest[close + 1..];
    }
    re.push_str(&regex::escape(rest));
    re.push('$');
    regex::Regex::new(&re).is_ok_and(|r| r.is_match(candidate))
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

#[cfg(test)]
mod tests {
    use super::pattern_matches;

    #[test]
    fn matches_only_its_own_shape() {
        let p = "znb_{branch_slug_safe}";
        assert!(pattern_matches(p, "znb_tim_feature"));
        assert!(!pattern_matches(p, "acme_tim_feature"));
        assert!(!pattern_matches(p, "znb_"), "placeholder needs one char");
        assert!(!pattern_matches(p, "xznb_a"), "anchored at the start");
        assert!(
            !pattern_matches(p, "znb_a extra"),
            "safe slug is lowercase alnum + _"
        );
    }

    #[test]
    fn rejects_unknown_placeholders() {
        assert!(!pattern_matches("znb_{nope}", "znb_anything"));
    }

    #[test]
    fn escapes_pattern_literals() {
        assert!(!pattern_matches("zn.b_{branch_slug_safe}", "znxb_a"));
    }
}
