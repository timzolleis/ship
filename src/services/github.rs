use crate::fmt::{blue, dim, green, yellow};
use crate::schema::{ProjectConfig, Workspace};
use crate::services::{config, shell};
use serde::Deserialize;
use std::sync::mpsc;

// ---------------------------------------------------------------------------
// Pull-request lookup via the gh CLI
// ---------------------------------------------------------------------------

#[derive(Deserialize, Clone)]
pub struct Pr {
    pub state: String,
    pub number: i64,
    #[serde(rename = "mergedAt")]
    pub merged_at: Option<String>,
}

impl Pr {
    pub fn is_merged(&self) -> bool {
        self.state == "MERGED"
    }
}

fn time_ago(iso: &str) -> String {
    let Ok(t) = chrono::DateTime::parse_from_rfc3339(iso) else {
        return "just now".to_string();
    };
    let hours = chrono::Utc::now().signed_duration_since(t).num_hours();
    if hours < 1 {
        return "just now".to_string();
    }
    if hours < 24 {
        return format!("{hours}h ago");
    }
    format!("{}d ago", hours / 24)
}

/// A missing `gh`, a repo without a remote and a branch without a PR all look
/// the same to callers: `None`. No PR is normal, not a failure.
pub fn pr_for_branch(project_path: &str, branch: &str) -> Option<Pr> {
    shell::exec_in(
        project_path,
        "gh",
        &["pr", "view", branch, "--json", "state,number,mergedAt"],
    )
    .ok()
    .and_then(|r| serde_json::from_str(&r.stdout).ok())
}

pub fn pr_label(pr: Option<&Pr>) -> String {
    match pr {
        Some(pr) if pr.is_merged() => format!(
            "PR #{} {}{}",
            pr.number,
            green("merged"),
            pr.merged_at
                .as_deref()
                .map(|m| format!(" {}", dim(time_ago(m))))
                .unwrap_or_default()
        ),
        Some(pr) if pr.state == "OPEN" => format!("PR #{} {}", pr.number, blue("open")),
        Some(pr) => format!("PR #{} {}", pr.number, yellow("closed")),
        None => dim("no PR"),
    }
}

pub struct WorkspacePr {
    pub project_config: Option<ProjectConfig>,
    pub pr: Option<Pr>,
}

fn look_up(ws: &Workspace) -> WorkspacePr {
    let project_config = config::get_project(&ws.project).ok();
    let pr = project_config
        .as_ref()
        .and_then(|pc| pr_for_branch(&pc.path, &ws.branch));
    WorkspacePr { project_config, pr }
}

/// Same lookups as `look_up_all`, but each result arrives as it finishes so a
/// caller can draw its list before `gh` answers. The index is the workspace's
/// position in `workspaces`.
pub fn look_up_stream(workspaces: Vec<Workspace>) -> mpsc::Receiver<(usize, WorkspacePr)> {
    let (tx, rx) = mpsc::channel();
    for (i, ws) in workspaces.into_iter().enumerate() {
        let tx = tx.clone();
        std::thread::spawn(move || {
            let _ = tx.send((i, look_up(&ws)));
        });
    }
    rx
}

/// One `gh` call per workspace, all in flight at once — a serial loop over a
/// dozen workspaces is seconds of dead time before the prompt draws.
pub fn look_up_all(workspaces: &[Workspace]) -> Vec<WorkspacePr> {
    std::thread::scope(|s| {
        let handles: Vec<_> = workspaces
            .iter()
            .map(|ws| s.spawn(|| look_up(ws)))
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    })
}
