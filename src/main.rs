mod commands;
mod domain;
mod errors;
mod fmt;
mod prompt;
mod schema;
mod services;
mod ui;
mod util;
mod version;

use clap::{Parser, Subcommand};
use commands::config::ConfigCmd;
use commands::db::DbCmd;
use commands::init::InitArgs;
use commands::proxy::ProxyCmd;
use fmt::{blue, bold, dim};
use std::process::ExitCode;

#[derive(Parser)]
#[command(name = "ship", version = version::VERSION, disable_help_subcommand = true)]
struct Cli {
    #[command(subcommand)]
    command: Option<Cmd>,
}

#[derive(Subcommand)]
enum Cmd {
    /// Register the current directory as a project. Detects env files, commands, and the database; without a terminal it takes what it detected and lists what it left empty
    Init(InitArgs),
    /// List registered projects
    Projects {
        /// Print as JSON
        #[arg(long)]
        json: bool,
    },
    /// Inspect stored project config
    Config {
        #[command(subcommand)]
        cmd: Option<ConfigCmd>,
    },
    /// Create or resume a workspace: worktree, database clone, patched .env files, HTTPS route
    Create {
        /// Project alias (see `ship projects`); required without a terminal
        project: Option<String>,
        /// Branch to check out; created when it does not exist. Required without a terminal
        branch: Option<String>,
        /// Base branch for a new branch (default: the main checkout's upstream, e.g. origin/main)
        #[arg(long)]
        base: Option<String>,
    },
    /// Tear down a workspace: route, database, worktree, local branch, and the remote branch once its PR is closed or merged
    Down {
        /// Project alias (default: the workspace containing the current directory)
        project: Option<String>,
        /// Branch of the workspace to tear down
        branch: Option<String>,
        /// Skip the confirmation and remove a dirty worktree; required without a terminal
        #[arg(long, short = 'f')]
        force: bool,
        /// Only drop the workspace database; keep the worktree and branches
        #[arg(long)]
        db_only: bool,
        /// Delete the remote branch regardless of pull-request state
        #[arg(long, conflicts_with = "db_only")]
        remote: bool,
    },
    /// List active workspaces
    Ls {
        /// Only this project's workspaces
        project: Option<String>,
        /// Skip the pull-request lookup
        #[arg(long)]
        no_pr: bool,
        /// Print as JSON (waits for the pull-request lookup unless --no-pr)
        #[arg(long)]
        json: bool,
    },
    /// Start the dev server behind the HTTPS route, from a workspace or project directory. Blocks until the server exits; ship sets PORT
    Up {
        /// Open the HTTPS URL in the browser
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
    /// Fetch and fast-forward the project's main checkout; install and migrate when HEAD moved
    Sync {
        /// Project alias
        project: String,
    },
    /// Re-clone the current workspace's database from the source and rerun the db commands
    Reset,
    /// Open a workspace in the editor, the browser, or psql
    Open {
        /// `editor`, `url`, `db`, or a branch (then the target follows; default: editor)
        first: Option<String>,
        /// Target after a branch: editor, url, db
        second: Option<String>,
    },
    /// Register worktrees created outside ship
    Index {
        /// Only this project (default: every project)
        project: Option<String>,
        /// Index every candidate without asking; required without a terminal
        #[arg(long, short = 'a')]
        all: bool,
        /// Show what would be indexed
        #[arg(long)]
        dry_run: bool,
    },
    /// Clean up workspaces whose PR is merged
    Gc {
        /// Skip the picker: take every merged workspace (or every orphan with --databases/--sessions)
        #[arg(long, short = 'f')]
        force: bool,
        /// Show what would be cleaned up
        #[arg(long)]
        dry_run: bool,
        /// Run `ship sync` for each project afterwards
        #[arg(long, short = 's')]
        sync: bool,
        /// Sweep orphaned agent sessions instead of workspaces
        #[arg(long, conflicts_with = "databases")]
        sessions: bool,
        /// Sweep orphaned databases instead of workspaces
        #[arg(long)]
        databases: bool,
        /// Delete remote branches regardless of pull-request state
        #[arg(long, conflicts_with_all = ["sessions", "databases"])]
        remote: bool,
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
    {init} --alias ep ...           Override what init detects
    {projects} [--json]             List registered projects
    {config_show} [alias] [--all] [--json]   Show stored config with file path + lines
    {config_sessions} [on|off]   Delete agent sessions on teardown

  {lifecycle}
    {create} [project] [branch]     Create or resume a workspace
    {down}   [project] [branch] [--remote]   Tear down a workspace
    {ls}     [project] [--json]     List active workspaces

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
    {reset}                        Reset workspace database
    {open}   [editor|url|db]        Open editor, browser, or psql
    {index}  [project] [--all] [--dry-run]   Register pre-existing worktrees
    {gc}     [--force] [--dry-run] [--sync] [--remote]  Clean up merged workspaces
    {gc}     --databases            Clean up databases no workspace claims
    {gc}     --sessions             Clean up agent sessions with no worktree left
    {update}                        Download and install the latest release

  {agents}
    npx skills add timzolleis/ship -g   Install the agent skill (any agent)
    Without a terminal, prompts take their safe default or exit 1 naming the
    flag to pass. Every failure exits nonzero.

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
        config_show = blue("config show"),
        config_sessions = blue("config sessions"),
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
        agents = bold("Agents"),
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

fn dispatch(cmd: Cmd) -> ExitCode {
    match cmd {
        Cmd::Init(args) => commands::init::run(args),
        Cmd::Projects { json } => commands::projects::run(json),
        Cmd::Config { cmd } => commands::config::run(cmd),
        Cmd::Create {
            project,
            branch,
            base,
        } => commands::create::run(project, branch, base),
        Cmd::Down {
            project,
            branch,
            force,
            db_only,
            remote,
        } => commands::down::run(project, branch, force, db_only, remote),
        Cmd::Ls {
            project,
            no_pr,
            json,
        } => commands::list::run(project, no_pr, json),
        Cmd::Up { open } => commands::up::run(open),
        Cmd::Proxy { cmd } => commands::proxy::run(cmd),
        Cmd::Db { cmd } => match cmd {
            Some(DbCmd::Exec { sql }) => commands::db::run_exec(&sql),
            None => {
                commands::db::print_help();
                ExitCode::SUCCESS
            }
        },
        Cmd::Sync { project } => commands::sync::run(project),
        Cmd::Reset => commands::reset::run(),
        Cmd::Open { first, second } => commands::open::run(first, second),
        Cmd::Index {
            project,
            all,
            dry_run,
        } => commands::index::run(project, all, dry_run),
        Cmd::Gc {
            force,
            dry_run,
            sync,
            sessions,
            databases,
            remote,
        } => commands::gc::run(force, dry_run, sync, sessions, databases, remote),
        Cmd::Update => commands::update::run(),
        Cmd::RefreshUpdateCache => {
            let _ = services::updater::refresh_cache();
            ExitCode::SUCCESS
        }
    }
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let code = match cli.command {
        None => {
            println!("{}", help_text());
            ExitCode::SUCCESS
        }
        Some(cmd) => dispatch(cmd),
    };
    // Post-run hooks (both no-op for dev builds and the refresh worker itself).
    services::updater::notify_if_available();
    services::updater::spawn_background_refresh_if_stale();
    code
}
