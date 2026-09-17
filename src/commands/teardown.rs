use crate::errors::Result;
use crate::services::config;
use crate::services::workspace::{
    teardown_all_stream, teardown_steps, Status, StepEvent, TeardownJob, TeardownStep,
};
use crate::ui::{Mark, Outcome, Pace, Row, Section, Tree};
use std::sync::Mutex;

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

fn outcome_of(status: Status) -> Outcome {
    match status {
        Status::Done => Outcome::Done,
        Status::SkippedExisting => Outcome::Skipped,
        Status::Warning => Outcome::Warning,
    }
}

/// What a workspace's row shows once every step is in. A bare "done" adds
/// nothing next to the ✓, so only trouble gets text.
struct Tally {
    done: usize,
    problem: Option<String>,
}

impl Tally {
    fn record(&mut self, e: &StepEvent<TeardownStep>) {
        self.done += 1;
        if matches!(e.status, Status::Warning) && self.problem.is_none() {
            let step = step_name(e.step).to_lowercase();
            self.problem = Some(match &e.detail {
                Some(detail) => format!("{step}: {detail}"),
                None => format!("{step} failed"),
            });
        }
    }
}

/// Tears every job down at once, one thread each, behind one live tree: a
/// section per project, a row per workspace. A workspace's registry entry drops
/// only when all of its steps finished clean — a warned step keeps the entry so
/// the next `ship down` or `ship gc` retries it, and steps skip what is already
/// gone, so the retry is safe.
///
/// Returns the `project/branch` of every workspace still in the registry.
pub fn run_all(jobs: Vec<TeardownJob>) -> Result<Vec<String>> {
    if jobs.is_empty() {
        return Ok(Vec::new());
    }
    let steps: Vec<Vec<TeardownStep>> = jobs.iter().map(|j| teardown_steps(&j.opts)).collect();
    let single = jobs.len() == 1;

    // One row per step for a single workspace, one row per workspace otherwise.
    // Steps inside a workspace run in order; the workspaces themselves run
    // together.
    let (mut tree, placement) = if single {
        let rows = steps[0]
            .iter()
            .map(|s| Row::new((), [step_name(*s).to_string()]))
            .collect();
        let heading = format!("{} / {}", jobs[0].ws.project, jobs[0].ws.branch);
        (
            Tree::new(vec![Section::new(heading, rows, Pace::Sequential)]),
            vec![(0usize, 0usize)],
        )
    } else {
        let mut groups: Vec<(String, Vec<Row<()>>)> = Vec::new();
        let mut placement = Vec::with_capacity(jobs.len());
        for job in &jobs {
            let section = match groups.iter().position(|(p, _)| *p == job.ws.project) {
                Some(i) => i,
                None => {
                    groups.push((job.ws.project.clone(), Vec::new()));
                    groups.len() - 1
                }
            };
            placement.push((section, groups[section].1.len()));
            groups[section]
                .1
                .push(Row::new((), [job.ws.branch.clone()]));
        }
        let sections = groups
            .into_iter()
            .map(|(project, rows)| Section::new(project, rows, Pace::Concurrent))
            .collect();
        (Tree::new(sections), placement)
    };

    // A workspace row spins on the step it has reached, so it needs an opening
    // step name: the stream only speaks when a step has finished.
    if !single {
        for (job, (section, row)) in placement.iter().enumerate() {
            if let Some(first) = steps[job].first() {
                tree.apply(Mark::running(*section, *row, step_name(*first)));
            }
        }
    }

    let tallies: Mutex<Vec<Tally>> = Mutex::new(
        jobs.iter()
            .map(|_| Tally {
                done: 0,
                problem: None,
            })
            .collect(),
    );
    let events = teardown_all_stream(jobs.clone());

    tree.run(events, |(job, e): (usize, StepEvent<TeardownStep>)| {
        let (section, row) = placement[job];
        let mut tallies = tallies.lock().unwrap_or_else(|p| p.into_inner());
        let tally = &mut tallies[job];
        tally.record(&e);

        if single {
            // One row per step, so the event picks its own row.
            let row = steps[job].iter().position(|s| *s == e.step).unwrap_or(0);
            let detail = match e.status {
                Status::Done => e.detail,
                Status::SkippedExisting => {
                    Some(e.detail.unwrap_or_else(|| "nothing to clear".to_string()))
                }
                Status::Warning => Some(e.detail.unwrap_or_else(|| "failed".to_string())),
            };
            return Mark::finished(section, row, outcome_of(e.status), detail);
        }

        match steps[job].get(tally.done) {
            Some(next) => Mark::running(section, row, step_name(*next)),
            None => match &tally.problem {
                Some(problem) => {
                    Mark::finished(section, row, Outcome::Warning, Some(problem.clone()))
                }
                None => Mark::finished(section, row, Outcome::Done, None),
            },
        }
    })?;

    // Registry writes stay on this thread, so `workspaces.json` has one writer
    // no matter how many teardowns ran.
    let tallies = tallies.into_inner().unwrap_or_else(|p| p.into_inner());
    let mut kept = Vec::new();
    for (index, (job, tally)) in jobs.iter().zip(tallies).enumerate() {
        let name = format!("{}/{}", job.ws.project, job.ws.branch);
        // Fewer events than steps means the worker died mid-teardown; keep the
        // entry so the state it left behind is still on the books.
        if tally.problem.is_some() || tally.done < steps[index].len() {
            kept.push(name);
            continue;
        }
        config::remove_workspace(&job.ws.project, &job.ws.branch)?;
    }
    Ok(kept)
}
