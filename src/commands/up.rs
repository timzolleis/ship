use crate::domain::ports as domain_ports;
use crate::domain::workspace_locate::locate_workspace;
use crate::errors::{Error, Result};
use crate::fmt::{blue, bold, dim, green};
use crate::services::{config, ports, proxy, shell};
use crate::util::cwd_string;
use indexmap::IndexMap;
use std::process::ExitCode;

// ---------------------------------------------------------------------------
// ship up [--open]
//
// Locate the current workspace via the pure locator, falling back to a
// registered project root checkout. Ensure the proxy is running and the route
// exists, then run the dev command with PORT, one <NAME>_PORT per named port,
// and `{port}` / `{port:<name>}` substituted.
// ---------------------------------------------------------------------------

struct UpTarget {
    project: String,
    domain: String,
    port: u16,
    /// The project's named ports, with this checkout's values.
    ports: IndexMap<String, u16>,
    path: String,
}

pub fn run(open: bool) -> ExitCode {
    super::finish(run_inner(&cwd_string(), open))
}

fn run_inner(cwd: &str, open: bool) -> Result<()> {
    let workspaces = config::load_workspaces()?;

    let target = if let Some(w) = locate_workspace(&workspaces, cwd, None) {
        let project_config = config::get_project(&w.project)?;
        ports::check(&project_config)?;
        // A port named after the workspace was created gets its value now.
        let mut used = ports::used()?;
        let named = domain_ports::assign(&project_config.ports, &w.ports, &mut used);
        if named != w.ports {
            config::update_workspace(&crate::schema::Workspace {
                ports: named.clone(),
                ..w.clone()
            })?;
        }
        UpTarget {
            project: w.project.clone(),
            domain: w.proxy_domain.clone(),
            port: w.port,
            ports: named,
            path: w.path.clone(),
        }
    } else {
        let ship_config = config::load_config()?;
        let entry = ship_config
            .projects
            .iter()
            .find(|(_, p)| cwd == p.path || cwd.starts_with(&format!("{}/", p.path)));
        let Some((alias, root)) = entry else {
            return Err(Error::NotInProject);
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
                let p = ports::next_free()?;
                let mut updated = root.clone();
                updated.domain = Some(domain.clone());
                updated.port = Some(p);
                config::add_project(&alias, updated)?;
                p
            }
        };
        ports::check(root)?;
        UpTarget {
            project: alias,
            domain,
            port,
            ports: root.ports.clone(),
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
    for (name, port) in &target.ports {
        println!(
            "  {} {} {} localhost:{}",
            green("●"),
            bold(domain_ports::env_name(name)),
            dim("→"),
            blue(port)
        );
    }

    // Resolve dev command sequence.
    let dev = project_config.commands.dev.clone();
    let Some((last, rest)) = dev.split_last() else {
        println!(
            "  {}",
            dim("No dev command configured. Proxy route is active.")
        );
        return Ok(());
    };
    let resolved_last = ports::substitute(last, target.port, &target.ports)?;
    // Most dev servers read PORT, so a plain `pnpm run dev` lands on the routed
    // port; `{port}` covers the ones that don't (vite --port {port}). Named
    // ports reach the processes as <NAME>_PORT and `{port:<name>}`.
    let vars = domain_ports::env_vars(target.port, &target.ports);
    let env: Vec<(&str, &str)> = vars.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    let env = env.as_slice();

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
        let resolved = ports::substitute(cmd, target.port, &target.ports)?;
        println!("  {}", dim(format!("Running: {resolved}")));
        shell::exec_in_dir(&target.path, &resolved, env)?;
    }

    println!("  {}", dim(format!("Running: {resolved_last}")));
    println!();

    // Run the final dev command (blocks until it exits — the dev server).
    shell::exec_in_dir(&target.path, &resolved_last, env)?;
    Ok(())
}
