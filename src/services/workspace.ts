import { FileSystem, Path } from "@effect/platform"
import { Clock, Context, Effect, Layer, Option, Stream } from "effect"
import { deriveNames } from "../domain/workspace-name.js"
import {
  DatabaseError,
  DatabaseUnreachableError,
  type CreateDirectoryError,
  type EncodeConfigError,
  type ParseConfigError,
  type ReadFileError,
  type ShellExecError,
  type WriteFileError,
} from "../errors.js"
import type { ProjectConfig } from "../schema/config.js"
import {
  BranchName,
  DbName,
  HostPort,
  ProjectAlias,
  ProxyDomain,
  WorktreePath,
} from "../schema/ids.js"
import { Workspace } from "../schema/workspace.js"
import { ClaudeService } from "./claude.js"
import { ConfigService } from "./config.js"
import { DatabaseService, type DatabaseTarget } from "./database.js"
import { EnvService, type PatchResult } from "./env.js"
import { GitService } from "./git.js"
import { ProxyService } from "./proxy.js"
import { ShellService } from "./shell.js"
import { SyncService, type SyncResult } from "./sync.js"

// ---------------------------------------------------------------------------
// WorkspaceService — the deep orchestrator. The provisioning state machine
// (probe → resume-from-any-partial-state → execute) lives here, off the
// commands. Progress is a Stream of events (D5).
// ---------------------------------------------------------------------------

export type ProvisionStep =
  | "probe"
  | "register"
  | "sync-base"
  | "worktree"
  | "database"
  | "env"
  | "install"
  | "generate"
  | "migrate"
  | "proxy-route"

export type TeardownStep =
  | "proxy-route"
  | "database"
  | "worktree"
  | "branch"
  | "remote-branch"
  | "claude-convos"

export type ResetStep = "drop" | "create" | "clone" | "migrate" | "seed"

export interface StepEvent<S extends string> {
  readonly _tag: "step"
  readonly step: S
  readonly status: "done" | "skipped-existing" | "warning"
  readonly detail?: string
}

export interface ProvisionResult {
  readonly workspace: Workspace
  readonly alreadyComplete: boolean
  readonly envChanges: ReadonlyArray<PatchResult>
}

export type ProvisionEvent =
  | StepEvent<ProvisionStep>
  | { readonly _tag: "completed"; readonly result: ProvisionResult }

export interface TeardownOptions {
  readonly removeWorktree: boolean
  readonly force: boolean
  readonly deleteRemoteBranch: boolean
}

type FsError = CreateDirectoryError | ReadFileError | WriteFileError
type ConfigError =
  | ParseConfigError
  | ReadFileError
  | CreateDirectoryError
  | EncodeConfigError
  | WriteFileError

export type ProvisionError =
  | DatabaseUnreachableError
  | ShellExecError
  | DatabaseError
  | ConfigError
  | FsError

export interface ProvisionInput {
  readonly projectAlias: ProjectAlias
  readonly projectConfig: ProjectConfig
  readonly branch: BranchName
  readonly baseBranch: Option.Option<string>
}

export interface WorkspaceShape {
  readonly provision: (
    input: ProvisionInput
  ) => Stream.Stream<ProvisionEvent, ProvisionError>
  readonly teardown: (
    ws: Workspace,
    pc: ProjectConfig,
    opts: TeardownOptions
  ) => Stream.Stream<StepEvent<TeardownStep>>
  readonly resetDatabase: (
    ws: Workspace,
    pc: ProjectConfig,
    opts: { fresh: boolean }
  ) => Stream.Stream<StepEvent<ResetStep>, DatabaseError | ShellExecError>
}

// ---------------------------------------------------------------------------
// Event helpers
// ---------------------------------------------------------------------------

const step = <S extends string>(
  s: S,
  status: StepEvent<S>["status"],
  detail?: string
): StepEvent<S> => ({ _tag: "step", step: s, status, detail })

export class WorkspaceService extends Context.Tag("ship/WorkspaceService")<
  WorkspaceService,
  WorkspaceShape
>() {
  static layer: Layer.Layer<
    WorkspaceService,
    never,
    | ConfigService
    | GitService
    | DatabaseService
    | ProxyService
    | EnvService
    | SyncService
    | ShellService
    | ClaudeService
    | Path.Path
    | FileSystem.FileSystem
  > = Layer.effect(
    WorkspaceService,
    Effect.gen(function* () {
      const config = yield* ConfigService
      const git = yield* GitService
      const db = yield* DatabaseService
      const proxy = yield* ProxyService
      const env = yield* EnvService
      const sync = yield* SyncService
      const shell = yield* ShellService
      const claude = yield* ClaudeService
      const pathSvc = yield* Path.Path
      const fs = yield* FileSystem.FileSystem

      const runtimeLabel = (pc: ProjectConfig): string =>
        pc.database.runtime._tag === "docker"
          ? `docker:${pc.database.runtime.container}`
          : "local"

      const dbTargetOf = (pc: ProjectConfig): DatabaseTarget => ({
        runtime: pc.database.runtime,
        user: pc.database.user,
      })

      // -- provision -----------------------------------------------------

      const provision: WorkspaceShape["provision"] = (input) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const { projectAlias, projectConfig: pc, branch, baseBranch } = input
            const events: Array<ProvisionEvent> = []
            const emit = (e: ProvisionEvent) => {
              events.push(e)
            }

            // 1. Derive names; resolve worktree dir against pc.path.
            const names = deriveNames(pc.worktree, projectAlias, branch)
            const worktreeDir = WorktreePath.make(
              pathSvc.resolve(pc.path, names.worktreeDirRelative)
            )
            const dbName = names.dbName
            const proxyDomain = names.proxyDomain
            const target = dbTargetOf(pc)

            // 2. Probe each resource defensively (probe failures = absent).
            const existingWs = yield* config
              .findWorkspace(projectAlias, branch)
              .pipe(Effect.orElseSucceed(() => Option.none<Workspace>()))

            const worktrees = yield* git
              .worktreeList(pc.path)
              .pipe(Effect.orElseSucceed(() => []))
            const worktreeExists = worktrees.some((w) => w.path === worktreeDir)

            const pingOk = yield* db.ping(target)
            const dbExists = pingOk
              ? yield* db
                  .exists(target, dbName)
                  .pipe(Effect.orElseSucceed(() => false))
              : false

            const routes = yield* proxy
              .getRoutes()
              .pipe(Effect.orElseSucceed(() => []))
            const existingRoute = routes.find((r) => r.domain === proxyDomain)

            // 3. Port precedence: registered ws → existing route → nextPort.
            const port = Option.isSome(existingWs)
              ? existingWs.value.port
              : existingRoute
                ? existingRoute.port
                : yield* proxy
                    .nextPort()
                    .pipe(Effect.orElseSucceed(() => HostPort.make(5173)))

            // 4. All four present → short-circuit, no mutations.
            const allPresent =
              Option.isSome(existingWs) &&
              worktreeExists &&
              dbExists &&
              !!existingRoute
            if (allPresent) {
              const workspace =
                Option.getOrNull(existingWs) ??
                new Workspace({
                  project: projectAlias,
                  branch,
                  path: worktreeDir,
                  port,
                  dbName,
                  proxyDomain,
                  created: "",
                })
              emit({
                _tag: "completed",
                result: { workspace, alreadyComplete: true, envChanges: [] },
              })
              return Stream.fromIterable(events)
            }

            // 5. db.ping false → fail before any mutation.
            if (!pingOk) {
              return Stream.fail(
                new DatabaseUnreachableError({ runtime: runtimeLabel(pc) })
              )
            }

            // 6. Partial setup → probe event.
            const resuming =
              Option.isSome(existingWs) ||
              worktreeExists ||
              dbExists ||
              !!existingRoute
            if (resuming) {
              emit(step("probe", "done", "resuming partial setup"))
            }

            // 7. Register the workspace entry FIRST.
            const created = yield* todayIso
            const workspace = Option.getOrElse(
              existingWs,
              () =>
                new Workspace({
                  project: projectAlias,
                  branch,
                  path: worktreeDir,
                  port,
                  dbName,
                  proxyDomain,
                  created,
                })
            )
            if (Option.isNone(existingWs)) {
              yield* config.addWorkspace(workspace)
            }
            emit(step("register", Option.isSome(existingWs) ? "skipped-existing" : "done"))

            // 8a. sync-base (skip when worktree already on disk).
            if (worktreeExists) {
              emit(step("sync-base", "skipped-existing"))
            } else {
              const syncResult = yield* sync
                .sync(pc, Option.getOrUndefined(baseBranch))
                .pipe(
                  Effect.map((r) => ({ ok: true as const, r })),
                  Effect.catchAll((e) =>
                    Effect.succeed({ ok: false as const, message: e.message })
                  )
                )
              if (syncResult.ok) {
                emit(
                  step(
                    "sync-base",
                    "done",
                    syncSummary(syncResult.r, baseBranch, pc.database.source)
                  )
                )
              } else {
                emit(step("sync-base", "warning", syncResult.message))
              }
            }

            // 8b. worktree.
            if (worktreeExists) {
              emit(step("worktree", "skipped-existing"))
            } else {
              yield* git.worktreeAdd(
                pc.path,
                worktreeDir,
                branch,
                Option.getOrUndefined(baseBranch)
              )
              emit(step("worktree", "done"))
            }

            // 8c. database (clone from pc.database.source).
            if (dbExists) {
              emit(step("database", "skipped-existing"))
            } else {
              yield* db.clone(target, pc.database.source, dbName)
              emit(step("database", "done"))
            }

            // 8d. env.
            const envChanges = yield* env.patchEnvFiles(pc.path, worktreeDir, pc.env, {
              dbName,
              proxyDomain,
              port,
            })
            const changeCount = envChanges.reduce((n, r) => n + r.changes.length, 0)
            emit(step("env", "done", `${changeCount} changes`))

            // 8e. install / generate / migrate (only when configured).
            if (pc.commands.install) {
              yield* shell.execInDir(worktreeDir, pc.commands.install)
              emit(step("install", "done"))
            }
            if (pc.commands.generate) {
              yield* shell.execInDir(worktreeDir, pc.commands.generate)
              emit(step("generate", "done"))
            }
            if (pc.commands.migrate) {
              yield* shell.execInDir(worktreeDir, pc.commands.migrate)
              emit(step("migrate", "done"))
            }

            // 8f. proxy-route.
            if (existingRoute) {
              emit(step("proxy-route", "skipped-existing"))
            } else {
              const routeResult = yield* proxy.addRoute(proxyDomain, port).pipe(
                Effect.map(() => ({ ok: true as const })),
                Effect.catchAll((e) =>
                  Effect.succeed({ ok: false as const, message: e.message })
                )
              )
              if (routeResult.ok) {
                emit(step("proxy-route", "done"))
              } else {
                emit(step("proxy-route", "warning", routeResult.message))
              }
            }

            emit({
              _tag: "completed",
              result: { workspace, alreadyComplete: false, envChanges },
            })

            return Stream.fromIterable(events)
          })
        )

      // -- teardown (never fails; warnings as events) --------------------

      const teardown: WorkspaceShape["teardown"] = (ws, pc, opts) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const events: Array<StepEvent<TeardownStep>> = []
            const target = dbTargetOf(pc)

            // proxy-route.
            events.push(
              yield* proxy.removeRoute(ws.proxyDomain).pipe(
                Effect.as(step<TeardownStep>("proxy-route", "done")),
                Effect.catchAll((e) =>
                  Effect.succeed(step<TeardownStep>("proxy-route", "warning", e.message))
                )
              )
            )

            // database (drop).
            events.push(
              yield* db.drop(target, ws.dbName).pipe(
                Effect.as(step<TeardownStep>("database", "done")),
                Effect.catchAll((e) =>
                  Effect.succeed(step<TeardownStep>("database", "warning", e.message))
                )
              )
            )

            if (opts.removeWorktree) {
              // worktree (git remove, with a filesystem force-remove fallback:
              // if `git worktree remove` refuses — e.g. uncommitted changes
              // without --force, or corrupt metadata — still clear the dir from
              // disk so no orphan is left behind).
              events.push(
                yield* git.worktreeRemove(pc.path, ws.path, opts.force).pipe(
                  Effect.as(step<TeardownStep>("worktree", "done")),
                  Effect.orElse(() =>
                    fs
                      .remove(ws.path, { recursive: true })
                      .pipe(
                        Effect.as(
                          step<TeardownStep>("worktree", "done", "removed (force)")
                        )
                      )
                  ),
                  Effect.catchAll((e) =>
                    Effect.succeed(step<TeardownStep>("worktree", "warning", e.message))
                  )
                )
              )

              // branch.
              events.push(
                yield* git.deleteBranch(pc.path, ws.branch).pipe(
                  Effect.as(step<TeardownStep>("branch", "done")),
                  Effect.catchAll((e) =>
                    Effect.succeed(step<TeardownStep>("branch", "warning", e.message))
                  )
                )
              )

              // remote-branch.
              if (opts.deleteRemoteBranch) {
                events.push(
                  yield* git.deleteRemoteBranch(pc.path, ws.branch).pipe(
                    Effect.as(step<TeardownStep>("remote-branch", "done")),
                    Effect.catchAll((e) =>
                      Effect.succeed(
                        step<TeardownStep>("remote-branch", "warning", e.message)
                      )
                    )
                  )
                )
              }

              // claude-convos.
              events.push(
                yield* claude.removeProjectConvo(ws.path).pipe(
                  Effect.map((removed) =>
                    step<TeardownStep>(
                      "claude-convos",
                      removed ? "done" : "skipped-existing"
                    )
                  )
                )
              )
            }

            return Stream.fromIterable(events)
          })
        )

      // -- resetDatabase -------------------------------------------------

      const resetDatabase: WorkspaceShape["resetDatabase"] = (ws, pc, opts) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const events: Array<StepEvent<ResetStep>> = []
            const target = dbTargetOf(pc)

            // drop (idempotent).
            yield* db.drop(target, ws.dbName)
            events.push(step("drop", "done"))

            // create (fresh) or clone (source).
            if (opts.fresh) {
              yield* db.create(target, ws.dbName)
              events.push(step("create", "done"))
            } else {
              yield* db.clone(target, pc.database.source, ws.dbName)
              events.push(step("clone", "done"))
            }

            // migrate (if configured).
            if (pc.commands.migrate) {
              yield* shell.execInDir(ws.path, pc.commands.migrate)
              events.push(step("migrate", "done"))
            }

            // seed (if fresh && configured).
            if (opts.fresh && pc.commands.seed) {
              yield* shell.execInDir(ws.path, pc.commands.seed)
              events.push(step("seed", "done"))
            }

            return Stream.fromIterable(events)
          })
        )

      return { provision, teardown, resetDatabase }
    })
  )
}

// Summarize a successful base sync into the sync-base step's `detail`, mirroring
// the legacy create output: head-moved → "<label> fast-forwarded" (plus
// "; migrated <source>" when migrations ran); otherwise "already up to date".
// An empty string (no fetch/no movement worth reporting) renders to nothing.
const syncSummary = (
  r: SyncResult,
  baseBranch: Option.Option<string>,
  source: string
): string => {
  const label = Option.getOrElse(baseBranch, () => "main")
  if (r.headMoved) {
    const base = `${label} fast-forwarded`
    return r.migrated ? `${base}; migrated ${source}` : base
  }
  if (r.fetched) return "already up to date"
  return ""
}

// Today's date as yyyy-mm-dd, via Clock (TestClock-controllable).
const todayIso: Effect.Effect<string> = Clock.currentTimeMillis.pipe(
  Effect.map((ms) => new Date(ms).toISOString().split("T")[0]!)
)
