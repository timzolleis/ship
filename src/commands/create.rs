use crate::domain::workspace_name::derive_names;
use crate::errors::{Error, Result};
use crate::fmt::{blue, bold, dim, green, red, yellow};
use crate::prompt;
use crate::services::env::PatchResult;
use crate::services::workspace::{
    provision, ProvisionInput, ProvisionStep, Status, StepEvent,
};
use crate::services::{config, editor};
use crate::util::resolve_path;

// ---------------------------------------------------------------------------
// Pure rendering — turns provision events (and env changes) into console lines.
// ---------------------------------------------------------------------------

struct RenderContext {
    branch: String,
    worktree_dir: String,
    db_name: String,
    source: String,
    proxy_domain: String,
    port: u16,
}

/// Shorten a URL/db value for the env-change diff column.
fn abbreviate_value(value: &str) -> String {
    if let Some(idx) = value.find("://") {
        let rest = &value[idx + 3..];
        let (authority, path) = match rest.find('/') {
            Some(i) => (&rest[..i], &rest[i..]),
            None => (rest, ""),
        };
        let host_port = authority.rsplit('@').next().unwrap_or(authority);
        let hostname = host_port.split(':').next().unwrap_or(host_port);
        let path_part = if path == "/" { "" } else { path };
        return format!("{hostname}{path_part}");
    }
    if let Some(idx) = value.rfind('/') {
        let tail = &value[idx + 1..];
        if !tail.is_empty() {
            return tail.to_string();
        }
    }
    if value.len() > 40 {
        format!("{}...", &value[..37])
    } else {
        value.to_string()
    }
}

fn ok_line(label: &str, detail: &str) -> String {
    format!("  {} {:<14} {}", green("✓"), label, detail)
}

fn skip_line(label: &str, detail: &str) -> String {
    format!("  {} {:<14} {} {}", dim("•"), label, detail, dim("(already present)"))
}

fn warn_line(label: &str, detail: &str) -> String {
    format!("  {} {:<14} {}", yellow("⚠"), label, dim(detail))
}

fn render_event(e: &StepEvent<ProvisionStep>, ctx: &RenderContext) -> Vec<String> {
    match e.step {
        ProvisionStep::Probe => vec![format!("  {} Resuming partial setup...", yellow("↻"))],
        ProvisionStep::SyncBase => {
            if e.status == Status::Warning {
                return vec![warn_line("Base sync", e.detail.as_deref().unwrap_or(""))];
            }
            if e.status != Status::Done {
                return vec![];
            }
            let detail = e.detail.as_deref().unwrap_or("");
            if detail.is_empty() {
                return vec![];
            }
            if detail == "already up to date" {
                return vec![dim("  · Base           already up to date")];
            }
            // detail = "<label> fast-forwarded" optionally "; migrated <source>"
            let (updated, migrated) = match detail.split_once("; migrated ") {
                Some((u, m)) => (u, Some(m)),
                None => (detail, None),
            };
            let mut lines = vec![ok_line("Base updated", updated)];
            if let Some(m) = migrated {
                lines.push(ok_line("Base migrated", m));
            }
            lines
        }
        ProvisionStep::Worktree => {
            if e.status == Status::SkippedExisting {
                vec![
                    skip_line("Branch", &ctx.branch),
                    skip_line("Worktree", &dim(&ctx.worktree_dir)),
                ]
            } else {
                vec![
                    ok_line("Branch", &bold(&ctx.branch)),
                    ok_line("Worktree", &dim(&ctx.worktree_dir)),
                ]
            }
        }
        ProvisionStep::Database => {
            if e.status == Status::SkippedExisting {
                vec![skip_line("Database", &bold(&ctx.db_name))]
            } else {
                vec![ok_line(
                    "Database",
                    &format!(
                        "{} {}",
                        bold(&ctx.db_name),
                        dim(format!("(cloned from {})", ctx.source))
                    ),
                )]
            }
        }
        ProvisionStep::Install => vec![ok_line("Dependencies", "installed")],
        ProvisionStep::Migrate => vec![ok_line("Migrations", "applied")],
        ProvisionStep::ProxyRoute => {
            let route = format!("https://{} → :{}", bold(&ctx.proxy_domain), blue(ctx.port));
            match e.status {
                Status::Warning => vec![warn_line("Proxy", e.detail.as_deref().unwrap_or(""))],
                Status::SkippedExisting => vec![format!(
                    "  {} {:<14} {} {}",
                    dim("•"),
                    "Proxy",
                    route,
                    dim("(already present)")
                )],
                Status::Done => vec![format!("  {} {:<14} {}", green("✓"), "Proxy", route)],
            }
        }
        _ => vec![],
    }
}

fn render_env_changes(results: &[PatchResult]) -> Vec<String> {
    let mut lines = Vec::new();
    for result in results {
        if result.changes.is_empty() {
            continue;
        }
        lines.push(format!("    {}:", blue(&result.file)));
        for change in &result.changes {
            lines.push(format!(
                "      {} {} → {}",
                dim(format!("{:<25}", change.key)),
                abbreviate_value(&change.from),
                abbreviate_value(&change.to)
            ));
        }
    }
    lines
}

// ---------------------------------------------------------------------------
// ship create [project] [branch] [--base <branch>]
// ---------------------------------------------------------------------------

pub fn run(project: Option<String>, branch: Option<String>, base: Option<String>) {
    match run_inner(project, branch, base) {
        Ok(()) => {}
        Err(e @ Error::DatabaseUnreachable { .. }) => {
            println!();
            println!("  {} {}", red("✗"), e);
            println!("    Start it first, then run this command again.");
            println!();
        }
        Err(e) => eprintln!("\n  {} {}\n", red("Error:"), e),
    }
}

fn run_inner(
    project_opt: Option<String>,
    branch_opt: Option<String>,
    base: Option<String>,
) -> Result<()> {
    // 1. Resolve project (prompt if not specified).
    let project = match project_opt {
        Some(p) => p,
        None => {
            let ship_config = config::load_config()?;
            if ship_config.projects.is_empty() {
                println!();
                println!("  {} No projects registered.", red("✗"));
                println!("  {}", dim("Register one with: ship init"));
                println!();
                return Ok(());
            }
            let aliases: Vec<String> = ship_config.projects.keys().cloned().collect();
            let items: Vec<String> = ship_config
                .projects
                .iter()
                .map(|(alias, p)| format!("{alias}  {}", dim(&p.path)))
                .collect();
            let idx = prompt::select("Select a project", &items)?;
            aliases[idx].clone()
        }
    };
    let project_config = config::get_project(&project)?;

    // 2. Resolve branch.
    let branch = match branch_opt {
        Some(b) => b,
        None => prompt::input("Branch name:", None)?,
    };

    // Render context (derived names — single source of truth in domain).
    let names = derive_names(&project_config.worktree, &project, &branch);
    let worktree_dir = resolve_path(&project_config.path, &names.worktree_dir_relative);

    println!();

    // 3. Provision.
    let outcome = provision(&ProvisionInput {
        project_alias: &project,
        project_config: &project_config,
        branch: &branch,
        base_branch: base.as_deref(),
    })?;

    let ctx = RenderContext {
        branch: branch.clone(),
        worktree_dir,
        db_name: names.db_name.clone(),
        source: project_config.database.source.clone(),
        proxy_domain: names.proxy_domain.clone(),
        port: outcome.workspace.port,
    };
    for event in &outcome.events {
        for line in render_event(event, &ctx) {
            println!("{line}");
        }
    }

    // Already fully provisioned → short-circuit message + open prompt.
    if outcome.already_complete {
        let w = &outcome.workspace;
        println!("  Already exists: {} in {}", bold(&w.branch), dim(&w.path));
        println!(
            "  Proxy: {} → :{}",
            blue(format!("https://{}", w.proxy_domain)),
            w.port
        );
        println!();
        if prompt::confirm("Open in editor?", true)? {
            editor::open(&w.path);
        }
        return Ok(());
    }

    // Env changes (rendered from the result).
    let env_lines = render_env_changes(&outcome.env_changes);
    if !env_lines.is_empty() {
        println!();
        println!("  Configuring environment...");
        for line in env_lines {
            println!("{line}");
        }
    }

    // 4. Auto-open editor (prompt once; persist preference).
    println!();
    let mut ship_config = config::load_config()?;
    let should_open = match ship_config.auto_open_editor {
        Some(v) => v,
        None => {
            let v = prompt::confirm("Open workspace in editor?", true)?;
            ship_config.auto_open_editor = Some(v);
            config::save_config(&ship_config)?;
            v
        }
    };
    if should_open {
        editor::open(&outcome.workspace.path);
    }

    println!("  {}", green("Ready."));
    println!();
    Ok(())
}
