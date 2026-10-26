use crate::domain::env_patch::EnvPatchContext;
use crate::domain::ports as domain_ports;
use crate::domain::remote_branch::RemoteBranchAction;
use crate::domain::removal::Removal;
use crate::domain::workspace_name::derive_names;
use crate::errors::{Error, Result};
use crate::schema::{DatabaseConfig, ExecutionRuntime, ProjectConfig, Workspace};
use crate::services::copy::{self, CopyOutcome, CopyStatus};
use crate::services::database::{self, DbTarget};
use crate::services::env::{self, PatchResult};
use crate::services::shell::{self, NON_INTERACTIVE_ENV};
use crate::services::{agent, config, git, ports, proxy};
use crate::util::resolve_path;
use std::sync::mpsc;

// The deep orchestrator. The provisioning state machine
// (probe → resume-from-any-partial-state → execute) lives here, off the
// commands. Events are collected and rendered by the caller afterwards
// (matches the TS version, which buffered before streaming).

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Status {
    Done,
    SkippedExisting,
    Warning,
}

#[derive(Debug, Clone)]
pub struct StepEvent<S: Copy> {
    pub step: S,
    pub status: Status,
    pub detail: Option<String>,
}

fn step<S: Copy>(s: S, status: Status, detail: Option<String>) -> StepEvent<S> {
    StepEvent {
        step: s,
        status,
        detail,
    }
}

// A path that vanished (a teammate's local certs) must not fail the whole
// create — it degrades to a warning line.
fn copy_status(outcomes: &[CopyOutcome]) -> Status {
    if outcomes.iter().any(|o| {
        matches!(
            o.status,
            CopyStatus::MissingSource | CopyStatus::OutsideProject
        )
    }) {
        Status::Warning
    } else if outcomes
        .iter()
        .all(|o| matches!(o.status, CopyStatus::SkippedExisting))
    {
        Status::SkippedExisting
    } else {
        Status::Done
    }
}

fn copy_detail(outcomes: &[CopyOutcome]) -> String {
    let mut copied = 0;
    let mut bytes = 0;
    let mut skipped = 0;
    let mut problems = Vec::new();

    for o in outcomes {
        match &o.status {
            CopyStatus::Copied { files, bytes: b } => {
                copied += files;
                bytes += b;
            }
            CopyStatus::SkippedExisting => skipped += 1,
            CopyStatus::MissingSource => problems.push(format!("{} not found", o.path)),
            CopyStatus::OutsideProject => {
                problems.push(format!("{} is outside the project", o.path))
            }
        }
    }

    let mut parts = Vec::new();
    if copied > 0 {
        parts.push(format!(
            "{copied} file{} ({})",
            crate::util::plural(copied),
            copy::human_size(bytes)
        ));
    }
    if skipped > 0 {
        parts.push(format!("{skipped} already present"));
    }
    parts.extend(problems);
    parts.join(", ")
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ProvisionStep {
    Probe,
    Register,
    SyncBase,
    Worktree,
    Database,
    Copy,
    Env,
    Install,
    Db,
    ProxyRoute,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum TeardownStep {
    ProxyRoute,
    Database,
    Worktree,
    Branch,
    RemoteBranch,
    AgentSessions,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ResetStep {
    Drop,
    Clone,
    Db,
}

// Run every command in a scope, in order, in `dir`. Non-interactive env.
fn run_scope(dir: &str, cmds: &[String]) -> Result<()> {
    for cmd in cmds {
        shell::exec_in_dir(dir, cmd, NON_INTERACTIVE_ENV)?;
    }
    Ok(())
}

pub struct ProvisionInput<'a> {
    pub project_alias: &'a str,
    pub project_config: &'a ProjectConfig,
    pub branch: &'a str,
    pub base_branch: Option<&'a str>,
}

pub struct ProvisionOutcome {
    pub events: Vec<StepEvent<ProvisionStep>>,
    pub workspace: Workspace,
    pub already_complete: bool,
    pub env_changes: Vec<PatchResult>,
}

#[derive(Clone, Copy)]
pub struct TeardownOptions {
    pub remove_worktree: bool,
    pub force: bool,
    pub remote_branch: RemoteBranchAction,
}

fn runtime_label(db: &DatabaseConfig) -> String {
    match &db.runtime {
        ExecutionRuntime::Docker { container } => format!("docker:{container}"),
        ExecutionRuntime::Local => "local".to_string(),
    }
}

fn today_iso() -> String {
    chrono::Utc::now().format("%Y-%m-%d").to_string()
}

// -- provision --------------------------------------------------------------

/// Where the branch's workspace lives: wherever the branch is already checked
/// out — another tool (Herdr) may have made the worktree — else `pattern_dir`.
/// The main checkout never counts: a workspace needs its own worktree.
fn worktree_dir_for(
    worktrees: &[git::WorktreeEntry],
    main_checkout: &str,
    branch: &str,
    pattern_dir: String,
) -> String {
    let main = main_checkout.trim_end_matches('/');
    worktrees
        .iter()
        .find(|w| w.branch == branch && w.path.trim_end_matches('/') != main)
        .map(|w| w.path.clone())
        .unwrap_or(pattern_dir)
}

pub fn provision(input: &ProvisionInput) -> Result<ProvisionOutcome> {
    let pc = input.project_config;
    let alias = input.project_alias;
    let branch = input.branch;
    let mut events: Vec<StepEvent<ProvisionStep>> = Vec::new();
    ports::check(pc)?;

    // 1. Derive names; resolve the worktree dir: the branch's existing
    // checkout, else the pattern dir against pc.path.
    let names = derive_names(&pc.worktree, pc.database.as_ref(), alias, branch);
    let worktrees = git::worktree_list(&pc.path).unwrap_or_default();
    let worktree_dir = worktree_dir_for(
        &worktrees,
        &pc.path,
        branch,
        resolve_path(&pc.path, &names.worktree_dir_relative),
    );
    // The project's database and this workspace's name in it; None when the
    // project has no database.
    let db = pc.database.as_ref().zip(names.db_name.as_deref());

    // 2. Probe each resource defensively (probe failures = absent).
    let existing_ws = config::find_workspace(alias, branch).unwrap_or(None);
    let worktree_exists = worktrees.iter().any(|w| w.path == worktree_dir);

    let ping_ok = db.is_none_or(|(d, _)| database::ping(DbTarget::from(d)));
    let db_exists =
        ping_ok && db.is_some_and(|(d, name)| database::exists(DbTarget::from(d), name));

    let routes = proxy::get_routes().unwrap_or_default();
    let existing_route = routes.iter().find(|r| r.domain == names.proxy_domain);

    // 3. Port precedence: registered ws → existing route → next free. Named
    // ports keep the registered ones and take free ports for the rest. A
    // Caddyfile or registry that can't be read fails here: a made-up port
    // could collide.
    let mut used = ports::used()?;
    let port = match existing_ws
        .as_ref()
        .map(|w| w.port)
        .or(existing_route.map(|r| r.port))
    {
        Some(port) => port,
        None => domain_ports::next_free(&used, domain_ports::BASE_PORT),
    };
    used.insert(port);
    let named_ports = domain_ports::assign(
        &pc.ports,
        &existing_ws
            .as_ref()
            .map(|w| w.ports.clone())
            .unwrap_or_default(),
        &mut used,
    );

    // 4. Everything present → short-circuit, no mutations. No database
    // counts as present.
    let all_present = existing_ws
        .as_ref()
        .is_some_and(|w| w.ports == named_ports && w.path == worktree_dir)
        && worktree_exists
        && (db.is_none() || db_exists)
        && existing_route.is_some();
    if all_present {
        let workspace = existing_ws.unwrap_or_else(|| Workspace {
            project: alias.to_string(),
            branch: branch.to_string(),
            path: worktree_dir.clone(),
            port,
            ports: named_ports.clone(),
            db_name: names.db_name.clone(),
            proxy_domain: names.proxy_domain.clone(),
            created: String::new(),
        });
        return Ok(ProvisionOutcome {
            events,
            workspace,
            already_complete: true,
            env_changes: vec![],
        });
    }

    // 5. db unreachable → fail before any mutation.
    if let (false, Some((d, _))) = (ping_ok, db) {
        return Err(Error::DatabaseUnreachable {
            runtime: runtime_label(d),
        });
    }

    // 6. Partial setup → probe event.
    let resuming =
        existing_ws.is_some() || worktree_exists || db_exists || existing_route.is_some();
    if resuming {
        events.push(step(
            ProvisionStep::Probe,
            Status::Done,
            Some("resuming partial setup".to_string()),
        ));
    }

    // 7. Register the workspace entry FIRST.
    let was_registered = existing_ws.is_some();
    let workspace = match existing_ws {
        // A port named since the workspace registered gets its value now. A
        // checkout adopted after a failed run moves the entry to its path.
        Some(ws) if ws.ports != named_ports || ws.path != worktree_dir => {
            let ws = Workspace {
                ports: named_ports,
                path: worktree_dir.clone(),
                ..ws
            };
            config::update_workspace(&ws)?;
            ws
        }
        Some(ws) => ws,
        None => {
            let ws = Workspace {
                project: alias.to_string(),
                branch: branch.to_string(),
                path: worktree_dir.clone(),
                port,
                ports: named_ports,
                db_name: names.db_name.clone(),
                proxy_domain: names.proxy_domain.clone(),
                created: today_iso(),
            };
            config::add_workspace(ws.clone())?;
            ws
        }
    };
    events.push(step(
        ProvisionStep::Register,
        if was_registered {
            Status::SkippedExisting
        } else {
            Status::Done
        },
        None,
    ));

    // 8a. base: fetch, then branch from the fetched ref. The base checkout is
    // never pulled, installed, or migrated here — the workspace's own db scope
    // migrates its clone, and `ship sync` updates the base checkout.
    if worktree_exists {
        events.push(step(ProvisionStep::SyncBase, Status::SkippedExisting, None));
        events.push(step(ProvisionStep::Worktree, Status::SkippedExisting, None));
    } else {
        let fetched = git::fetch(&pc.path);
        let base_ref = git::resolve_base(&pc.path, input.base_branch);
        events.push(match fetched {
            Ok(()) => step(
                ProvisionStep::SyncBase,
                Status::Done,
                Some(base_ref.clone()),
            ),
            Err(e) => step(
                ProvisionStep::SyncBase,
                Status::Warning,
                Some(format!("fetch failed, branching from {base_ref}: {e}")),
            ),
        });

        // 8b. worktree.
        git::worktree_add(&pc.path, &worktree_dir, branch, Some(&base_ref))?;
        events.push(step(ProvisionStep::Worktree, Status::Done, None));
    }

    // 8c. copy local state. Before install/db so migrations and seeds see it.
    if !pc.copy.is_empty() {
        let outcomes = copy::copy_paths(&pc.path, &worktree_dir, &pc.copy)?;
        events.push(step(
            ProvisionStep::Copy,
            copy_status(&outcomes),
            Some(copy_detail(&outcomes)),
        ));
    }

    // 8d. env.
    let env_changes = env::patch_env_files(
        &pc.path,
        &worktree_dir,
        &pc.env,
        &EnvPatchContext {
            db_name: names.db_name.clone(),
            proxy_domain: names.proxy_domain.clone(),
            port,
            ports: workspace.ports.clone(),
        },
    )?;
    let change_count: usize = env_changes.iter().map(|r| r.changes.len()).sum();
    events.push(step(
        ProvisionStep::Env,
        Status::Done,
        Some(format!("{change_count} changes")),
    ));

    // 8e. database clone and install scope, side by side: neither reads the
    // other's output; only the db scope needs both. The clone captures its
    // output, so the install's streamed output stays readable. No database,
    // no clone and no Database step.
    let (cloned, installed) = std::thread::scope(|s| {
        let clone = db.filter(|_| !db_exists).map(|(d, name)| {
            s.spawn(move || database::clone_db(DbTarget::from(d), &d.source, name))
        });
        let installed = (!pc.commands.install.is_empty())
            .then(|| run_scope(&worktree_dir, &pc.commands.install));
        let cloned = clone.map(|h| h.join().unwrap_or_else(|p| std::panic::resume_unwind(p)));
        (cloned, installed)
    });
    match cloned {
        None if db.is_some() => {
            events.push(step(ProvisionStep::Database, Status::SkippedExisting, None))
        }
        None => {}
        Some(r) => {
            r?;
            events.push(step(ProvisionStep::Database, Status::Done, None));
        }
    }
    if let Some(r) = installed {
        r?;
        events.push(step(ProvisionStep::Install, Status::Done, None));
    }

    // 8f. db scope (only when configured).
    if !pc.commands.db.is_empty() {
        run_scope(&worktree_dir, &pc.commands.db)?;
        events.push(step(ProvisionStep::Db, Status::Done, None));
    }

    // 8g. proxy-route.
    if existing_route.is_some() {
        events.push(step(
            ProvisionStep::ProxyRoute,
            Status::SkippedExisting,
            None,
        ));
    } else {
        match proxy::add_route(&names.proxy_domain, port) {
            Ok(()) => events.push(step(ProvisionStep::ProxyRoute, Status::Done, None)),
            Err(e) => events.push(step(
                ProvisionStep::ProxyRoute,
                Status::Warning,
                Some(e.to_string()),
            )),
        }
    }

    Ok(ProvisionOutcome {
        events,
        workspace,
        already_complete: false,
        env_changes,
    })
}

// -- teardown (never fails; warnings as events) -------------------------------

/// The steps `teardown` will run, in order — a caller can draw the checklist
/// before the work starts. Keep in lockstep with `teardown_each`.
pub fn teardown_steps(opts: &TeardownOptions) -> Vec<TeardownStep> {
    let mut steps = vec![TeardownStep::ProxyRoute, TeardownStep::Database];
    if opts.remove_worktree {
        steps.push(TeardownStep::Worktree);
        steps.push(TeardownStep::Branch);
        steps.push(TeardownStep::RemoteBranch);
        if agent::cleanup_enabled() {
            steps.push(TeardownStep::AgentSessions);
        }
    }
    steps
}

/// One job per workspace to tear down.
#[derive(Clone)]
pub struct TeardownJob {
    pub ws: Workspace,
    pub pc: ProjectConfig,
    pub opts: TeardownOptions,
}

/// Every job at once, one thread each, all events on one channel tagged with
/// the job's index. Steps within a job stay sequential — the parallelism is
/// across workspaces, where the waiting actually is (`git push` to delete a
/// remote branch, `dropdb` over docker).
///
/// Nothing here writes the registry: the caller drops entries on the main
/// thread once the render loop ends, so `workspaces.json` has a single writer.
pub fn teardown_all_stream(
    jobs: Vec<TeardownJob>,
) -> mpsc::Receiver<(usize, StepEvent<TeardownStep>)> {
    let (tx, rx) = mpsc::channel();
    for (index, job) in jobs.into_iter().enumerate() {
        let tx = tx.clone();
        std::thread::spawn(move || {
            teardown_each(&job.ws, &job.pc, &job.opts, |e| {
                let _ = tx.send((index, e));
            })
        });
    }
    rx
}

fn teardown_each(
    ws: &Workspace,
    pc: &ProjectConfig,
    opts: &TeardownOptions,
    mut emit: impl FnMut(StepEvent<TeardownStep>),
) {
    emit(match proxy::remove_route(&ws.proxy_domain) {
        Ok(Removal::Removed) => step(TeardownStep::ProxyRoute, Status::Done, None),
        Ok(Removal::AlreadyGone) => step(TeardownStep::ProxyRoute, Status::SkippedExisting, None),
        Err(e) => step(
            TeardownStep::ProxyRoute,
            Status::Warning,
            Some(e.to_string()),
        ),
    });

    emit(match (&pc.database, &ws.db_name) {
        (Some(db), Some(name)) => match database::drop_db(DbTarget::from(db), name) {
            Ok(()) => step(TeardownStep::Database, Status::Done, None),
            Err(e) => step(TeardownStep::Database, Status::Warning, Some(e.to_string())),
        },
        _ => step(
            TeardownStep::Database,
            Status::SkippedExisting,
            Some("no database".to_string()),
        ),
    });

    if opts.remove_worktree {
        // git remove, with a filesystem force-remove fallback: if `git worktree
        // remove` refuses — e.g. uncommitted changes without --force, or corrupt
        // metadata — still clear the dir from disk so no orphan is left behind.
        emit(match git::worktree_remove(&pc.path, &ws.path, opts.force) {
            Ok(Removal::Removed) => step(TeardownStep::Worktree, Status::Done, None),
            Ok(Removal::AlreadyGone) => step(TeardownStep::Worktree, Status::SkippedExisting, None),
            Err(_) => match std::fs::remove_dir_all(&ws.path) {
                Ok(()) => step(
                    TeardownStep::Worktree,
                    Status::Done,
                    Some("removed (force)".to_string()),
                ),
                Err(e) => step(TeardownStep::Worktree, Status::Warning, Some(e.to_string())),
            },
        });

        emit(match git::delete_branch(&pc.path, &ws.branch) {
            Ok(Removal::Removed) => step(TeardownStep::Branch, Status::Done, None),
            Ok(Removal::AlreadyGone) => step(TeardownStep::Branch, Status::SkippedExisting, None),
            Err(e) => step(TeardownStep::Branch, Status::Warning, Some(e.to_string())),
        });

        match opts.remote_branch {
            RemoteBranchAction::KeepNoPullRequest => emit(step(
                TeardownStep::RemoteBranch,
                Status::SkippedExisting,
                Some("kept \u{2014} no PR".to_string()),
            )),
            RemoteBranchAction::KeepOpenPullRequest(number) => emit(step(
                TeardownStep::RemoteBranch,
                Status::SkippedExisting,
                Some(format!("kept \u{2014} PR #{number} is open")),
            )),
            RemoteBranchAction::Delete => {
                emit(match git::delete_remote_branch(&pc.path, &ws.branch) {
                    Ok(Removal::Removed) => step(TeardownStep::RemoteBranch, Status::Done, None),
                    Ok(Removal::AlreadyGone) => {
                        step(TeardownStep::RemoteBranch, Status::SkippedExisting, None)
                    }
                    Err(e) => step(
                        TeardownStep::RemoteBranch,
                        Status::Warning,
                        Some(e.to_string()),
                    ),
                });
            }
        }

        if agent::cleanup_enabled() {
            let removed = agent::remove_sessions_for(&ws.path);
            emit(match removed {
                0 => step(TeardownStep::AgentSessions, Status::SkippedExisting, None),
                n => step(
                    TeardownStep::AgentSessions,
                    Status::Done,
                    Some(format!("{n} store{}", crate::util::plural(n))),
                ),
            });
        }
    }
}

// -- reset -------------------------------------------------------------------

pub fn reset_database(ws: &Workspace, pc: &ProjectConfig) -> Result<Vec<StepEvent<ResetStep>>> {
    let mut events = Vec::new();
    let (Some(db), Some(name)) = (&pc.database, &ws.db_name) else {
        return Err(Error::NoDatabase {
            alias: ws.project.clone(),
        });
    };
    let target = DbTarget::from(db);

    database::drop_db(target, name)?;
    events.push(step(ResetStep::Drop, Status::Done, None));

    database::clone_db(target, &db.source, name)?;
    events.push(step(ResetStep::Clone, Status::Done, None));

    for cmd in &pc.commands.db {
        shell::exec_in_dir(&ws.path, cmd, NON_INTERACTIVE_ENV)?;
        events.push(step(ResetStep::Db, Status::Done, Some(cmd.clone())));
    }

    Ok(events)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(remote_branch: RemoteBranchAction) -> TeardownOptions {
        TeardownOptions {
            remove_worktree: true,
            force: true,
            remote_branch,
        }
    }

    fn wt(path: &str, branch: &str) -> git::WorktreeEntry {
        git::WorktreeEntry {
            path: path.to_string(),
            branch: branch.to_string(),
        }
    }

    #[test]
    fn adopts_the_branch_checkout_made_outside_ship() {
        let worktrees = [
            wt("/code/app", "main"),
            wt("/home/.herdr/worktrees/app/feat-x", "feat-x"),
        ];
        let dir = worktree_dir_for(&worktrees, "/code/app", "feat-x", "/code/app-feat-x".into());
        assert_eq!(dir, "/home/.herdr/worktrees/app/feat-x");
    }

    #[test]
    fn falls_back_to_the_pattern_dir() {
        let worktrees = [wt("/code/app", "main")];
        let dir = worktree_dir_for(&worktrees, "/code/app", "feat-x", "/code/app-feat-x".into());
        assert_eq!(dir, "/code/app-feat-x");
    }

    #[test]
    fn never_adopts_the_main_checkout() {
        let worktrees = [wt("/code/app", "feat-x")];
        let dir = worktree_dir_for(
            &worktrees,
            "/code/app/",
            "feat-x",
            "/code/app-feat-x".into(),
        );
        assert_eq!(dir, "/code/app-feat-x");
    }

    /// Every remote-branch decision needs a row so kept branches explain why.
    #[test]
    fn remote_branch_decisions_stay_visible_in_the_checklist() {
        for action in [
            RemoteBranchAction::KeepNoPullRequest,
            RemoteBranchAction::KeepOpenPullRequest(42),
            RemoteBranchAction::Delete,
        ] {
            assert!(teardown_steps(&opts(action)).contains(&TeardownStep::RemoteBranch));
        }
    }
}
