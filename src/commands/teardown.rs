use crate::errors::Result;
use crate::schema::{ProjectConfig, Workspace};
use crate::services::config;
use crate::services::workspace::{
    teardown_steps, teardown_stream, Status, StepEvent, TeardownOptions, TeardownStep,
};
use crate::ui::{Finished, Outcome, Progress, Row};
use std::sync::atomic::{AtomicBool, Ordering};

// ---------------------------------------------------------------------------
// Shared teardown rendering for `ship down` and `ship gc`
// ---------------------------------------------------------------------------

fn step_name(s: TeardownStep) -> &'static str {
    match s {
        TeardownStep::ProxyRoute => "Proxy route",
        TeardownStep::Database => "Database",
        TeardownStep::Worktree => "Worktree",
        TeardownStep::Branch => "Branch",
        TeardownStep::RemoteBranch => "Remote branch",
        TeardownStep::AgentSessions => "Agent sessions",
    }
}

/// Wording for a finished step. A bare "done" adds nothing next to the ✓, so
/// only the surprises get text.
fn finished(order: &[TeardownStep], e: StepEvent<TeardownStep>) -> Finished {
    let row = order.iter().position(|s| *s == e.step).unwrap_or(0);
    match e.status {
        Status::Done => Finished::new(row, Outcome::Done, e.detail),
        Status::SkippedExisting => Finished::new(
            row,
            Outcome::Skipped,
            Some(e.detail.unwrap_or_else(|| "nothing to clear".to_string())),
        ),
        Status::Warning => Finished::new(
            row,
            Outcome::Warning,
            Some(e.detail.unwrap_or_else(|| "failed".to_string())),
        ),
    }
}

/// Tears a workspace down behind a live checklist, then drops its registry
/// entry — but only when every step finished clean. A warned step leaves the
/// entry in place so the next `ship down` or `ship gc` retries it; teardown
/// steps skip what is already gone, so the retry is safe.
///
/// Returns false when a step warned.
pub fn run(ws: &Workspace, pc: &ProjectConfig, opts: TeardownOptions) -> Result<bool> {
    let order = teardown_steps(&opts);
    let rows = order
        .iter()
        .map(|s| Row::new(*s, [step_name(*s).to_string()]))
        .collect();
    let events = teardown_stream(ws.clone(), pc.clone(), opts);

    let warned = AtomicBool::new(false);
    Progress::new(rows).run(events, |e: StepEvent<TeardownStep>| {
        if matches!(e.status, Status::Warning) {
            warned.store(true, Ordering::Relaxed);
        }
        finished(&order, e)
    })?;

    if warned.load(Ordering::Relaxed) {
        return Ok(false);
    }
    config::remove_workspace(&ws.project, &ws.branch)?;
    Ok(true)
}
