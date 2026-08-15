use crate::commands::teardown as teardown_ui;
use crate::domain::db_orphans::{self, OrphanQuery};
use crate::domain::workspace_name::resolve_pattern;
use crate::errors::Result;
use crate::fmt::{bold, dim, green, red, yellow};
use crate::prompt;
use crate::schema::{ProjectConfig, Workspace};
use crate::services::agent::{self, SessionDir, WorktreePrefix};
use crate::services::database::{self, DbTarget};
use crate::services::github::{self, Pr};
use crate::services::workspace::TeardownOptions;
use crate::services::{config, sync};
use crate::ui::{Picker, Row, Table, Update};
use crate::util::{plural, resolve_path};
use indexmap::IndexMap;
use std::sync::mpsc;

// ---------------------------------------------------------------------------
// ship gc [--force] [--dry-run] [--sync] | --databases | --sessions
// ---------------------------------------------------------------------------

/// gc tears down harder than `down` does: the branch is merged, so the remote
/// branch goes too and nothing prompts about dirty state.
const GC_TEARDOWN: TeardownOptions = TeardownOptions {
    remove_worktree: true,
    force: true,
    delete_remote_branch: true,
};

#[derive(Clone)]
struct Checked {
    ws: Workspace,
    pr_label: String,
    merged: bool,
}

/// `<project>  <branch>  PR #42 merged 2d ago`
fn row(c: &Checked) -> Row<Checked> {
    Row::new(
        c.clone(),
        [dim(&c.ws.project), bold(&c.ws.branch), c.pr_label.clone()],
    )
    .checked(c.merged)
}

pub fn run(force: bool, dry_run: bool, should_sync: bool, sessions_only: bool, databases: bool) {
    let result = if sessions_only {
        sweep_sessions(force, dry_run).inspect(|()| println!())
    } else if databases {
        sweep_orphans(force, dry_run).inspect(|()| println!())
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

/// Databases left behind by a teardown that never finished, or by a workspace
/// removed outside ship. Its own mode because it pings every project's server,
/// which is too slow to pay for on every `ship gc`.
fn sweep_orphans(force: bool, dry_run: bool) -> Result<()> {
    let projects = config::load_config()?.projects;
    let Scan { orphans, skipped } = collect_orphans(&projects)?;

    println!();
    for warning in &skipped {
        println!("  {} {}", yellow("⚠"), warning);
    }
    if orphans.is_empty() {
        if !skipped.is_empty() {
            println!();
        }
        println!("  {}", dim("No orphaned databases."));
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
    if workspaces.is_empty() {
        println!();
        println!("  {}", dim("No active workspaces."));
        println!();
        return Ok(());
    }
    sweep_workspaces(workspaces, force, dry_run, should_sync)?;
    println!();
    Ok(())
}

/// Merged rows come up checked, everything else unchecked but still listed —
/// a workspace whose PR is still open is fair game if you say so.
fn pick_workspaces(checked: &[Checked]) -> Result<Vec<Checked>> {
    let rows: Vec<Row<Checked>> = checked.iter().map(row).collect();
    let picked = Picker::new("Select workspaces to tear down", rows)
        .multi()
        .interact()?;
    Ok(picked.into_iter().map(|r| r.value).collect())
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

    // The verdict is the preselection, so every PR must be known before the
    // picker opens — no streaming here, unlike `ship down`.
    let checked: Vec<Checked> = github::look_up_all(&workspaces)
        .into_iter()
        .zip(workspaces.iter().cloned())
        .map(|(looked_up, ws)| Checked {
            ws,
            pr_label: github::pr_label(looked_up.pr.as_ref()),
            merged: looked_up.pr.as_ref().map(Pr::is_merged).unwrap_or(false),
        })
        .collect();

    let merged: Vec<Checked> = checked.iter().filter(|c| c.merged).cloned().collect();

    if dry_run {
        println!();
        // The verdict is a column of its own so the PR labels above it stay padded.
        let rows: Vec<Row<()>> = checked
            .iter()
            .map(|c| {
                let verdict = if c.merged {
                    yellow("would tear down")
                } else {
                    dim("keep")
                };
                Row::new(
                    (),
                    [
                        dim(&c.ws.project),
                        bold(&c.ws.branch),
                        c.pr_label.clone(),
                        format!("→ {verdict}"),
                    ],
                )
            })
            .collect();
        let table = Table::measure(&rows);
        for r in &rows {
            println!("  {}", table.line(r, ""));
        }
        println!();
        if merged.is_empty() {
            println!("  {}", dim("Nothing to clean up."));
        } else {
            println!(
                "  {} would clean up {} workspace{}.",
                green("✓"),
                merged.len(),
                plural(merged.len())
            );
        }
        return Ok(());
    }

    let to_clean = if force {
        if merged.is_empty() {
            println!();
            println!("  {}", dim("Nothing to clean up."));
            return Ok(());
        }
        merged
    } else {
        pick_workspaces(&checked)?
    };

    if to_clean.is_empty() {
        println!();
        println!("  {}", dim("Nothing to clean up."));
        return Ok(());
    }

    // One failure must not strand the rest — report it and carry on.
    let total = to_clean.len();
    let mut failures: Vec<(String, String)> = Vec::new();
    for c in &to_clean {
        println!();
        println!("  {}", bold(format!("{}/{}", c.ws.project, c.ws.branch)));
        let name = format!("{}/{}", c.ws.project, c.ws.branch);
        match config::get_project(&c.ws.project)
            .and_then(|pc| teardown_ui::run(&c.ws, &pc, GC_TEARDOWN))
        {
            Ok(true) => {}
            // The checklist already showed which step broke; say what it cost.
            Ok(false) => failures.push((name, "kept in the registry".to_string())),
            Err(e) => {
                println!("  {} {}", red("✗"), dim(e.to_string()));
                failures.push((name, e.to_string()));
            }
        }
    }

    let cleaned = total - failures.len();
    println!();
    for (name, err) in &failures {
        println!("  {} {} {}", yellow("⚠"), name, dim(err));
    }
    println!(
        "  {} Cleaned up {} of {} workspace{}.",
        if failures.is_empty() {
            green("✓")
        } else {
            yellow("⚠")
        },
        cleaned,
        total,
        plural(total)
    );

    // Sync unique projects after cleanup.
    if should_sync && cleaned > 0 {
        let mut projects: Vec<String> = Vec::new();
        for c in &to_clean {
            if !projects.contains(&c.ws.project) {
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
