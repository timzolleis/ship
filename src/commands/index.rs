use crate::domain::ports as domain_ports;
use crate::domain::workspace_name::derive_names;
use crate::errors::{Error, Result};
use crate::fmt::{blue, bold, dim, green, yellow};
use crate::prompt::{self, Unattended};
use crate::schema::Workspace;
use crate::services::database::{self, DbTarget};
use crate::services::{config, git, ports, proxy};
use crate::util::plural;
use indexmap::IndexMap;
use std::collections::HashSet;
use std::process::ExitCode;

// ---------------------------------------------------------------------------
// ship index [project] [--all] [--dry-run] — register pre-existing worktrees
// ---------------------------------------------------------------------------

pub fn run(project: Option<String>, all: bool, dry_run: bool) -> ExitCode {
    super::finish(run_inner(project, all, dry_run))
}

fn run_inner(project_opt: Option<String>, all: bool, dry_run: bool) -> Result<()> {
    let ship_config = config::load_config()?;
    let project_entries: Vec<(String, crate::schema::ProjectConfig)> = ship_config
        .projects
        .iter()
        .filter(|(alias, _)| project_opt.as_ref().map(|p| p == *alias).unwrap_or(true))
        .map(|(a, p)| (a.clone(), p.clone()))
        .collect();

    if project_entries.is_empty() {
        return Err(match project_opt {
            Some(alias) => Error::ProjectNotFound { alias },
            None => Error::NoProjects,
        });
    }

    let existing_workspaces = config::load_workspaces()?;
    let existing_routes = proxy::get_routes().unwrap_or_default();

    let mut total_indexed = 0usize;
    let mut total_skipped = 0usize;
    let mut total_candidates = 0usize;
    let mut used_ports: HashSet<u16> = ports::used()?;

    println!();

    for (alias, project_config) in &project_entries {
        println!("  {}  {}", bold(alias), dim(&project_config.path));

        let worktrees = git::worktree_list(&project_config.path).unwrap_or_default();

        let registered_paths: HashSet<&str> = existing_workspaces
            .iter()
            .filter(|w| &w.project == alias)
            .map(|w| w.path.as_str())
            .collect();
        let registered_branches: HashSet<&str> = existing_workspaces
            .iter()
            .filter(|w| &w.project == alias)
            .map(|w| w.branch.as_str())
            .collect();
        let candidates: Vec<_> = worktrees
            .iter()
            .filter(|wt| {
                wt.path != project_config.path
                    && !registered_paths.contains(wt.path.as_str())
                    && !registered_branches.contains(wt.branch.as_str())
            })
            .collect();

        if candidates.is_empty() {
            println!("  {}", dim("  Nothing to index."));
            println!();
            continue;
        }

        total_candidates += candidates.len();

        // None: the project has no database, so there is nothing to verify.
        let target = project_config.database.as_ref().map(DbTarget::from);
        let reachable = target.map(database::ping);
        if reachable == Some(false) {
            println!(
                "  {} Database not reachable — DB existence not verified.",
                yellow("⚠")
            );
        }

        for wt in candidates {
            let names = derive_names(
                &project_config.worktree,
                project_config.database.as_ref(),
                alias,
                &wt.branch,
            );

            let db_line = match (&names.db_name, target, reachable) {
                (Some(name), Some(t), Some(true)) => format!(
                    "{name} {}",
                    if database::exists(t, name) {
                        green("(found)")
                    } else {
                        dim("(not found)")
                    }
                ),
                (Some(name), ..) => format!("{name} {}", dim("(unknown)")),
                (None, ..) => dim("(no database)"),
            };

            let route = existing_routes
                .iter()
                .find(|r| r.domain == names.proxy_domain);
            let port = match route {
                Some(r) => r.port,
                None => {
                    let p = domain_ports::next_free(&used_ports, domain_ports::BASE_PORT);
                    used_ports.insert(p);
                    p
                }
            };
            let named_ports =
                domain_ports::assign(&project_config.ports, &IndexMap::new(), &mut used_ports);

            println!();
            println!("  {} {}  {}", blue("•"), bold(&wt.branch), dim(&wt.path));
            println!("      DB     {db_line}");
            println!(
                "      Proxy  https://{} → :{} {}",
                names.proxy_domain,
                port,
                if route.is_some() {
                    green("(route exists)")
                } else {
                    dim("(no route)")
                }
            );

            for (name, p) in &named_ports {
                println!("      Port   {name} :{p}");
            }

            if dry_run {
                println!("      {}", yellow("would index"));
                total_indexed += 1;
                continue;
            }

            let should_index = all
                || prompt::confirm(
                    &format!("Index {}/{}?", alias, wt.branch),
                    true,
                    Unattended::Require("--all"),
                )?;

            if !should_index {
                println!("      {}", dim("skipped"));
                total_skipped += 1;
                continue;
            }

            config::add_workspace(Workspace {
                project: alias.clone(),
                branch: wt.branch.clone(),
                path: wt.path.clone(),
                port,
                ports: named_ports,
                db_name: names.db_name.clone(),
                proxy_domain: names.proxy_domain.clone(),
                created: chrono::Utc::now().format("%Y-%m-%d").to_string(),
            })?;
            println!("      {} indexed", green("✓"));
            total_indexed += 1;
        }

        println!();
    }

    if total_candidates == 0 {
        println!("  {}", dim("Nothing to index."));
        println!();
        return Ok(());
    }

    if dry_run {
        println!(
            "  {}",
            dim(format!(
                "Would index {} workspace{}.",
                total_indexed,
                plural(total_indexed)
            ))
        );
    } else {
        let skipped_label = if total_skipped > 0 {
            format!(" {}", dim(format!("({total_skipped} skipped)")))
        } else {
            String::new()
        };
        println!(
            "  {} Indexed {} workspace{}.{}",
            green("✓"),
            total_indexed,
            plural(total_indexed),
            skipped_label
        );
        if total_indexed > 0 {
            println!("  {}", dim("Run 'ship gc' to clean up merged PRs."));
        }
    }
    println!();
    Ok(())
}
