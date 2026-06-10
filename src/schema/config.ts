import { ParseResult, Schema } from "effect"
import {
  ContainerName,
  DbName,
  HostPort,
  ProjectAlias,
  ProxyDomain,
  RepoPath,
} from "./ids.js"

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
// Execution runtime — where DB commands run (per-call data, D1)
// ---------------------------------------------------------------------------

export const ExecutionRuntime = Schema.Union(
  Schema.TaggedStruct("local", {}),
  Schema.TaggedStruct("docker", { container: ContainerName })
)
export type ExecutionRuntime = typeof ExecutionRuntime.Type

// ---------------------------------------------------------------------------
// Database config
//
// Canonical shape carries `runtime`. Legacy stored configs carry a bare
// `container` string (no `runtime`) — decode tolerates this and maps it to
// `{ _tag: "docker", container }` (D10). Encode ALWAYS writes canonical.
// ---------------------------------------------------------------------------

const DatabaseConfigFields = {
  runtime: ExecutionRuntime,
  user: Schema.String,
  source: DbName,
  host: Schema.optionalWith(Schema.String, { default: () => "localhost" }),
  port: Schema.optionalWith(Schema.Number, { default: () => 5432 }),
}

export class DatabaseConfig extends Schema.Class<DatabaseConfig>("DatabaseConfig")(
  DatabaseConfigFields
) {}

/**
 * Decode side accepts EITHER the canonical `{ runtime }` shape OR the legacy
 * `{ container }` shape, normalizing legacy → `runtime: { _tag: "docker" }`.
 * Encode side always emits the canonical `DatabaseConfig` (never `container`).
 */
const DatabaseConfigRaw = Schema.Union(
  Schema.Struct(DatabaseConfigFields),
  Schema.Struct({
    container: Schema.String,
    user: Schema.String,
    source: DbName,
    host: Schema.optionalWith(Schema.String, { default: () => "localhost" }),
    port: Schema.optionalWith(Schema.Number, { default: () => 5432 }),
  })
)

export const DatabaseConfigFromStored = Schema.transformOrFail(DatabaseConfigRaw, DatabaseConfig, {
    strict: false,
    decode: (raw) =>
      ParseResult.succeed(
        new DatabaseConfig({
          runtime:
            "runtime" in raw
              ? raw.runtime
              : { _tag: "docker", container: ContainerName.make(raw.container) },
          user: raw.user,
          source: raw.source,
          host: raw.host,
          port: raw.port,
        })
      ),
    encode: (config) => ParseResult.succeed(config),
  })

/**
 * Behavior-preserving accessor for the docker container name. All pre-refactor
 * call sites assumed `database.container` (docker). Slice 3 replaces these reads
 * with `DatabaseService` taking the full `ExecutionRuntime`; until then commands
 * extract the container here. Returns "" for a local runtime (no container).
 */
export const dockerContainerOf = (db: DatabaseConfig): string =>
  db.runtime._tag === "docker" ? db.runtime.container : ""

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
  path: RepoPath,
  /** Root checkout route: <domain> → localhost:<port>. Absent on projects registered before root routes existed — `ship up` backfills. */
  domain: Schema.optional(ProxyDomain),
  port: Schema.optional(HostPort),
  database: DatabaseConfigFromStored,
  commands: CommandsConfig,
  env: EnvConfig,
  worktree: WorktreeConfig
}) {}

// ---------------------------------------------------------------------------
// Root config
// ---------------------------------------------------------------------------

export class ShipConfig extends Schema.Class<ShipConfig>("ShipConfig")({
  editor: Schema.optional(Schema.String),
  /** Auto-open editor after ship create. undefined = ask first time. */
  autoOpenEditor: Schema.optional(Schema.Boolean),
  projects: Schema.Record({ key: ProjectAlias, value: ProjectConfig })
}) {}
