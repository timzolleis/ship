use crate::domain::db_orphans::{self, OrphanQuery};
use crate::domain::workspace_name::resolve_pattern;
use crate::errors::Result;
use crate::fmt::{bold, dim, green, red, yellow};
use crate::prompt;
use crate::schema::{ProjectConfig, Workspace};
use crate::services::agent::{self, SessionDir, WorktreePrefix};
use crate::services::database::{self, DbTarget};
use crate::services::github::{self, Pr};
use crate::services::workspace::{teardown, TeardownOptions};
use crate::services::{config, sync};
use crate::ui::{Picker, Row, Table, Update};
use crate::util::{plural, resolve_path};
use indexmap::IndexMap;
use std::collections::HashSet;
use std::sync::mpsc;

// ---------------------------------------------------------------------------
// ship gc [--force] [--dry-run] [--sync]
// ---------------------------------------------------------------------------

struct Checked {
    ws: Workspace,
    project_config: Option<ProjectConfig>,
    pr: Option<Pr>,
    pr_label: String,
}

/// Tear down each cleaned workspace (worktree + branch + remote branch,
/// forced), then write the workspace registry exactly once to avoid
/// read-modify-write races. Returns the number removed from the registry.
fn gc_cleanup(to_clean: &[&Checked]) -> Result<usize> {
    for c in to_clean {
        if let Some(pc) = &c.project_config {
            let _ = teardown(
                &c.ws,
                pc,
                &TeardownOptions {
                    remove_worktree: true,
                    force: true,
                    delete_remote_branch: true,
                },
            );
        }
    }

    if to_clean.is_empty() {
        return Ok(0);
    }

    let removed: HashSet<(String, String)> = to_clean
        .iter()
        .map(|c| (c.ws.project.clone(), c.ws.branch.clone()))
        .collect();
    let current = config::load_workspaces()?;
    let filtered: Vec<Workspace> = current
        .into_iter()
        .filter(|w| !removed.contains(&(w.project.clone(), w.branch.clone())))
        .collect();
    config::save_workspaces(&filtered)?;
    Ok(to_clean.len())
}

/// `<project>  <branch>  PR #42 merged 2d ago  → keep`. The verdict is last,
/// so measuring the table before verdicts are known still lines up.
fn row(c: &Checked, verdict: &str) -> Row<()> {
    Row::new(
        (),
        [
            dim(&c.ws.project),
            bold(&c.ws.branch),
            c.pr_label.clone(),
            format!("→ {verdict}"),
        ],
    )
}

fn line(table: &Table, c: &Checked, verdict: &str) -> String {
    format!("  {}", table.line(&row(c, verdict), ""))
}

pub fn run(force: bool, dry_run: bool, should_sync: bool, sessions_only: bool) {
    let result = if sessions_only {
        sweep_sessions(force, dry_run).inspect(|()| println!())
    } else {
        run_inner(force, dry_run, should_sync)
    };
    if let Err(e) = result {
        eprintln!("\n  {} {}\n", red("Error:"), e);
    }
}

// ---------------------------------------------------------------------------
// Orphaned agent sessions — transcripts under a project's worktree directory
// whose path is gone
// ---------------------------------------------------------------------------

/// Everything a worktree path for this project starts with: the dir pattern up
/// to its first placeholder, resolved against the project root.
fn worktree_prefix(alias: &str, pc: &ProjectConfig) -> WorktreePrefix {
    let pattern = resolve_pattern(&pc.worktree.dir_pattern, &[("project", alias)]);
    let head = pattern.split('{').next().unwrap_or_default();
    WorktreePrefix::new(&resolve_path(&pc.path, head))
}

fn session_row(s: &SessionDir) -> Row<SessionDir> {
    Row::new(s.clone(), [dim(s.harness), bold(&s.name)])
}

fn sweep_sessions(force: bool, dry_run: bool) -> Result<()> {
    let projects = config::load_config()?.projects;
    let prefixes: Vec<WorktreePrefix> = projects
        .iter()
        .map(|(alias, pc)| worktree_prefix(alias, pc))
        .collect();
    let orphans = agent::orphans(&prefixes);

    println!();
    if orphans.is_empty() {
        println!("  {}", dim("No orphaned agent sessions."));
        return Ok(());
    }

    let count = orphans.len();
    println!(
        "  {} orphaned agent session{} \u{2014} {}.",
        count,
        plural(count),
        if count == 1 {
            "its worktree is gone"
        } else {
            "their worktrees are gone"
        }
    );
    println!();

    let rows: Vec<Row<SessionDir>> = orphans.iter().map(session_row).collect();
    if dry_run {
        let table = Table::measure(&rows);
        for r in &rows {
            println!("  {} {}", table.line(r, ""), yellow("→ would delete"));
        }
        return Ok(());
    }

    let picked: Vec<SessionDir> = if force {
        orphans
    } else {
        Picker::new("Select sessions to delete", rows)
            .multi()
            .interact()?
            .into_iter()
            .map(|r| r.value)
            .collect()
    };
    if picked.is_empty() {
        println!("  Cancelled.");
        return Ok(());
    }

    let n = picked.len();
    if !force && !prompt::confirm(&format!("Delete {} session{}?", n, plural(n)), false)? {
        println!("  Cancelled.");
        return Ok(());
    }

    let mut deleted = 0;
    for s in &picked {
        if agent::remove(s) {
            deleted += 1;
            println!("  {} Deleted {} {}", green("✓"), s.name, dim(s.harness));
        } else {
            println!("  {} {} {}", yellow("⚠"), s.name, dim("could not delete"));
        }
    }

    println!();
    println!(
        "  {} Deleted {} of {} session{}.",
        if deleted == n { green("✓") } else { yellow("⚠") },
        deleted,
        n,
        plural(n)
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// Orphaned databases — match a project's name pattern, claimed by no workspace
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct Orphan {
    project: String,
    db: String,
}

/// Column the streamed size lands in, after project and database name.
const SIZE_COLUMN: usize = 2;

/// Orphans plus the projects that could not be scanned. Warnings are returned
/// rather than printed so one place decides the section's spacing.
struct Scan {
    orphans: Vec<Orphan>,
    skipped: Vec<String>,
}

/// Every project's database server, scanned once. A server that is down is
/// skipped — a stopped container is not evidence of an orphan.
fn collect_orphans(projects: &IndexMap<String, ProjectConfig>) -> Result<Scan> {
    let claimed: Vec<String> = config::load_workspaces()?
        .into_iter()
        .map(|w| w.db_name)
        .collect();

    let mut found = Vec::new();
    let mut skipped = Vec::new();
    for (alias, pc) in projects {
        let target = DbTarget::from(&pc.database);
        if !database::ping(target) {
            skipped.push(format!(
                "{} {}",
                bold(alias),
                dim("database unreachable — skipped")
            ));
            continue;
        }
        let listed = match database::list(target) {
            Ok(listed) => listed,
            Err(e) => {
                skipped.push(format!("{} {}", bold(alias), dim(e.to_string())));
                continue;
            }
        };
        let pattern = resolve_pattern(&pc.worktree.db_name_pattern, &[("project", alias)]);
        let query = OrphanQuery {
            db_name_pattern: &pattern,
            source: &pc.database.source,
            claimed: &claimed,
        };
        found.extend(db_orphans::find(query, &listed).into_iter().map(|db| Orphan {
            project: alias.clone(),
            db,
        }));
    }
    Ok(Scan {
        orphans: found,
        skipped,
    })
}

/// One size lookup per orphan, merged into a single stream keyed by row index.
/// Each project has its own runtime, so the lookups cannot share one call.
fn size_stream(
    orphans: &[Orphan],
    projects: &IndexMap<String, ProjectConfig>,
) -> mpsc::Receiver<(usize, String)> {
    let (tx, rx) = mpsc::channel();
    for (alias, pc) in projects {
        let rows: Vec<usize> = orphans
            .iter()
            .enumerate()
            .filter(|(_, o)| &o.project == alias)
            .map(|(i, _)| i)
            .collect();
        if rows.is_empty() {
            continue;
        }
        let dbs = rows.iter().map(|i| orphans[*i].db.clone()).collect();
        let inner = database::size_stream(DbTarget::from(&pc.database), dbs);
        let tx = tx.clone();
        std::thread::spawn(move || {
            for (local, size) in inner {
                let _ = tx.send((rows[local], size));
            }
        });
    }
    rx
}

fn orphan_row(o: &Orphan, size: Option<&str>) -> Row<Orphan> {
    let cells = [dim(&o.project), bold(&o.db)];
    match size {
        Some(size) => Row::new(o.clone(), cells.into_iter().chain([size.to_string()])),
        None => Row::new(o.clone(), cells).pending(),
    }
}

/// Checkbox picker over the orphans, then one confirm for the whole set —
/// same shape as `ship down`. Nothing is checked by default.
fn pick_orphans(
    orphans: &[Orphan],
    projects: &IndexMap<String, ProjectConfig>,
) -> Result<Vec<Orphan>> {
    let sizes = size_stream(orphans, projects);
    let rows = orphans.iter().map(|o| orphan_row(o, None)).collect();

    let picked = Picker::new("Select databases to drop", rows)
        .multi()
        .stream(sizes, |(i, size): (usize, String)| {
            Update::new(i, SIZE_COLUMN, dim(size))
        })
        .interact()?;

    Ok(picked.into_iter().map(|r| r.value).collect())
}

/// gc makes these itself: `gc_cleanup` swallows teardown errors, so a drop
/// that failed still loses its registry entry. Runs after cleanup so a failure
/// from this same run is caught.
fn sweep_orphans(force: bool, dry_run: bool) -> Result<()> {
    let projects = config::load_config()?.projects;
    let Scan { orphans, skipped } = collect_orphans(&projects)?;

    if orphans.is_empty() && skipped.is_empty() {
        return Ok(());
    }

    println!();
    for warning in &skipped {
        println!("  {} {}", yellow("⚠"), warning);
    }
    if orphans.is_empty() {
        return Ok(());
    }
    if !skipped.is_empty() {
        println!();
    }

    let count = orphans.len();
    println!(
        "  {} orphaned database{} — no workspace claims {}.",
        count,
        plural(count),
        if count == 1 { "it" } else { "them" }
    );
    println!();

    if dry_run {
        let rows: Vec<Row<Orphan>> = orphans.iter().map(|o| orphan_row(o, None)).collect();
        let table = Table::measure(&rows);
        for r in &rows {
            println!("  {} {}", table.line(r, ""), yellow("→ would drop"));
        }
        return Ok(());
    }

    let picked = if force {
        orphans
    } else {
        pick_orphans(&orphans, &projects)?
    };
    if picked.is_empty() {
        println!("  Cancelled.");
        return Ok(());
    }

    let n = picked.len();
    if !force && !prompt::confirm(&format!("Drop {} database{}?", n, plural(n)), false)? {
        println!("  Cancelled.");
        return Ok(());
    }

    // One failure must not strand the rest.
    let mut dropped = 0;
    for o in &picked {
        let result = config::get_project(&o.project)
            .and_then(|pc| database::drop_db(DbTarget::from(&pc.database), &o.db));
        match result {
            Ok(()) => {
                dropped += 1;
                println!("  {} Dropped {}", green("✓"), o.db);
            }
            Err(e) => println!("  {} {} {}", yellow("⚠"), o.db, dim(e.to_string())),
        }
    }

    println!();
    println!(
        "  {} Dropped {} of {} database{}.",
        if dropped == n { green("✓") } else { yellow("⚠") },
        dropped,
        n,
        plural(n)
    );
    Ok(())
}

fn run_inner(force: bool, dry_run: bool, should_sync: bool) -> Result<()> {
    let workspaces = config::load_workspaces()?;

    // An empty registry is not an early exit — that is exactly the state where
    // orphaned databases pile up.
    if workspaces.is_empty() {
        println!();
        println!("  {}", dim("No active workspaces."));
    } else {
        sweep_workspaces(workspaces, force, dry_run, should_sync)?;
    }

    sweep_orphans(force, dry_run)?;
    println!();
    Ok(())
}

fn sweep_workspaces(
    workspaces: Vec<Workspace>,
    force: bool,
    dry_run: bool,
    should_sync: bool,
) -> Result<()> {
    println!();
    println!(
        "  Checking {} workspace{}...",
        workspaces.len(),
        plural(workspaces.len())
    );

    // Phase 1: check all PR statuses in parallel (gh pr view per workspace).
    let checked: Vec<Checked> = github::look_up_all(&workspaces)
        .into_iter()
        .zip(workspaces.iter().cloned())
        .map(|(looked_up, ws)| Checked {
            ws,
            project_config: looked_up.project_config,
            pr_label: github::pr_label(looked_up.pr.as_ref()),
            pr: looked_up.pr,
        })
        .collect();

    println!();

    // Phase 2: display results and prompt for cleanup.
    let is_merged = |c: &&Checked| c.pr.as_ref().map(Pr::is_merged).unwrap_or(false);
    let merged: Vec<&Checked> = checked.iter().filter(is_merged).collect();
    let kept: Vec<&Checked> = checked.iter().filter(|c| !is_merged(c)).collect();

    let all_rows: Vec<Row<()>> = checked.iter().map(|c| row(c, "")).collect();
    let table = Table::measure(&all_rows);

    for c in &kept {
        println!("{}", line(&table, c, &dim("keep")));
    }

    let cleaned: usize;

    if merged.is_empty() {
        println!();
        println!("  {}", dim("Nothing to clean up."));
        return Ok(());
    }

    if dry_run {
        for c in &merged {
            println!("{}", line(&table, c, &yellow("would tear down")));
        }
        cleaned = merged.len();
    } else {
        // Collect approvals serially (prompts must be sequential) before any teardown.
        let to_clean: Vec<&Checked> = if force {
            merged.clone()
        } else {
            let mut approved = Vec::new();
            for c in &merged {
                let ok = prompt::confirm(
                    &format!(
                        "{}/{} — {}. Tear down?",
                        c.ws.project, c.ws.branch, c.pr_label
                    ),
                    false,
                )?;
                if ok {
                    approved.push(*c);
                } else {
                    println!("{}", line(&table, c, &dim("skipped")));
                }
            }
            approved
        };

        cleaned = gc_cleanup(&to_clean)?;

        for c in &to_clean {
            println!("{}", line(&table, c, &green("cleaned up")));
        }
    }

    println!();
    if cleaned > 0 {
        let verb = if dry_run {
            "would clean up"
        } else {
            "cleaned up"
        };
        println!(
            "  {} {} {} workspace{}.",
            green("✓"),
            verb,
            cleaned,
            plural(cleaned)
        );
    } else {
        println!("  {}", dim("Nothing to clean up."));
    }

    // Sync unique projects after cleanup.
    if should_sync && !dry_run && cleaned > 0 {
        let mut projects: Vec<String> = Vec::new();
        for c in &merged {
            if c.project_config.is_some() && !projects.contains(&c.ws.project) {
                projects.push(c.ws.project.clone());
            }
        }
        for project in projects {
            let project_config = config::get_project(&project)?;
            println!("  Syncing {}...", bold(&project));
            match sync::sync(&project_config, None) {
                Err(e) => println!("  {} Sync failed    {}", yellow("⚠"), dim(e.to_string())),
                Ok(result) => {
                    if result.head_moved {
                        println!(
                            "  {} Base updated   {}",
                            green("✓"),
                            dim("main fast-forwarded")
                        );
                        if result.migrated {
                            println!(
                                "  {} Base migrated  {}",
                                green("✓"),
                                dim(&project_config.database.source)
                            );
                        }
                    } else if let Some(skipped) = &result.skipped_pull {
                        println!("  {} Skipped pull   {}", yellow("⚠"), dim(skipped));
                    } else {
                        println!("  {}", dim("  · Base           already up to date"));
                    }
                }
            }
        }
    }

    Ok(())
}
