use crate::domain::workspace_locate::locate_workspace;
use crate::errors::Result;
use crate::fmt::{blue, bold, dim, green, red};
use crate::services::{config, proxy, shell};
use crate::util::cwd_string;

// ---------------------------------------------------------------------------
// ship up [--open]
//
// Locate the current workspace via the pure locator, falling back to a
// registered project root checkout. Ensure the proxy is running and the route
// exists, then run the dev command.
// ---------------------------------------------------------------------------

struct UpTarget {
    project: String,
    domain: String,
    port: u16,
    path: String,
}

pub fn run(open: bool) {
    if let Err(e) = run_inner(&cwd_string(), open) {
        eprintln!("\n  {} {}\n", red("Error:"), e);
    }
}

fn run_inner(cwd: &str, open: bool) -> Result<()> {
    let workspaces = config::load_workspaces()?;

    let target = if let Some(w) = locate_workspace(&workspaces, cwd, None) {
        UpTarget {
            project: w.project.clone(),
            domain: w.proxy_domain.clone(),
            port: w.port,
            path: w.path.clone(),
        }
    } else {
        let ship_config = config::load_config()?;
        let entry = ship_config
            .projects
            .iter()
            .find(|(_, p)| cwd == p.path || cwd.starts_with(&format!("{}/", p.path)));
        let Some((alias, root)) = entry else {
            println!(
                "  {} Not inside a workspace or registered project. Use 'ship init' or 'ship create' first.",
                red("✗")
            );
            return Ok(());
        };
        let alias = alias.clone();
        let domain = root
            .domain
            .clone()
            .unwrap_or_else(|| format!("{alias}.localhost"));
        let port = match root.port {
            Some(p) => p,
            None => {
                // Project registered before root routes existed — allocate and persist.
                let p = proxy::next_port()?;
                let mut updated = root.clone();
                updated.domain = Some(domain.clone());
                updated.port = Some(p);
                config::add_project(&alias, updated)?;
                p
            }
        };
        UpTarget {
            project: alias,
            domain,
            port,
            path: root.path.clone(),
        }
    };

    let project_config = config::get_project(&target.project)?;

    // Ensure proxy is running.
    if !proxy::is_running() {
        proxy::start()?;
        println!("  {} Proxy started.", green("●"));
    }

    // Ensure route exists.
    let _ = proxy::add_route(&target.domain, target.port);

    println!(
        "  {} {} {} localhost:{}",
        green("●"),
        bold(&target.domain),
        dim("→"),
        blue(target.port)
    );

    // Resolve dev command sequence.
    let dev = project_config.commands.dev.clone();
    let Some((last, rest)) = dev.split_last() else {
        println!("  {}", dim("No dev command configured. Proxy route is active."));
        return Ok(());
    };
    let resolved_last = last.replace("{port}", &target.port.to_string());

    // Open browser after a short delay, in the background.
    if open {
        let url = format!("https://{}", target.domain);
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(2));
            let _ = std::process::Command::new("open").arg(&url).output();
        });
    }

    // Run any preparatory dev commands to completion, in order.
    for cmd in rest {
        let resolved = cmd.replace("{port}", &target.port.to_string());
        println!("  {}", dim(format!("Running: {resolved}")));
        shell::exec_in_dir(&target.path, &resolved, &[])?;
    }

    println!("  {}", dim(format!("Running: {resolved_last}")));
    println!();

    // Run the final dev command (blocks until it exits — the dev server).
    shell::exec_in_dir(&target.path, &resolved_last, &[])?;
    Ok(())
}
