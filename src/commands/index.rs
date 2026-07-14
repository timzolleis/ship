use crate::domain::workspace_name::derive_names;
use crate::errors::Result;
use crate::fmt::{blue, bold, dim, green, red, yellow};
use crate::prompt;
use crate::schema::Workspace;
use crate::services::database::{self, DbTarget};
use crate::services::{config, git, proxy};
use crate::util::plural;
use std::collections::HashSet;

// ---------------------------------------------------------------------------
// ship index [project] [--all] [--dry-run] — register pre-existing worktrees
// ---------------------------------------------------------------------------

pub fn run(project: Option<String>, all: bool, dry_run: bool) {
    if let Err(e) = run_inner(project, all, dry_run) {
        eprintln!("\n  {} {}\n", red("Error:"), e);
    }
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
        println!();
        match &project_opt {
            Some(p) => println!("  {} {}", red("Project not found:"), p),
            None => println!("  {}", dim("No projects registered. Run 'ship init' first.")),
        }
        println!();
        return Ok(());
    }

    let existing_workspaces = config::load_workspaces()?;
    let existing_routes = proxy::get_routes().unwrap_or_default();

    let mut total_indexed = 0usize;
    let mut total_skipped = 0usize;
    let mut total_candidates = 0usize;
    let mut used_ports: HashSet<u16> = existing_routes.iter().map(|r| r.port).collect();

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

        let target = DbTarget::from(&project_config.database);
        let container_running = database::ping(target);
        if !container_running {
            println!(
                "  {} Database not reachable — DB existence not verified.",
                yellow("⚠")
            );
        }

        for wt in candidates {
            let names = derive_names(&project_config.worktree, alias, &wt.branch);

            let db_found = container_running && database::exists(target, &names.db_name);

            let route = existing_routes.iter().find(|r| r.domain == names.proxy_domain);
            let port = match route {
                Some(r) => r.port,
                None => {
                    let mut p = proxy::next_port()?;
                    while used_ports.contains(&p) {
                        p += 1;
                    }
                    used_ports.insert(p);
                    p
                }
            };

            println!();
            println!("  {} {}  {}", blue("•"), bold(&wt.branch), dim(&wt.path));
            println!(
                "      DB     {} {}",
                names.db_name,
                if container_running {
                    if db_found {
                        green("(found)")
                    } else {
                        dim("(not found)")
                    }
                } else {
                    dim("(unknown)")
                }
            );
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

            if dry_run {
                println!("      {}", yellow("would index"));
                total_indexed += 1;
                continue;
            }

            let should_index =
                all || prompt::confirm(&format!("Index {}/{}?", alias, wt.branch), true)?;

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
