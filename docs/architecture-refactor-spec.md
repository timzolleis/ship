# ship — Architecture Refactor Spec (LOCKED v2)

Status: **locked** (design-first, 2026-06-10). Implementation is mechanical from here:
strict TDD per slice — red tests against these interfaces first, then implement to green.
Do not re-litigate recorded decisions (§ Decisions). If an interface here turns out
unimplementable, stop and surface it rather than silently reshaping.

## Goal

- Every seam is a `Context.Tag` class with layer statics: `Service.layer` (prod),
  `Service.layerMemory` (in-memory adapter). **No `Live` suffix. No `Effect.Service`.**
- Pure logic lives in `src/domain/` modules (no services, no IO).
- Commands shrink to: resolve inputs (prompts) → call a deep service → render events.
- Tests: `@effect/vitest`, `it.effect`, `assert` (never `expect`), never `vi.mock`/`vi.spyOn`.
  Drive seams through `layerMemory` adapters.
- **Testing principle:** leaf seams get `layerMemory`; orchestrators (Sync, Workspace) are
  tested through their real `layer` composed over memory leaves — wiring is under test.

## Target layout

```
src/
├── domain/                  # NEW — pure modules
│   ├── workspace-name.ts    #   slugs + pattern resolution → names
│   ├── workspace-locate.ts  #   cwd/branch-query → Option<Workspace>
│   ├── caddyfile.ts         #   route codec + nextPort
│   └── env-patch.ts         #   pure .env content patching
├── schema/
│   ├── ids.ts               # NEW — branded scalars
│   ├── config.ts            # ExecutionRuntime, DatabaseConfig.runtime, brands
│   ├── workspace.ts         # branded fields
│   └── update-cache.ts      # unchanged
├── services/                # ONE FILE PER SERVICE; tag class + layer statics
│   ├── shell.ts runner.ts database.ts git.ts config.ts proxy.ts
│   ├── editor.ts env.ts claude.ts sync.ts updater.ts
│   └── workspace.ts         # NEW deep orchestrator
└── (DELETE: services/database/ dir, services/executor/ dir, old services/database.ts)
test/
├── domain/*.test.ts
└── services/*.test.ts
```

## Branded scalars (`src/schema/ids.ts`) — FULL branding (user decision)

```ts
export const ProjectAlias  = Schema.String.pipe(Schema.brand("ProjectAlias"))
export const BranchName    = Schema.String.pipe(Schema.brand("BranchName"))
export const RepoPath      = Schema.String.pipe(Schema.brand("RepoPath"))      // project root checkout
export const WorktreePath  = Schema.String.pipe(Schema.brand("WorktreePath"))  // absolute worktree dir
export const DbName        = Schema.String.pipe(Schema.brand("DbName"))
export const ProxyDomain   = Schema.String.pipe(Schema.brand("ProxyDomain"))
export const ContainerName = Schema.String.pipe(Schema.brand("ContainerName"))
export const HostPort      = Schema.Number.pipe(Schema.int(), Schema.brand("HostPort"))
// + export type for each
```

Convention: brands are constructed at the edges only — CLI arg/prompt decoding
(`Schema.decodeSync(BranchName)(input)`) and config-file schema decode. Internals pass
brands through; no re-validation inside services.

## Schema changes

```ts
// schema/config.ts
export const ExecutionRuntime = Schema.Union(
  Schema.TaggedStruct("local",  {}),
  Schema.TaggedStruct("docker", { container: ContainerName })
)
export type ExecutionRuntime = typeof ExecutionRuntime.Type

export class DatabaseConfig extends Schema.Class<DatabaseConfig>("DatabaseConfig")({
  runtime: ExecutionRuntime,
  user:    Schema.String,
  source:  DbName,
  host:    Schema.optionalWith(Schema.String, { default: () => "localhost" }),
  port:    Schema.optionalWith(Schema.Number, { default: () => 5432 }),
}) {}
// ProjectConfig.path: RepoPath; ProjectConfig.domain?: ProxyDomain; ProjectConfig.port?: HostPort
// ShipConfig.projects: Record<ProjectAlias, ProjectConfig>

// schema/workspace.ts
export class Workspace extends Schema.Class<Workspace>("Workspace")({
  project: ProjectAlias, branch: BranchName, path: WorktreePath,
  port: HostPort, dbName: DbName, proxyDomain: ProxyDomain, created: Schema.String
}) {}
```

### Legacy config migration (D10)

Stored configs today have `database: { container, user, source, ... }` (no `runtime`).
- Decode accepts the legacy shape: a `Schema.transform` (or union) maps
  `{ container }` → `runtime: { _tag: "docker", container }`.
- `ConfigService.loadConfig` is **self-migrating**: after decoding, if the stored raw shape
  was legacy, immediately re-encode canonical and write back (best-effort; load still
  succeeds if the write fails). One-time, silent, values carried over — an automatic
  "re-init from old values". `ship init` prefill continues to work for manual re-runs.

## Domain modules (pure)

```ts
// domain/workspace-name.ts — single source of truth (kills create.ts/index.ts duplication)
export interface WorkspaceNames {
  branchSlug: string            // feat/x → feat-x
  branchSlugSafe: string        // feat/x → feat_x (lowercased, [^a-zA-Z0-9] → _)
  worktreeDirRelative: string   // dirPattern resolved; caller resolves against RepoPath
  dbName: DbName
  proxyDomain: ProxyDomain
}
export const deriveNames: (wt: WorktreeConfig, project: ProjectAlias, branch: BranchName) => WorkspaceNames
export const resolvePattern: (pattern: string, vars: Record<string, string>) => string
// vars: { branch_slug, branch_slug_safe, project }

// domain/workspace-locate.ts — kills 5 copies of process.cwd() matching
export const locateWorkspace: (
  workspaces: ReadonlyArray<Workspace>,
  query: { cwd: string; branch?: string }
) => Option.Option<Workspace>
// branch matching precedence: exact → endsWith(`/${q}`) → includes(q)
// cwd matching: cwd === path || cwd.startsWith(path + "/")
// branch query takes precedence over cwd when provided

// domain/caddyfile.ts — extracted verbatim semantics from current ProxyService
export interface Route { domain: ProxyDomain; port: HostPort }
export const parseRoutes: (content: string) => ReadonlyArray<Route>
export const addRoute:    (content: string, route: Route) => string          // appends block
export const removeRoute: (content: string, domain: string) => string        // removes block, collapses blank runs
export const nextPort:    (routes: ReadonlyArray<Route>, base?: number) => HostPort // fills holes above BASE_PORT=5173

// domain/env-patch.ts — extracted from current EnvService loop body
export interface EnvPatchContext { dbName: DbName; proxyDomain: ProxyDomain; port: HostPort }
export const patchEnvContent: (content: string, env: EnvConfig, ctx: EnvPatchContext) => {
  content: string
  changes: ReadonlyArray<{ key: string; from: string; to: string }>
}
// rules (unchanged from current impl): database_url → swap trailing /db; proxy_url → swap
// origin to https://domain; dev_url → http://localhost:<port><path>; plain → untouched.
```

## Errors (`src/errors.ts` — all `Schema.TaggedError`; DELETE the `Data.TaggedError`/`Data.TaggedClass` ones in services/database/, services/executor/)

```ts
export class DatabaseError extends Schema.TaggedError<DatabaseError>()("DatabaseError", {
  op: Schema.String, database: Schema.String, detail: Schema.String
}) { get message() { return `Database ${this.op} failed for '${this.database}': ${this.detail}` } }

export class DatabaseUnreachableError extends Schema.TaggedError<DatabaseUnreachableError>()(
  "DatabaseUnreachableError", { runtime: Schema.String }  // e.g. "docker:pg17" | "local"
) { get message() { return `Database (${this.runtime}) is not reachable. Start it first, then re-run.` } }
// Everything else unchanged: ShellExecError, ProjectNotFoundError, ParseConfigError,
// EncodeConfigError, file errors, Route*, CertNotFoundError, Update*, Workspace* errors.
```

```ts
// shared error aliases used below
type ConfigReadError  = ParseConfigError | ReadFileError | CreateDirectoryError
type ConfigWriteError = EncodeConfigError | WriteFileError | CreateDirectoryError
type ConfigError      = ConfigReadError | ConfigWriteError
type FsError          = CreateDirectoryError | ReadFileError | WriteFileError
```

## Services — Tier 1: execution seams

```ts
// services/shell.ts
export interface ExecResult { stdout: string; stderr: string; exitCode: number }
export interface ShellCall { command: string; args: ReadonlyArray<string>; cwd?: string }
export interface ScopedShell { exec(command: string, args: ReadonlyArray<string>): Effect<ExecResult, ShellExecError> }

interface ShellShape {
  exec(command: string, args: ReadonlyArray<string>): Effect<ExecResult, ShellExecError>
  execInteractive(command: string, args: ReadonlyArray<string>): Effect<void, ShellExecError>
  execInDir(cwd: string, command: string, env?: Record<string, string>): Effect<void, ShellExecError>
  inDir(cwd: string): ScopedShell
}
export class ShellService extends Context.Tag("ship/ShellService")<ShellService, ShellShape>() {
  static layer: Layer.Layer<ShellService, never, CommandExecutor.CommandExecutor>
  static layerMemory: (opts?: {
    stub?: (call: ShellCall) => ExecResult | ShellExecError   // default: { stdout:"", stderr:"", exitCode:0 }
    calls?: Ref.Ref<ReadonlyArray<ShellCall>>                  // appended per invocation (incl. interactive/inDir)
  }) => Layer.Layer<ShellService>
}
```

```ts
// services/runner.ts — replaces services/executor/*. Runtime is PER-CALL DATA (D1).
interface CommandRunnerShape {
  run(rt: ExecutionRuntime, command: string, args: ReadonlyArray<string>): Effect<ExecResult, ShellExecError>
  runScript(rt: ExecutionRuntime, script: string): Effect<ExecResult, ShellExecError>           // D4: explicit POSIX-shell contract
  runInteractive(rt: ExecutionRuntime, command: string, args: ReadonlyArray<string>): Effect<void, ShellExecError>
}
export class CommandRunner extends Context.Tag("ship/CommandRunner")<CommandRunner, CommandRunnerShape>() {
  static layer: Layer.Layer<CommandRunner, never, ShellService>
  static layerMemory: (opts?: { stub?; calls?: Ref<ReadonlyArray<RunnerCall>> }) => Layer.Layer<CommandRunner>
}
// prod mapping:
//   local  → shell.exec(cmd, args)                        | runScript: shell.exec("sh", ["-c", script])
//   docker → shell.exec("docker", ["exec", container, cmd, ...args])
//            runScript: shell.exec("docker", ["exec", container, "bash", "-c", script])
//            runInteractive: shell.execInteractive("docker", ["exec", "-it", container, cmd, ...args])
```

## Services — Tier 2: resource seams

```ts
// services/database.ts — engine-agnostic interface; replaces old database.ts AND database/ dirs
export interface DatabaseTarget { runtime: ExecutionRuntime; user: string }

interface DatabaseShape {
  create(t: DatabaseTarget, db: DbName): Effect<void, DatabaseError>
  drop(t: DatabaseTarget, db: DbName): Effect<void, DatabaseError>             // idempotent (--if-exists)
  clone(t: DatabaseTarget, source: DbName, db: DbName): Effect<void, DatabaseError>
  exists(t: DatabaseTarget, db: DbName): Effect<boolean>                       // false on any failure
  ping(t: DatabaseTarget): Effect<boolean>                                     // pg_isready -q; D3
  query(t: DatabaseTarget, db: DbName, sql: string): Effect<string, DatabaseError>
  session(t: DatabaseTarget, db: DbName): Effect<void, DatabaseError>          // interactive psql (ship open db)
}
export class DatabaseService extends Context.Tag("ship/DatabaseService")<DatabaseService, DatabaseShape>() {
  static layerPostgres: Layer.Layer<DatabaseService, never, CommandRunner>
  static layer: Layer.Layer<DatabaseService, never, CommandRunner>             // = layerPostgres (default engine)
  static layerMemory: (initial?: ReadonlyArray<DbName>) => Layer.Layer<DatabaseService>
  // memory semantics: Ref<Set<DbName>>; create adds (error if present), drop removes (no error if
  // absent), clone requires source exists, exists/ping from the set (ping always true),
  // query returns "" and records, session records.
}
// postgres adapter commands (assert these EXACTLY in tests):
//   create → runner.run(rt, "createdb", ["-U", user, db])
//   drop   → runner.run(rt, "dropdb", ["--if-exists", "-U", user, db])
//   clone  → createdb then runner.runScript(rt, `pg_dump -U ${user} ${source} | psql -U ${user} ${db}`)
//   exists → runner.run(rt, "psql", ["-U", user, "-lqt"]) + line-prefix scan, catchAll → false
//   ping   → runner.run(rt, "pg_isready", ["-q"]) → true/false
//   query  → runner.run(rt, "psql", ["-U", user, db, "-c", sql]) → stdout
//   session→ runner.runInteractive(rt, "psql", ["-U", user, db])
```

```ts
// services/git.ts — same 13 methods, branded params
interface GitShape {
  worktreeAdd(repo: RepoPath, path: WorktreePath, branch: BranchName, base?: string): Effect<void, ShellExecError>
  worktreeRemove(repo: RepoPath, path: WorktreePath, force: boolean): Effect<void, ShellExecError>
  worktreeList(repo: RepoPath): Effect<ReadonlyArray<{ path: string; branch: string }>, ShellExecError>
  deleteBranch(repo: RepoPath, branch: BranchName): Effect<void, ShellExecError>
  deleteRemoteBranch(repo: RepoPath, branch: BranchName): Effect<void, ShellExecError>
  repoRoot(repo: string): Effect<string, ShellExecError>
  currentBranch(repo: RepoPath): Effect<string, ShellExecError>
  fetch(repo: RepoPath): Effect<void, ShellExecError>
  pullFfOnly(repo: RepoPath): Effect<void, ShellExecError>
  isDirty(repo: RepoPath): Effect<boolean, ShellExecError>
  revParseHead(repo: RepoPath): Effect<string, ShellExecError>
  revParse(repo: RepoPath, ref: string): Effect<string, ShellExecError>
  updateBranch(repo: RepoPath, branch: string): Effect<void, ShellExecError>
}
export class GitService extends Context.Tag("ship/GitService")<GitService, GitShape>() {
  static layer: Layer.Layer<GitService, never, ShellService>
  static layerMemory: (state?: Partial<MemoryRepoState>) => Layer.Layer<GitService>
}
export interface MemoryRepoState {     // minimal semantics for orchestrator tests
  branches: Set<string>; remoteBranches: Set<string>
  worktrees: Map<string /*path*/, string /*branch*/>
  dirty: boolean; head: string
}
// memory semantics: worktreeAdd registers worktree + creates branch if missing (matching the
// prod local→remote→create precedence is NOT required; registering + branch-set update is);
// worktreeRemove/deleteBranch error (ShellExecError) if missing unless force; lists reflect state.
```

```ts
// services/config.ts — same methods, converted; self-migrating load (D10)
interface ConfigShape {
  configDir(): string
  loadConfig(): Effect<ShipConfig, ConfigReadError>
  saveConfig(c: ShipConfig): Effect<void, ConfigWriteError>
  getProject(alias: ProjectAlias): Effect<ProjectConfig, ProjectNotFoundError | ConfigReadError>
  addProject(alias: ProjectAlias, p: ProjectConfig): Effect<void, ConfigError>
  loadWorkspaces(): Effect<Workspaces, ConfigReadError>
  saveWorkspaces(ws: Workspaces): Effect<void, ConfigWriteError>
  addWorkspace(w: Workspace): Effect<void, ConfigError>
  removeWorkspace(project: ProjectAlias, branch: BranchName): Effect<void, ConfigError>
  findWorkspace(project: ProjectAlias, branch: BranchName): Effect<Option.Option<Workspace>, ConfigReadError>
}
export class ConfigService extends Context.Tag("ship/ConfigService")<ConfigService, ConfigShape>() {
  static layer: Layer.Layer<ConfigService, never, FileSystem.FileSystem | Path.Path>  // ~/.config/ship
  static layerMemory: (initial?: { config?: ShipConfig; workspaces?: Workspaces }) => Layer.Layer<ConfigService>
}
```

```ts
// services/proxy.ts — IO only; ALL Caddyfile text manipulation via domain/caddyfile
interface ProxyShape {
  configDir(): Effect<string>
  caddyfilePath(): Effect<string>
  ensureSetup(): Effect<void, FsError>
  isRunning(): Effect<boolean>
  getRoutes(): Effect<ReadonlyArray<Route>, FsError>
  addRoute(domain: ProxyDomain, port: HostPort): Effect<void, RouteExistsError | FsError>
  removeRoute(domain: string): Effect<void, RouteNotFoundError | FsError>
  reload(): Effect<void>
  start(): Effect<void, ShellExecError | FsError>
  stop(): Effect<void>
  status(): Effect<{ running: boolean; routes: ReadonlyArray<Route> }, FsError>
  trust(): Effect<void, CertNotFoundError | ShellExecError | ReadFileError>
  nextPort(): Effect<HostPort, FsError>
  editCaddyfile(): Effect<void, ShellExecError | FsError>
}
export class ProxyService extends Context.Tag("ship/ProxyService")<ProxyService, ProxyShape>() {
  static layer: Layer.Layer<ProxyService, never, FileSystem.FileSystem | Path.Path | ShellService>
  static layerMemory: (initial?: { routes?: ReadonlyArray<Route>; running?: boolean }) => Layer.Layer<ProxyService>
}
```

```ts
// services/env.ts — thin FS shell over domain/env-patch
export interface PatchResult { file: string; changes: ReadonlyArray<{ key: string; from: string; to: string }> }
interface EnvShape {
  patchEnvFiles(sourceDir: string, targetDir: string, env: EnvConfig, ctx: EnvPatchContext):
    Effect<ReadonlyArray<PatchResult>, FsError>
}
export class EnvService extends Context.Tag("ship/EnvService")<EnvService, EnvShape>() {
  static layer: Layer.Layer<EnvService, never, FileSystem.FileSystem | Path.Path>
  static layerMemory: (opts?: { results?: ReadonlyArray<PatchResult>; calls?: Ref<...> }) => Layer.Layer<EnvService>
}

// services/editor.ts
interface EditorShape { open(path: string): Effect<void> }
export class EditorService extends Context.Tag("ship/EditorService")<EditorService, EditorShape>() {
  static layer: Layer.Layer<EditorService, never, ShellService | ConfigService | FileSystem.FileSystem>
  static layerMemory: (opened?: Ref.Ref<ReadonlyArray<string>>) => Layer.Layer<EditorService>
}

// services/claude.ts
interface ClaudeShape { removeProjectConvo(absPath: string): Effect<boolean> }
export class ClaudeService extends Context.Tag("ship/ClaudeService")<ClaudeService, ClaudeShape>() {
  static layer: Layer.Layer<ClaudeService, never, FileSystem.FileSystem | Path.Path>
  static layerMemory: (removed?: Ref.Ref<ReadonlyArray<string>>) => Layer.Layer<ClaudeService>
}

// services/updater.ts — tag + layer ONLY (D9: network/spawn seams out of scope this pass)
export class UpdaterService extends Context.Tag("ship/UpdaterService")<UpdaterService, UpdaterShape>() {
  static layer: Layer.Layer<UpdaterService, never, ConfigService | ShellService | FileSystem.FileSystem | Path.Path>
}
// shape unchanged: readCache/writeCache/isCacheStale/fetchLatestVersion/refreshCache/
// notifyIfAvailable/spawnBackgroundRefreshIfStale/installLatest
```

## Services — Tier 3: orchestrators (real `layer` only — D7)

```ts
// services/sync.ts — converted; db readiness via ping (was isContainerRunning)
export interface SyncResult {
  fetched: boolean; pulled: boolean; headMoved: boolean
  installed: boolean; migrated: boolean; skippedPull?: string
}
interface SyncShape { sync(config: ProjectConfig, base?: string): Effect<SyncResult, ShellExecError> }
export class SyncService extends Context.Tag("ship/SyncService")<SyncService, SyncShape>() {
  static layer: Layer.Layer<SyncService, never, GitService | ShellService | DatabaseService>
}
```

```ts
// services/workspace.ts — NEW deep module. The provisioning state machine
// (probe → resume-from-any-partial-state → execute) moves out of create.ts.
// Step progress is a Stream (user decision, supersedes the callback draft).

export type ProvisionStep =
  | "probe" | "register" | "sync-base" | "worktree" | "database"
  | "env" | "install" | "generate" | "migrate" | "proxy-route"
export type TeardownStep =
  | "proxy-route" | "database" | "worktree" | "branch" | "remote-branch" | "claude-convos"
export type ResetStep = "drop" | "create" | "clone" | "migrate" | "seed"

export interface StepEvent<S extends string> {
  _tag: "step"
  step: S
  status: "done" | "skipped-existing" | "warning"
  detail?: string                                  // e.g. env-change summaries, warning reasons
}
export interface ProvisionResult {
  workspace: Workspace
  alreadyComplete: boolean                          // fully-provisioned short-circuit (no steps ran)
  envChanges: ReadonlyArray<PatchResult>
}
export type ProvisionEvent = StepEvent<ProvisionStep> | { _tag: "completed"; result: ProvisionResult }
export interface TeardownOptions { removeWorktree: boolean; force: boolean; deleteRemoteBranch: boolean }

export type ProvisionError =
  | DatabaseUnreachableError | ShellExecError | DatabaseError
  | ConfigError | FsError    // env/proxy/config writes

interface WorkspaceShape {
  // Emits step events as they happen; final element is { _tag: "completed", result }.
  provision(input: {
    projectAlias: ProjectAlias
    projectConfig: ProjectConfig
    branch: BranchName
    baseBranch: Option.Option<string>
  }): Stream.Stream<ProvisionEvent, ProvisionError>

  // Best-effort: individual step failures emit status:"warning" events; stream never fails.
  // Does NOT touch the workspace registry — caller removes/batches (D6).
  teardown(ws: Workspace, pc: ProjectConfig, opts: TeardownOptions): Stream.Stream<StepEvent<TeardownStep>>

  resetDatabase(ws: Workspace, pc: ProjectConfig, opts: { fresh: boolean }):
    Stream.Stream<StepEvent<ResetStep>, DatabaseError | ShellExecError>
}
export class WorkspaceService extends Context.Tag("ship/WorkspaceService")<WorkspaceService, WorkspaceShape>() {
  static layer: Layer.Layer<WorkspaceService, never,
    ConfigService | GitService | DatabaseService | ProxyService |
    EnvService | SyncService | ShellService | ClaudeService | Path.Path>
}
```

### provision semantics (behavior contract — these become the tests)

1. Derive names via `domain/workspace-name`; resolve worktree dir against `pc.path`.
2. Probe: registered workspace? worktree on disk? db exists? route exists? (each probed
   defensively; probe failures count as absent).
3. Port: reuse registered workspace port → else existing route port → else `proxy.nextPort()`.
4. If ALL four present → emit `completed` with `alreadyComplete: true` (no mutations).
5. `db.ping` false → fail stream with `DatabaseUnreachableError` (before any mutation).
6. If partially present → emit `probe` step with `detail: "resuming partial setup"`.
7. Register workspace entry FIRST (so `down` can clean partial state) — `register` step.
8. Steps in order, each emitting done/skipped-existing/warning:
   sync-base (skipped when worktree already on disk; sync failures → warning, not error),
   worktree, database (clone from `pc.database.source`), env (patch results in detail/result),
   install/generate/migrate (only when configured; run via `shell.execInDir` in worktree),
   proxy-route (addRoute; RouteExists → skipped-existing; other failures → warning).
9. `created` date: today ISO (yyyy-mm-dd), via Clock (testable with TestClock).

### teardown semantics

Order: proxy-route → database (drop) → [if removeWorktree: worktree (git remove, force-rm
fallback), branch, [if deleteRemoteBranch: remote-branch], claude-convos]. Every failure →
warning event, continue. Call sites:
- `down`:  `{ removeWorktree: !dbOnly, force, deleteRemoteBranch: false }` + caller removes registry entry
- `gc`:    `{ removeWorktree: true, force: true, deleteRemoteBranch: true }` + caller batch-writes registry once

### resetDatabase semantics

drop → (fresh ? create : clone source) → migrate (if configured) → seed (if fresh && configured).

## Command call sites (after)

```ts
// create.ts (~300 → ~100 lines): prompts + Stream rendering + editor prompt
const result = yield* ws.provision({...}).pipe(
  Stream.tap(renderEvent),
  Stream.runLast, // → completed event carries ProvisionResult
)
// down.ts/gc.ts/reset.ts: Stream.runForEach(render) over teardown/resetDatabase
// open.ts/db.ts/reset.ts/up.ts/down.ts: locateWorkspace(workspaces, { cwd, branch? }) — pure
// open.ts "db": db.session({ runtime: pc.database.runtime, user: pc.database.user }, ws.dbName)
// db.ts exec:   db.query(target, ws.dbName, sql)
// index.ts:     deriveNames(...) replaces its local copies
// gc.ts PR check (gh pr view) stays inline this pass (recorded: future GithubService seam)
```

## Call graph — production

```
main.ts MainLayer
└─ commands (@effect/cli)
   ├─ WorkspaceService ──[seam]── WorkspaceService.layer
   │    ├─ ConfigService ──[seam]── .layer ─→ FileSystem/Path (NodeContext) → ~/.config/ship
   │    ├─ GitService ────[seam]── .layer ─→ ShellService
   │    ├─ SyncService ───[seam]── .layer ─→ GitService · ShellService · DatabaseService
   │    ├─ DatabaseService [seam]── .layerPostgres ─→ CommandRunner ──[seam]── .layer ─→ ShellService
   │    │                                             (per-call ExecutionRuntime: docker exec | local)
   │    ├─ ProxyService ──[seam]── .layer ─→ FileSystem · ShellService(docker) + domain/caddyfile (pure)
   │    ├─ EnvService ────[seam]── .layer ─→ FileSystem + domain/env-patch (pure)
   │    └─ ClaudeService ─[seam]── .layer ─→ FileSystem
   ├─ EditorService ──[seam]── .layer ─→ ShellService · ConfigService · FileSystem
   ├─ UpdaterService ─[seam]── .layer ─→ ConfigService · ShellService · fetch/spawn (node)
   └─ ShellService ───[seam]── .layer ─→ CommandExecutor (NodeContext)   ← the only OS edge
```

## Call graph — test

```
test/services/workspace.test.ts        ← resume matrix, teardown divergence, reset
└─ WorkspaceService.layer (REAL orchestrator — wiring under test)
   ├─ ConfigService.layerMemory({config, workspaces})
   ├─ GitService.layerMemory(repoState)
   ├─ DatabaseService.layerMemory(["app_dev"])
   ├─ ProxyService.layerMemory({routes})
   ├─ EnvService.layerMemory() · ClaudeService.layerMemory()
   ├─ SyncService.layer (real, over memory leaves)
   └─ ShellService.layerMemory({calls})      ← asserts install/generate/migrate invocations
   (assert: collected Stream events + final memory-adapter state)

test/services/database-postgres.test.ts
└─ DatabaseService.layerPostgres (REAL) ─→ CommandRunner.layerMemory({stub, calls})
   (assert exact argv per op; docker vs local runtime variants)

test/services/runner.test.ts
└─ CommandRunner.layer (REAL) ─→ ShellService.layerMemory({calls})
   (assert docker-exec prefixing, bash -c script wrapping, local passthrough)

test/services/sync.test.ts
└─ SyncService.layer (REAL) ─→ Git/Shell/Database memory layers
   (dirty-tree skip, non-ff skip, headMoved install/migrate gating, custom-base path)

test/services/config.test.ts ─ ConfigService.layer over a tmpdir OR layerMemory contract
   + legacy-config self-migration (decode old { container } shape, write-back canonical)
test/services/proxy.test.ts  ─ ProxyService.layerMemory contract (routes add/rm/nextPort)
test/domain/*.test.ts        ─ pure: workspace-name, workspace-locate, caddyfile, env-patch
```

## Layer composition (`main.ts`)

```ts
const MainLayer = Layer.mergeAll(
  WorkspaceService.layer, SyncService.layer, EditorService.layer, UpdaterService.layer,
  DatabaseService.layer, GitService.layer, ProxyService.layer, EnvService.layer,
  ConfigService.layer, ClaudeService.layer, CommandRunner.layer, ShellService.layer,
  LogLevelLive
).pipe(Layer.provideMerge(NodeContext.layer))
```

## Test infrastructure

- devDeps: `vitest`, `@effect/vitest`. Script: `"test": "vitest run"`.
- `it.effect` + `assert` from `@effect/vitest`; provide layers per test via `Effect.provide`.
- No `vi.mock`/`vi.spyOn` anywhere. Validate decoded shapes with the same schemas production uses.
- `bun run typecheck` must pass per slice (includes effect-language-service diagnostics).

## Recorded decisions

| # | Decision | Rejected alternative & why |
|---|----------|---------------------------|
| D1 | Runtime is per-call data (`ExecutionRuntime` in `DatabaseConfig`), resolved by `CommandRunner` | `SHIP_DOCKER_CONTAINER` env var at layer build — one process-level layer can't serve `gc` spanning projects |
| D2 | One file per service; layers as statics on tag class | `definition/`+`layer/` dirs — violates conventions, doubles navigation |
| D3 | `ping` (pg_isready) replaces `isContainerRunning` | container-check is docker-specific; readiness is engine-agnostic |
| D4 | `runScript` is a distinct CommandRunner method | hiding `bash -c` inside `run` — POSIX-shell contract must be visible at the seam |
| D5 | Step events as `Stream<Event>` (USER OVERRIDE of callback draft) | onEvent callback — user prefers Stream; tests use Stream.runCollect |
| D6 | teardown never fails; warnings as events; registry writes stay with caller | throwing teardown — best-effort is today's contract; gc batches one registry write |
| D7 | Orchestrators get no layerMemory; tested via real layer over memory leaves | stubbing the unit under test verifies nothing |
| D8 | EditorService stays out of WorkspaceService | editor-open is prompt-driven presentation |
| D9 | Updater network/spawn seams out of scope | a ReleaseClient seam is real but low-traffic; later |
| D10 | Legacy `DatabaseConfig` self-migrates on load (decode old shape, write back canonical) | breaking change requiring manual `ship init` re-runs |
| D11 | Full branding of domain scalars (USER CHOICE) | derived-names-only — user wants brands across all schemas/signatures |
| D12 | `gh pr view` stays inline in gc.ts | GithubService seam — only one caller today; recorded for later |

## Execution slices (strict red → green; `bun run typecheck` exit 0 gates each)

1. **Slice 0 — infra**: vitest + @effect/vitest, `test` script, smoke test runs.
2. **Slice 1 — schema + domain (pure)**: `schema/ids.ts` brands; `ExecutionRuntime` +
   `DatabaseConfig.runtime` with legacy decode; red tests then implement
   `workspace-name`, `workspace-locate`, `caddyfile`, `env-patch`. Existing services keep
   compiling (legacy `container` accessor may temporarily remain via decode).
3. **Slice 2 — execution seams**: convert `ShellService` (+layerMemory); new `CommandRunner`
   (red: prefix/script/interactive tests) → green. Delete `services/executor/`.
4. **Slice 3 — database**: new `DatabaseService` (red: postgres adapter contract via memory
   runner; memory adapter contract) → green. Delete `services/database/` dirs + old
   `services/database.ts`; update `reset`/`db`/`open`/`sync`/`create`/`down`/`gc`/`index`
   call sites to compile (still fat commands — thinning is Slice 5).
5. **Slice 4 — remaining conversions**: Config (self-migration test), Proxy (over caddyfile
   codec), Git (+layerMemory semantics tests), Editor, Env, Claude, Sync (red: orchestrator
   tests over memory leaves), Updater. main.ts updated as services convert.
6. **Slice 5 — WorkspaceService**: red tests — provision resume matrix (registered ×
   worktree × db × route), unreachable-db failure, port reuse precedence, register-first
   ordering, teardown option divergence (down vs gc), warnings-not-failures, resetDatabase
   fresh/clone paths → green. Thin `create`/`down`/`gc`/`reset`/`up`/`open`/`db`/`index`.
7. **Slice 6 — assembly**: final MainLayer, delete dead files, full suite + typecheck +
   `bun run build`.
