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
    #[error("Project '{alias}' not found. Run 'ship init' first.")]
    ProjectNotFound { alias: String },

    #[error("Failed to parse {file}: {detail}")]
    ParseConfig { file: String, detail: String },

    #[error("Config format has changed — run 'ship init' to re-register your projects.\n  ({detail})")]
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

    #[error("Route '{domain}' not found.")]
    RouteNotFound { domain: String },

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

    #[error("{0}")]
    Prompt(String),
}

impl From<dialoguer::Error> for Error {
    fn from(e: dialoguer::Error) -> Self {
        Error::Prompt(e.to_string())
    }
}

pub type Result<T, E = Error> = std::result::Result<T, E>;
