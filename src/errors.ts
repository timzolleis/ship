import { Schema } from "effect"

// ---------------------------------------------------------------------------
// Config errors
// ---------------------------------------------------------------------------

export class ProjectNotFoundError extends Schema.TaggedError<ProjectNotFoundError>()(
  "ProjectNotFoundError",
  { alias: Schema.String }
) {
  get message() {
    return `Project '${this.alias}' not found. Run 'ship init' first.`
  }
}

export class ParseConfigError extends Schema.TaggedError<ParseConfigError>()(
  "ParseConfigError",
  { file: Schema.String, detail: Schema.String }
) {
  get message() {
    return `Failed to parse ${this.file}: ${this.detail}`
  }
}

export class EncodeConfigError extends Schema.TaggedError<EncodeConfigError>()(
  "EncodeConfigError",
  { detail: Schema.String }
) {
  get message() {
    return `Failed to encode config: ${this.detail}`
  }
}

// ---------------------------------------------------------------------------
// Filesystem errors
// ---------------------------------------------------------------------------

export class CreateDirectoryError extends Schema.TaggedError<CreateDirectoryError>()(
  "CreateDirectoryError",
  { path: Schema.String, detail: Schema.String }
) {
  get message() {
    return `Failed to create directory '${this.path}': ${this.detail}`
  }
}

export class ReadFileError extends Schema.TaggedError<ReadFileError>()(
  "ReadFileError",
  { path: Schema.String, detail: Schema.String }
) {
  get message() {
    return `Failed to read '${this.path}': ${this.detail}`
  }
}

export class WriteFileError extends Schema.TaggedError<WriteFileError>()(
  "WriteFileError",
  { path: Schema.String, detail: Schema.String }
) {
  get message() {
    return `Failed to write '${this.path}': ${this.detail}`
  }
}

// ---------------------------------------------------------------------------
// Shell errors
// ---------------------------------------------------------------------------

export class ShellExecError extends Schema.TaggedError<ShellExecError>()(
  "ShellExecError",
  { command: Schema.String, stderr: Schema.String }
) {
  get message() {
    return this.stderr || `Command failed: ${this.command}`
  }
}

// ---------------------------------------------------------------------------
// Proxy errors
// ---------------------------------------------------------------------------

export class RouteExistsError extends Schema.TaggedError<RouteExistsError>()(
  "RouteExistsError",
  { domain: Schema.String }
) {
  get message() {
    return `Route '${this.domain}' already exists.`
  }
}

export class RouteNotFoundError extends Schema.TaggedError<RouteNotFoundError>()(
  "RouteNotFoundError",
  { domain: Schema.String }
) {
  get message() {
    return `Route '${this.domain}' not found.`
  }
}

export class CertNotFoundError extends Schema.TaggedError<CertNotFoundError>()(
  "CertNotFoundError",
  {}
) {
  get message() {
    return "No CA cert yet. Start the proxy and make a request first."
  }
}

// ---------------------------------------------------------------------------
// Updater errors
// ---------------------------------------------------------------------------

export class UpdateCheckError extends Schema.TaggedError<UpdateCheckError>()(
  "UpdateCheckError",
  { detail: Schema.String }
) {
  get message() {
    return `Failed to check for updates: ${this.detail}`
  }
}

export class UpdateDownloadError extends Schema.TaggedError<UpdateDownloadError>()(
  "UpdateDownloadError",
  { url: Schema.String, detail: Schema.String }
) {
  get message() {
    return `Failed to download '${this.url}': ${this.detail}`
  }
}

export class UpdateInstallError extends Schema.TaggedError<UpdateInstallError>()(
  "UpdateInstallError",
  { detail: Schema.String }
) {
  get message() {
    return `Failed to install update: ${this.detail}`
  }
}

export class UnsupportedPlatformError extends Schema.TaggedError<UnsupportedPlatformError>()(
  "UnsupportedPlatformError",
  { platform: Schema.String, arch: Schema.String }
) {
  get message() {
    return `Unsupported platform: ${this.platform}/${this.arch}. Pre-built binaries are only published for darwin-arm64 and darwin-x64.`
  }
}

// ---------------------------------------------------------------------------
// Workspace resolution errors
// ---------------------------------------------------------------------------

export class WorkspaceNotFoundError extends Schema.TaggedError<WorkspaceNotFoundError>()(
  "WorkspaceNotFoundError",
  { branch: Schema.String }
) {
  get message() {
    return `No workspace found for branch '${this.branch}'. Run 'ship ls' to see active workspaces.`
  }
}

export class NoActiveWorkspacesError extends Schema.TaggedError<NoActiveWorkspacesError>()(
  "NoActiveWorkspacesError",
  {}
) {
  get message() {
    return "No active workspaces. Create one with 'ship create <project> <branch>'."
  }
}
