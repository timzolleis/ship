import { Schema } from "effect"

// ---------------------------------------------------------------------------
// Env var auto-detection types
// ---------------------------------------------------------------------------

export const EnvVarType = Schema.Union(
  Schema.Literal("database_url"),
  Schema.Literal("proxy_url"),
  Schema.Literal("dev_url"),
  Schema.Literal("plain")
)
export type EnvVarType = typeof EnvVarType.Type

export class EnvVarConfig extends Schema.Class<EnvVarConfig>("EnvVarConfig")({
  type: EnvVarType,
  /** Optional path suffix for dev_url type (e.g., "/oauth") */
  path: Schema.optional(Schema.String)
}) {}

// ---------------------------------------------------------------------------
// Database config
// ---------------------------------------------------------------------------

export class DatabaseConfig extends Schema.Class<DatabaseConfig>("DatabaseConfig")({
  container: Schema.String,
  user: Schema.String,
  source: Schema.String,
  host: Schema.optionalWith(Schema.String, { default: () => "localhost" }),
  port: Schema.optionalWith(Schema.Number, { default: () => 5432 }),
}) {}

// ---------------------------------------------------------------------------
// Commands config
// ---------------------------------------------------------------------------

export class CommandsConfig extends Schema.Class<CommandsConfig>("CommandsConfig")({
  install: Schema.optional(Schema.String),
  generate: Schema.optional(Schema.String),
  migrate: Schema.optional(Schema.String),
  dev: Schema.optional(Schema.String),
  seed: Schema.optional(Schema.String)
}) {}

// ---------------------------------------------------------------------------
// Env config
// ---------------------------------------------------------------------------

export class EnvConfig extends Schema.Class<EnvConfig>("EnvConfig")({
  files: Schema.Array(Schema.String),
  autoDetected: Schema.Record({ key: Schema.String, value: EnvVarConfig })
}) {}

// ---------------------------------------------------------------------------
// Worktree config
// ---------------------------------------------------------------------------

export class WorktreeConfig extends Schema.Class<WorktreeConfig>("WorktreeConfig")({
  dirPattern: Schema.String,
  proxyDomainPattern: Schema.String,
  dbNamePattern: Schema.String
}) {}

// ---------------------------------------------------------------------------
// Project config
// ---------------------------------------------------------------------------

export class ProjectConfig extends Schema.Class<ProjectConfig>("ProjectConfig")({
  path: Schema.String,
  database: DatabaseConfig,
  commands: CommandsConfig,
  env: EnvConfig,
  worktree: WorktreeConfig
}) {}

// ---------------------------------------------------------------------------
// Root config
// ---------------------------------------------------------------------------

export class ShipConfig extends Schema.Class<ShipConfig>("ShipConfig")({
  editor: Schema.optionalWith(Schema.String, { default: () => "code" }),
  projects: Schema.Record({ key: Schema.String, value: ProjectConfig })
}) {}
