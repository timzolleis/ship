use crate::schema::Workspace;

/// Locate a workspace by an optional branch query, otherwise by cwd.
///
/// - Branch query precedence: exact → ends_with("/{q}") → contains(q).
/// - cwd matching is path-prefix safe: `/a/bc` does not match a workspace
///   rooted at `/a/b`.
/// - A branch query takes precedence over cwd: when provided, cwd is not
///   consulted even if the query matches nothing.
pub fn locate_workspace<'a>(
    workspaces: &'a [Workspace],
    cwd: &str,
    branch: Option<&str>,
) -> Option<&'a Workspace> {
    if let Some(q) = branch {
        return locate_by_branch(workspaces, q);
    }
    workspaces
        .iter()
        .find(|w| cwd == w.path || cwd.starts_with(&format!("{}/", w.path)))
}

fn locate_by_branch<'a>(workspaces: &'a [Workspace], q: &str) -> Option<&'a Workspace> {
    workspaces
        .iter()
        .find(|w| w.branch == q)
        .or_else(|| {
            workspaces
                .iter()
                .find(|w| w.branch.ends_with(&format!("/{q}")))
        })
        .or_else(|| workspaces.iter().find(|w| w.branch.contains(q)))
}
