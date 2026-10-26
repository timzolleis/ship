use crate::domain::editor_launch::{self, EditorLaunch};
use crate::domain::ports as domain_ports;
use crate::domain::workspace_name::derive_names;
use crate::errors::{Error, Result};
use crate::fmt::{blue, bold, dim, green, red, yellow};
use crate::prompt::{self, Unattended};
use crate::services::env::PatchResult;
use crate::services::workspace::{provision, ProvisionInput, ProvisionStep, Status, StepEvent};
use crate::services::{config, editor};
use crate::ui::{self, Row, Table};
use crate::util::resolve_path;
use std::process::ExitCode;

// ---------------------------------------------------------------------------
// Pure rendering — turns provision events (and env changes) into console lines.
// ---------------------------------------------------------------------------

struct RenderContext {
    branch: String,
    worktree_dir: String,
    /// Workspace database and the source it clones; None without a database.
    database: Option<(String, String)>,
    proxy_domain: String,
    port: u16,
    ports: indexmap::IndexMap<String, u16>,
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
    format!(
        "  {} {:<14} {} {}",
        dim("•"),
        label,
        detail,
        dim("(already present)")
    )
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
            // detail = the fetched ref the branch starts from, e.g. origin/main
            match e.detail.as_deref() {
                Some(base) if !base.is_empty() => {
                    vec![ok_line("Base", &format!("{} {}", base, dim("(fetched)")))]
                }
                _ => vec![],
            }
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
            let Some((db_name, source)) = &ctx.database else {
                return vec![];
            };
            if e.status == Status::SkippedExisting {
                vec![skip_line("Database", &bold(db_name))]
            } else {
                vec![ok_line(
                    "Database",
                    &format!(
                        "{} {}",
                        bold(db_name),
                        dim(format!("(cloned from {source})"))
                    ),
                )]
            }
        }
        ProvisionStep::Copy => {
            let detail = e.detail.as_deref().unwrap_or("");
            match e.status {
                Status::Warning => vec![warn_line("Local files", detail)],
                Status::SkippedExisting => vec![skip_line("Local files", "")],
                Status::Done => vec![ok_line("Local files", &dim(detail))],
            }
        }
        ProvisionStep::Install => vec![ok_line("Dependencies", "installed")],
        ProvisionStep::Db => vec![ok_line("Database setup", "applied")],
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
            .into_iter()
            .chain(ctx.ports.iter().map(|(name, port)| {
                ok_line(&domain_ports::env_name(name), &format!(":{}", blue(port)))
            }))
            .collect()
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
        let rows: Vec<Row<()>> = result
            .changes
            .iter()
            .map(|change| {
                let values = format!(
                    "{} → {}",
                    abbreviate_value(&change.from),
                    abbreviate_value(&change.to)
                );
                Row::new((), [dim(&change.key), values])
            })
            .collect();
        let table = Table::measure(&rows);
        lines.extend(rows.iter().map(|r| format!("      {}", table.line(r, ""))));
    }
    lines
}

// ---------------------------------------------------------------------------
// ship create [project] [branch] [--base <branch>] [--editor|--no-editor]
// ---------------------------------------------------------------------------

/// `editor` is `--editor` (Some(true)) / `--no-editor` (Some(false)).
pub fn run(
    project: Option<String>,
    branch: Option<String>,
    base: Option<String>,
    editor: Option<bool>,
) -> ExitCode {
    match run_inner(project, branch, base, editor) {
        Err(e @ Error::DatabaseUnreachable { .. }) => {
            eprintln!();
            eprintln!("  {} {}", red("✗"), e);
            eprintln!("    Start it first, then run this command again.");
            eprintln!();
            ExitCode::FAILURE
        }
        result => super::finish(result),
    }
}

fn run_inner(
    project_opt: Option<String>,
    branch_opt: Option<String>,
    base: Option<String>,
    editor_flag: Option<bool>,
) -> Result<()> {
    // 1. Resolve project (prompt if not specified).
    let project = match project_opt {
        Some(p) => p,
        None => {
            let ship_config = config::load_config()?;
            if ship_config.projects.is_empty() {
                return Err(Error::NoProjects);
            }
            let rows = ship_config
                .projects
                .iter()
                .map(|(alias, p)| Row::new(alias.clone(), [bold(alias), dim(&p.path)]))
                .collect();
            prompt::pick(
                "Select a project",
                &["PROJECT", "PATH"],
                rows,
                "<project> <branch>",
            )?
        }
    };
    let project_config = config::get_project(&project)?;

    // 2. Resolve branch.
    let branch = match branch_opt {
        Some(b) => b,
        None => prompt::input("Branch name:", None, "<branch>")?,
    };

    // Render context (derived names — single source of truth in domain).
    let names = derive_names(
        &project_config.worktree,
        project_config.database.as_ref(),
        &project,
        &branch,
    );
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
        database: names
            .db_name
            .clone()
            .zip(project_config.database.as_ref().map(|d| d.source.clone())),
        proxy_domain: names.proxy_domain.clone(),
        port: outcome.workspace.port,
        ports: outcome.workspace.ports.clone(),
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
        for (name, port) in &w.ports {
            println!("  {}: :{port}", domain_ports::env_name(name));
        }
        println!();
        // A resumed workspace always asks; the stored preference is for new ones.
        let open = match editor_launch::decide(editor_flag, None, ui::interactive()) {
            EditorLaunch::Open => true,
            EditorLaunch::Skip => false,
            EditorLaunch::Ask => {
                prompt::confirm("Open in editor?", true, Unattended::Answer(false))?
            }
        };
        if open {
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

    // 4. Editor: the flag wins; otherwise only a terminal session opens it
    // (prompt once, persist the answer). Unattended runs store nothing.
    println!();
    let mut ship_config = config::load_config()?;
    let launch =
        editor_launch::decide(editor_flag, ship_config.auto_open_editor, ui::interactive());
    let should_open = match launch {
        EditorLaunch::Open => true,
        EditorLaunch::Skip => false,
        EditorLaunch::Ask => {
            let v = prompt::confirm("Open workspace in editor?", true, Unattended::Answer(false))?;
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
