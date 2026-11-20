use crate::domain::workspace_name::derive_names;
use crate::schema::{ProjectConfig, Workspace};

/// Where a workspace moves when its checkout's branch was renamed. The
/// database keeps its name: renaming it would cut off a running server.
#[derive(Debug, PartialEq)]
pub struct WorkspaceRename {
    pub branch: String,
    pub proxy_domain: String,
}

/// None when `branch` derives the domain the workspace already has.
pub fn workspace_rename_from_branch(
    ws: &Workspace,
    pc: &ProjectConfig,
    branch: &str,
) -> Option<WorkspaceRename> {
    let names = derive_names(&pc.worktree, pc.database.as_ref(), &ws.project, branch);
    (names.proxy_domain != ws.proxy_domain).then(|| WorkspaceRename {
        branch: branch.to_string(),
        proxy_domain: names.proxy_domain,
    })
}

/// The workspace under its new branch and domain; everything else stays.
pub fn renamed_workspace(ws: &Workspace, rename: &WorkspaceRename) -> Workspace {
    Workspace {
        branch: rename.branch.clone(),
        proxy_domain: rename.proxy_domain.clone(),
        ..ws.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project() -> ProjectConfig {
        serde_json::from_str(
            r#"{ "path": "/repo", "commands": {}, "env": { "files": {} },
              "database": { "runtime": { "_tag": "local" }, "user": "postgres", "source": "app", "namePattern": "app_{branch_slug_safe}" },
              "worktree": { "dirPattern": "../app-{branch_slug}/", "proxyDomainPattern": "{branch_slug}.app.localhost" } }"#,
        )
        .unwrap()
    }

    fn workspace(branch: &str, proxy_domain: &str) -> Workspace {
        Workspace {
            project: "app".into(),
            branch: branch.into(),
            path: "/wt/app".into(),
            port: 5174,
            ports: Default::default(),
            db_name: Some("app_t3code_1a2b".into()),
            proxy_domain: proxy_domain.into(),
            created: String::new(),
            bare: false,
        }
    }

    #[test]
    fn the_same_branch_stays() {
        let ws = workspace("t3code/1a2b", "t3code-1a2b.app.localhost");
        assert_eq!(
            workspace_rename_from_branch(&ws, &project(), "t3code/1a2b"),
            None
        );
    }

    #[test]
    fn a_renamed_branch_moves_branch_and_domain() {
        let ws = workspace("t3code/1a2b", "t3code-1a2b.app.localhost");
        assert_eq!(
            workspace_rename_from_branch(&ws, &project(), "fix/login"),
            Some(WorkspaceRename {
                branch: "fix/login".into(),
                proxy_domain: "fix-login.app.localhost".into(),
            })
        );
    }

    #[test]
    fn a_renamed_workspace_keeps_its_database_port_and_path() {
        let ws = workspace("t3code/1a2b", "t3code-1a2b.app.localhost");
        let rename = workspace_rename_from_branch(&ws, &project(), "fix/login").unwrap();
        let renamed = renamed_workspace(&ws, &rename);
        assert_eq!(renamed.branch, "fix/login");
        assert_eq!(renamed.db_name.as_deref(), Some("app_t3code_1a2b"));
        assert_eq!((renamed.port, renamed.path.as_str()), (5174, "/wt/app"));
    }
}
