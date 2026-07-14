mod commands;
mod domain;
mod errors;
mod fmt;
mod prompt;
mod schema;
mod services;
mod util;
mod version;

use clap::{Parser, Subcommand};
use commands::db::DbCmd;
use commands::init::InitArgs;
use commands::proxy::ProxyCmd;
use fmt::{blue, bold, dim};

#[derive(Parser)]
#[command(name = "ship", version = version::VERSION, disable_help_subcommand = true)]
struct Cli {
    #[command(subcommand)]
    command: Option<Cmd>,
}

#[derive(Subcommand)]
enum Cmd {
    /// Register current directory as a project
    Init(InitArgs),
    /// List registered projects
    Projects,
    /// Create or resume a workspace
    Create {
        project: Option<String>,
        branch: Option<String>,
        /// Base branch to create worktree from (defaults to HEAD)
        #[arg(long)]
        base: Option<String>,
    },
    /// Tear down a workspace
    Down {
        project: Option<String>,
        branch: Option<String>,
        #[arg(long, short = 'f')]
        force: bool,
        #[arg(long)]
        db_only: bool,
    },
    /// List active workspaces
    Ls { project: Option<String> },
    /// Start dev server + proxy
    Up {
        #[arg(long)]
        open: bool,
    },
    /// Manage the HTTPS reverse proxy
    Proxy {
        #[command(subcommand)]
        cmd: Option<ProxyCmd>,
    },
    /// Database utilities
    Db {
        #[command(subcommand)]
        cmd: Option<DbCmd>,
    },
    /// Fetch, pull main, migrate source db
    Sync { project: String },
    /// Reset workspace database
    Reset {
        #[arg(long)]
        fresh: bool,
    },
    /// Open editor, browser, or psql
    Open {
        first: Option<String>,
        second: Option<String>,
    },
    /// Register pre-existing worktrees
    Index {
        project: Option<String>,
        #[arg(long, short = 'a')]
        all: bool,
        #[arg(long)]
        dry_run: bool,
    },
    /// Clean up merged-PR workspaces
    Gc {
        #[arg(long, short = 'f')]
        force: bool,
        #[arg(long)]
        dry_run: bool,
        #[arg(long, short = 's')]
        sync: bool,
    },
    /// Download and install the latest release
    Update,
    /// Background update-cache refresh worker (best-effort, errors swallowed)
    #[command(name = "__refresh-update-cache", hide = true)]
    RefreshUpdateCache,
}

fn help_text() -> String {
    format!(
        r#"
  {ship} — project-aware worktree + proxy manager

  {usage}
    ship {cmd} [options]

  {project_setup}
    {init}                          Register current directory as a project
    {init} --alias ep ...           Non-interactive with flags
    {projects}                      List registered projects

  {lifecycle}
    {create} [project] [branch]     Create or resume a workspace
    {down}   [project] [branch]     Tear down a workspace
    {ls}     [project]              List active workspaces

  {dev_server}
    {up}     [--open]               Start dev server + proxy

  {proxy} {proxy_note}
    {proxy_start}                   Start proxy container
    {proxy_stop}                    Stop proxy container
    {proxy_status}                  Show status and routes
    {proxy_add} <domain> <port>     Add a route
    {proxy_rm}  <domain>            Remove a route
    {proxy_ls}                      List all routes
    {proxy_trust}                   Trust CA in macOS keychain
    {proxy_edit}                    Open Caddyfile in $EDITOR
    {proxy_next}               Print next available port

  {database}
    {db_exec} <sql>                  Run SQL against workspace database

  {utilities}
    {sync}   <project>              Fetch, pull main, migrate source db
    {reset}  [--fresh]              Reset workspace database
    {open}   [editor|url|db]        Open editor, browser, or psql
    {index}  [project] [--all] [--dry-run]   Register pre-existing worktrees
    {gc}     [--force] [--dry-run] [--sync]  Clean up merged-PR workspaces
    {update}                        Download and install the latest release

  {options}
    --help, -h                    Show help for any command
    --version                     Show version

  {examples}
    {d} ship init                        {c_init}
    {d} ship create ep tim/ep-241         {c_create}
    {d} ship ls                           {c_ls}
    {d} ship down ep tim/ep-241           {c_down}
    {d} ship proxy start                  {c_proxy}
"#,
        ship = bold("ship"),
        usage = bold("Usage"),
        cmd = blue("<command>"),
        project_setup = bold("Project Setup"),
        init = blue("init"),
        projects = blue("projects"),
        lifecycle = bold("Workspace Lifecycle"),
        create = blue("create"),
        down = blue("down"),
        ls = blue("ls"),
        dev_server = bold("Dev Server"),
        up = blue("up"),
        proxy = bold("Proxy"),
        proxy_note = dim("(HTTPS reverse proxy via Caddy)"),
        proxy_start = blue("proxy start"),
        proxy_stop = blue("proxy stop"),
        proxy_status = blue("proxy status"),
        proxy_add = blue("proxy add"),
        proxy_rm = blue("proxy rm"),
        proxy_ls = blue("proxy ls"),
        proxy_trust = blue("proxy trust"),
        proxy_edit = blue("proxy edit"),
        proxy_next = blue("proxy next-port"),
        database = bold("Database"),
        db_exec = blue("db exec"),
        utilities = bold("Utilities"),
        sync = blue("sync"),
        reset = blue("reset"),
        open = blue("open"),
        index = blue("index"),
        gc = blue("gc"),
        update = blue("update"),
        options = bold("Options"),
        examples = bold("Examples"),
        d = dim("$"),
        c_init = dim("# register project (interactive)"),
        c_create = dim("# create workspace"),
        c_ls = dim("# list workspaces"),
        c_down = dim("# tear down"),
        c_proxy = dim("# start HTTPS proxy"),
    )
}

fn dispatch(cmd: Cmd) {
    match cmd {
        Cmd::Init(args) => commands::init::run(args),
        Cmd::Projects => commands::projects::run(),
        Cmd::Create { project, branch, base } => commands::create::run(project, branch, base),
        Cmd::Down { project, branch, force, db_only } => {
            commands::down::run(project, branch, force, db_only)
        }
        Cmd::Ls { project } => commands::list::run(project),
        Cmd::Up { open } => commands::up::run(open),
        Cmd::Proxy { cmd } => commands::proxy::run(cmd),
        Cmd::Db { cmd } => match cmd {
            Some(DbCmd::Exec { sql }) => commands::db::run_exec(&sql),
            None => commands::db::print_help(),
        },
        Cmd::Sync { project } => commands::sync::run(project),
        Cmd::Reset { fresh } => commands::reset::run(fresh),
        Cmd::Open { first, second } => commands::open::run(first, second),
        Cmd::Index { project, all, dry_run } => commands::index::run(project, all, dry_run),
        Cmd::Gc { force, dry_run, sync } => commands::gc::run(force, dry_run, sync),
        Cmd::Update => commands::update::run(),
        Cmd::RefreshUpdateCache => {
            let _ = services::updater::refresh_cache();
        }
    }
}

fn main() {
    let cli = Cli::parse();
    match cli.command {
        None => println!("{}", help_text()),
        Some(cmd) => dispatch(cmd),
    }
    // Post-run hooks (both no-op for dev builds and the refresh worker itself).
    services::updater::notify_if_available();
    services::updater::spawn_background_refresh_if_stale();
}
