use thiserror::Error;

fn shell_exec_message(command: &str, stderr: &str) -> String {
    if stderr.is_empty() {
        format!("Command failed: {command}")
    } else {
        stderr.to_string()
    }
}

#[derive(Debug, Error)]
pub enum Error {
    #[error("Port name '{name}' can't be used: lowercase letters, digits, '-' and '_', starting with a letter.")]
    InvalidPortName { name: String },

    #[error("No port named '{name}' (used by {place}). Declare it in the project's \"ports\".")]
    UnknownPort { name: String, place: String },

    #[error("--port {name}={value}: '{value}' is not a port.")]
    InvalidPortValue { name: String, value: String },

    #[error("Project '{alias}' not found. Run 'ship init' first.")]
    ProjectNotFound { alias: String },

    #[error("Failed to parse {file}: {detail}")]
    ParseConfig { file: String, detail: String },

    #[error(
        "Config format has changed — run 'ship init' to re-register your projects.\n  ({detail})"
    )]
    ConfigOutdated { detail: String },

    #[error("Failed to encode config: {detail}")]
    EncodeConfig { detail: String },

    #[error("Failed to create directory '{path}': {detail}")]
    CreateDirectory { path: String, detail: String },

    #[error("Failed to read '{path}': {detail}")]
    ReadFile { path: String, detail: String },

    #[error("Failed to write '{path}': {detail}")]
    WriteFile { path: String, detail: String },

    #[error("{}", shell_exec_message(.command, .stderr))]
    ShellExec { command: String, stderr: String },

    #[error("Database {op} failed for '{database}': {detail}")]
    Database {
        op: String,
        database: String,
        detail: String,
    },

    #[error("Database ({runtime}) is not reachable. Start it first, then re-run.")]
    DatabaseUnreachable { runtime: String },

    #[error("Route '{domain}' already exists.")]
    RouteExists { domain: String },

    #[error("No CA cert yet. Start the proxy and make a request first.")]
    CertNotFound,

    #[error("Failed to check for updates: {detail}")]
    UpdateCheck { detail: String },

    #[error("Failed to download '{url}': {detail}")]
    UpdateDownload { url: String, detail: String },

    #[error("Failed to install update: {detail}")]
    UpdateInstall { detail: String },

    #[error("Unsupported platform: {platform}/{arch}. Pre-built binaries are only published for darwin-arm64 and darwin-x64.")]
    UnsupportedPlatform { platform: String, arch: String },

    #[error("No workspace found for branch '{branch}'. Run 'ship ls' to see active workspaces.")]
    WorkspaceNotFound { branch: String },

    #[error("No active workspaces. Create one with 'ship create <project> <branch>'.")]
    NoActiveWorkspaces,

    #[error("No projects registered. Register one with 'ship init'.")]
    NoProjects,

    #[error("Not inside a workspace. Run this from a workspace directory.")]
    NotInWorkspace,

    #[error(
        "Not inside a workspace or registered project. Use 'ship init' or 'ship create' first."
    )]
    NotInProject,

    #[error("Unknown target '{target}'. Use: editor, url, db")]
    UnknownTarget { target: String },

    #[error("{prompt}: no terminal to ask. Pass {hint}.")]
    NeedsInput { prompt: String, hint: String },

    #[error("Project '{alias}' has no database. Add one under \"database\" in config.json (ship config show {alias}).")]
    NoDatabase { alias: String },

    #[error("{0}")]
    Prompt(String),
}

impl From<dialoguer::Error> for Error {
    fn from(e: dialoguer::Error) -> Self {
        Error::Prompt(e.to_string())
    }
}

pub type Result<T, E = Error> = std::result::Result<T, E>;
