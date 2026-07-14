use crate::errors::Result;
use crate::fmt::{blue, bold, dim, green, red, yellow};
use crate::services::proxy;

// ---------------------------------------------------------------------------
// ship proxy <start|stop|status|ls|add|rm|trust|edit|next-port>
// ---------------------------------------------------------------------------

#[derive(clap::Subcommand)]
pub enum ProxyCmd {
    /// Start proxy container
    Start,
    /// Stop proxy container
    Stop,
    /// Show status and routes
    Status,
    /// List all routes
    Ls,
    /// Add a route
    Add { domain: String, port: u16 },
    /// Remove a route
    Rm { domain: String },
    /// Trust CA in macOS keychain
    Trust,
    /// Open Caddyfile in $EDITOR
    Edit,
    /// Print next available port
    #[command(name = "next-port")]
    NextPort,
}

pub fn run(cmd: Option<ProxyCmd>) {
    let result = match cmd {
        None => {
            println!("Manage the local HTTPS reverse proxy.\n\nRun 'ship proxy --help' for available commands.");
            Ok(())
        }
        Some(ProxyCmd::Start) => start(),
        Some(ProxyCmd::Stop) => {
            proxy::stop();
            println!("  {} Proxy stopped.", dim("○"));
            Ok(())
        }
        Some(ProxyCmd::Status) => status(),
        Some(ProxyCmd::Ls) => ls(),
        Some(ProxyCmd::Add { domain, port }) => {
            match proxy::add_route(&domain, port) {
                Ok(()) => println!(
                    "  {} {} {} localhost:{}",
                    green("✓"),
                    bold(&domain),
                    dim("→"),
                    blue(port)
                ),
                Err(e) => println!("  {} {}", red("✗"), e),
            }
            Ok(())
        }
        Some(ProxyCmd::Rm { domain }) => {
            match proxy::remove_route(&domain) {
                Ok(()) => println!("  {} Removed {}", green("✓"), bold(&domain)),
                Err(e) => println!("  {} {}", red("✗"), e),
            }
            Ok(())
        }
        Some(ProxyCmd::Trust) => {
            match proxy::trust() {
                Ok(()) => println!("  {} CA trusted. HTTPS will work in all browsers.", green("✓")),
                Err(e) => println!("  {} {}", red("✗"), e),
            }
            Ok(())
        }
        Some(ProxyCmd::Edit) => proxy::edit_caddyfile(),
        Some(ProxyCmd::NextPort) => proxy::next_port().map(|port| println!("{port}")),
    };
    if let Err(e) = result {
        eprintln!("Error: {e}");
        std::process::exit(1);
    }
}

fn start() -> Result<()> {
    if proxy::is_running() {
        println!("  {} Already running.", yellow("●"));
        return Ok(());
    }
    proxy::start()?;
    println!("  {} Proxy started.", green("●"));
    println!("  {}", dim("Run 'ship proxy trust' once to trust the CA."));
    Ok(())
}

fn status() -> Result<()> {
    let (running, routes) = proxy::status()?;
    println!();
    if running {
        println!("  {} {} running", green("●"), bold("ship-proxy"));
    } else {
        println!("  {} {} stopped", dim("○"), bold("ship-proxy"));
        println!();
        return Ok(());
    }
    println!();
    if !routes.is_empty() {
        println!("  {}", bold("Routes"));
        print_routes(&routes);
    } else {
        println!("  {}", dim("No routes configured."));
    }
    println!();
    Ok(())
}

fn ls() -> Result<()> {
    proxy::ensure_setup()?;
    let routes = proxy::get_routes()?;
    println!();
    println!("  {}", bold("Routes"));
    if routes.is_empty() {
        println!("  {}", dim("No routes configured."));
    } else {
        print_routes(&routes);
    }
    println!();
    Ok(())
}

fn print_routes(routes: &[crate::domain::caddyfile::Route]) {
    for (i, route) in routes.iter().enumerate() {
        let prefix = if i == routes.len() - 1 { "└──" } else { "├──" };
        println!(
            "  {} {} {} localhost:{}",
            prefix,
            bold(&route.domain),
            dim("→"),
            blue(route.port)
        );
    }
}
