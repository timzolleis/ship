use crate::domain::env_patch::EnvPatchContext;
use crate::domain::workspace_name::derive_names;
use crate::errors::{Error, Result};
use crate::schema::{ExecutionRuntime, ProjectConfig, Workspace};
use crate::services::database::{self, DbTarget};
use crate::services::env::{self, PatchResult};
use crate::services::shell::{self, NON_INTERACTIVE_ENV};
use crate::services::sync::{self, SyncResult};
use crate::services::{claude, config, git, proxy};
use crate::util::resolve_path;

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

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ProvisionStep {
    Probe,
    Register,
    SyncBase,
    Worktree,
    Database,
    Env,
    Install,
    Generate,
    Migrate,
    ProxyRoute,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum TeardownStep {
    ProxyRoute,
    Database,
    Worktree,
    Branch,
    RemoteBranch,
    ClaudeConvos,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ResetStep {
    Drop,
    Create,
    Clone,
    Migrate,
    Seed,
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

pub struct TeardownOptions {
    pub remove_worktree: bool,
    pub force: bool,
    pub delete_remote_branch: bool,
}

fn runtime_label(pc: &ProjectConfig) -> String {
    match &pc.database.runtime {
        ExecutionRuntime::Docker { container } => format!("docker:{container}"),
        ExecutionRuntime::Local => "local".to_string(),
    }
}

fn today_iso() -> String {
    chrono::Utc::now().format("%Y-%m-%d").to_string()
}

// Summarize a successful base sync into the sync-base step's detail:
// head-moved → "<label> fast-forwarded" (plus "; migrated <source>" when
// migrations ran); otherwise "already up to date".
fn sync_summary(r: &SyncResult, base_branch: Option<&str>, source: &str) -> String {
    let label = base_branch.unwrap_or("main");
    if r.head_moved {
        let base = format!("{label} fast-forwarded");
        return if r.migrated {
            format!("{base}; migrated {source}")
        } else {
            base
        };
    }
    "already up to date".to_string()
}

// -- provision --------------------------------------------------------------

pub fn provision(input: &ProvisionInput) -> Result<ProvisionOutcome> {
    let pc = input.project_config;
    let alias = input.project_alias;
    let branch = input.branch;
    let mut events: Vec<StepEvent<ProvisionStep>> = Vec::new();

    // 1. Derive names; resolve worktree dir against pc.path.
    let names = derive_names(&pc.worktree, alias, branch);
    let worktree_dir = resolve_path(&pc.path, &names.worktree_dir_relative);
    let target = DbTarget::from(&pc.database);

    // 2. Probe each resource defensively (probe failures = absent).
    let existing_ws = config::find_workspace(alias, branch).unwrap_or(None);
    let worktrees = git::worktree_list(&pc.path).unwrap_or_default();
    let worktree_exists = worktrees.iter().any(|w| w.path == worktree_dir);

    let ping_ok = database::ping(target);
    let db_exists = ping_ok && database::exists(target, &names.db_name);

    let routes = proxy::get_routes().unwrap_or_default();
    let existing_route = routes.iter().find(|r| r.domain == names.proxy_domain);

    // 3. Port precedence: registered ws → existing route → next_port.
    let port = existing_ws
        .as_ref()
        .map(|w| w.port)
        .or(existing_route.map(|r| r.port))
        .unwrap_or_else(|| proxy::next_port().unwrap_or(5173));

    // 4. All four present → short-circuit, no mutations.
    let all_present =
        existing_ws.is_some() && worktree_exists && db_exists && existing_route.is_some();
    if all_present {
        let workspace = existing_ws.unwrap_or_else(|| Workspace {
            project: alias.to_string(),
            branch: branch.to_string(),
            path: worktree_dir.clone(),
            port,
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
    if !ping_ok {
        return Err(Error::DatabaseUnreachable {
            runtime: runtime_label(pc),
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
    let workspace = existing_ws.unwrap_or_else(|| Workspace {
        project: alias.to_string(),
        branch: branch.to_string(),
        path: worktree_dir.clone(),
        port,
        db_name: names.db_name.clone(),
        proxy_domain: names.proxy_domain.clone(),
        created: today_iso(),
    });
    if !was_registered {
        config::add_workspace(workspace.clone())?;
    }
    events.push(step(
        ProvisionStep::Register,
        if was_registered {
            Status::SkippedExisting
        } else {
            Status::Done
        },
        None,
    ));

    // 8a. sync-base (skip when worktree already on disk).
    if worktree_exists {
        events.push(step(ProvisionStep::SyncBase, Status::SkippedExisting, None));
    } else {
        match sync::sync(pc, input.base_branch) {
            Ok(r) => events.push(step(
                ProvisionStep::SyncBase,
                Status::Done,
                Some(sync_summary(&r, input.base_branch, &pc.database.source)),
            )),
            Err(e) => events.push(step(
                ProvisionStep::SyncBase,
                Status::Warning,
                Some(e.to_string()),
            )),
        }
    }

    // 8b. worktree.
    if worktree_exists {
        events.push(step(ProvisionStep::Worktree, Status::SkippedExisting, None));
    } else {
        git::worktree_add(&pc.path, &worktree_dir, branch, input.base_branch)?;
        events.push(step(ProvisionStep::Worktree, Status::Done, None));
    }

    // 8c. database (clone from pc.database.source).
    if db_exists {
        events.push(step(ProvisionStep::Database, Status::SkippedExisting, None));
    } else {
        database::clone_db(target, &pc.database.source, &names.db_name)?;
        events.push(step(ProvisionStep::Database, Status::Done, None));
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
        },
    )?;
    let change_count: usize = env_changes.iter().map(|r| r.changes.len()).sum();
    events.push(step(
        ProvisionStep::Env,
        Status::Done,
        Some(format!("{change_count} changes")),
    ));

    // 8e. install / generate / migrate (only when configured).
    if let Some(cmd) = &pc.commands.install {
        shell::exec_in_dir(&worktree_dir, cmd, NON_INTERACTIVE_ENV)?;
        events.push(step(ProvisionStep::Install, Status::Done, None));
    }
    if let Some(cmd) = &pc.commands.generate {
        shell::exec_in_dir(&worktree_dir, cmd, NON_INTERACTIVE_ENV)?;
        events.push(step(ProvisionStep::Generate, Status::Done, None));
    }
    if let Some(cmd) = &pc.commands.migrate {
        shell::exec_in_dir(&worktree_dir, cmd, NON_INTERACTIVE_ENV)?;
        events.push(step(ProvisionStep::Migrate, Status::Done, None));
    }

    // 8f. proxy-route.
    if existing_route.is_some() {
        events.push(step(ProvisionStep::ProxyRoute, Status::SkippedExisting, None));
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

pub fn teardown(
    ws: &Workspace,
    pc: &ProjectConfig,
    opts: &TeardownOptions,
) -> Vec<StepEvent<TeardownStep>> {
    let mut events = Vec::new();
    let target = DbTarget::from(&pc.database);

    events.push(match proxy::remove_route(&ws.proxy_domain) {
        Ok(()) => step(TeardownStep::ProxyRoute, Status::Done, None),
        Err(e) => step(TeardownStep::ProxyRoute, Status::Warning, Some(e.to_string())),
    });

    events.push(match database::drop_db(target, &ws.db_name) {
        Ok(()) => step(TeardownStep::Database, Status::Done, None),
        Err(e) => step(TeardownStep::Database, Status::Warning, Some(e.to_string())),
    });

    if opts.remove_worktree {
        // git remove, with a filesystem force-remove fallback: if `git worktree
        // remove` refuses — e.g. uncommitted changes without --force, or corrupt
        // metadata — still clear the dir from disk so no orphan is left behind.
        events.push(match git::worktree_remove(&pc.path, &ws.path, opts.force) {
            Ok(()) => step(TeardownStep::Worktree, Status::Done, None),
            Err(_) => match std::fs::remove_dir_all(&ws.path) {
                Ok(()) => step(
                    TeardownStep::Worktree,
                    Status::Done,
                    Some("removed (force)".to_string()),
                ),
                Err(e) => step(TeardownStep::Worktree, Status::Warning, Some(e.to_string())),
            },
        });

        events.push(match git::delete_branch(&pc.path, &ws.branch) {
            Ok(()) => step(TeardownStep::Branch, Status::Done, None),
            Err(e) => step(TeardownStep::Branch, Status::Warning, Some(e.to_string())),
        });

        if opts.delete_remote_branch {
            events.push(match git::delete_remote_branch(&pc.path, &ws.branch) {
                Ok(()) => step(TeardownStep::RemoteBranch, Status::Done, None),
                Err(e) => step(
                    TeardownStep::RemoteBranch,
                    Status::Warning,
                    Some(e.to_string()),
                ),
            });
        }

        events.push(if claude::remove_project_convo(&ws.path) {
            step(TeardownStep::ClaudeConvos, Status::Done, None)
        } else {
            step(TeardownStep::ClaudeConvos, Status::SkippedExisting, None)
        });
    }

    events
}

// -- reset -------------------------------------------------------------------

pub fn reset_database(
    ws: &Workspace,
    pc: &ProjectConfig,
    fresh: bool,
) -> Result<Vec<StepEvent<ResetStep>>> {
    let mut events = Vec::new();
    let target = DbTarget::from(&pc.database);

    database::drop_db(target, &ws.db_name)?;
    events.push(step(ResetStep::Drop, Status::Done, None));

    if fresh {
        database::create_db(target, &ws.db_name)?;
        events.push(step(ResetStep::Create, Status::Done, None));
    } else {
        database::clone_db(target, &pc.database.source, &ws.db_name)?;
        events.push(step(ResetStep::Clone, Status::Done, None));
    }

    if let Some(cmd) = &pc.commands.migrate {
        shell::exec_in_dir(&ws.path, cmd, NON_INTERACTIVE_ENV)?;
        events.push(step(ResetStep::Migrate, Status::Done, None));
    }

    if fresh {
        if let Some(cmd) = &pc.commands.seed {
            shell::exec_in_dir(&ws.path, cmd, NON_INTERACTIVE_ENV)?;
            events.push(step(ResetStep::Seed, Status::Done, None));
        }
    }

    Ok(events)
}
