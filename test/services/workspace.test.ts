import { assert, describe, it } from "@effect/vitest"
import { FileSystem } from "@effect/platform"
import { NodeContext } from "@effect/platform-node"
import { Chunk, Effect, Layer, Option, Ref, Schema, Stream, TestClock } from "effect"
import {
  CommandsConfig,
  DatabaseConfig,
  EnvConfig,
  type ExecutionRuntime,
  ProjectConfig,
  WorktreeConfig,
} from "../../src/schema/config.js"
import {
  BranchName,
  DbName,
  HostPort,
  ProjectAlias,
  ProxyDomain,
  RepoPath,
  WorktreePath,
} from "../../src/schema/ids.js"
import { ShipConfig } from "../../src/schema/config.js"
import { Workspace, type Workspaces } from "../../src/schema/workspace.js"
import { ClaudeService } from "../../src/services/claude.js"
import { ConfigService } from "../../src/services/config.js"
import { DatabaseService } from "../../src/services/database.js"
import { EnvService } from "../../src/services/env.js"
import { GitService, type MemoryRepoState } from "../../src/services/git.js"
import { ProxyService, type Route } from "../../src/services/proxy.js"
import { ShellService, type ShellCall } from "../../src/services/shell.js"
import { SyncService } from "../../src/services/sync.js"
import { WorkspaceService } from "../../src/services/workspace.js"
import type {
  ProvisionEvent,
  ProvisionResult,
  StepEvent,
  TeardownStep,
  ResetStep,
} from "../../src/services/workspace.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const local: ExecutionRuntime = { _tag: "local" }

const alias = Schema.decodeSync(ProjectAlias)("ep")
const branch = Schema.decodeSync(BranchName)("tim/ep-1")
const repo = Schema.decodeSync(RepoPath)("/repo")

// Derived names for branch "tim/ep-1" against the patterns below:
//   dirPattern:        "wt/{branch_slug}"     → "wt/tim-ep-1"  → resolved against /repo → /repo/wt/tim-ep-1
//   dbNamePattern:     "app_{branch_slug_safe}" → "app_tim_ep_1"
//   proxyDomainPattern:"{branch_slug}.test"   → "tim-ep-1.test"
const expectedWorktree = "/repo/wt/tim-ep-1"
const expectedDb = "app_tim_ep_1"
const expectedDomain = "tim-ep-1.test"

const makeProject = (commands: {
  install?: string
  generate?: string
  migrate?: string
  seed?: string
} = {}): ProjectConfig =>
  new ProjectConfig({
    path: repo,
    database: new DatabaseConfig({
      runtime: local,
      user: "app",
      source: Schema.decodeSync(DbName)("app_source"),
      host: "localhost",
      port: 5432,
    }),
    commands: new CommandsConfig(commands),
    env: new EnvConfig({ files: [], autoDetected: {} }),
    worktree: new WorktreeConfig({
      dirPattern: "wt/{branch_slug}",
      proxyDomainPattern: "{branch_slug}.test",
      dbNamePattern: "app_{branch_slug_safe}",
    }),
  })

interface LeafState {
  config?: { config?: ShipConfig; workspaces?: Workspaces }
  repoState?: Partial<MemoryRepoState>
  dbs?: ReadonlyArray<DbName>
  routes?: ReadonlyArray<Route>
}

// Compose the REAL WorkspaceService.layer over in-memory leaves (D7).
const makeLayer = (state: LeafState, shellCalls: Ref.Ref<ReadonlyArray<ShellCall>>) => {
  const leaves = Layer.mergeAll(
    ConfigService.layerMemory(state.config),
    GitService.layerMemory(state.repoState),
    DatabaseService.layerMemory(state.dbs ?? []),
    ProxyService.layerMemory({ routes: state.routes ?? [] }),
    EnvService.layerMemory(),
    ClaudeService.layerMemory(),
    ShellService.layerMemory({ calls: shellCalls }),
    NodeContext.layer,
  )
  return WorkspaceService.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(SyncService.layer.pipe(Layer.provideMerge(leaves)), leaves)
    )
  )
}

const collectProvision = (
  state: LeafState,
  project: ProjectConfig,
  opts?: { baseBranch?: Option.Option<string> }
) =>
  Effect.gen(function* () {
    const shellCalls = yield* Ref.make<ReadonlyArray<ShellCall>>([])
    const events = yield* Effect.gen(function* () {
      const ws = yield* WorkspaceService
      return yield* Stream.runCollect(
        ws.provision({
          projectAlias: alias,
          projectConfig: project,
          branch,
          baseBranch: opts?.baseBranch ?? Option.none(),
        })
      )
    }).pipe(Effect.provide(makeLayer(state, shellCalls)))
    const calls = yield* Ref.get(shellCalls)
    return { events: Chunk.toReadonlyArray(events), calls }
  })

// Provision but also read final config workspaces from the SAME layer instance.
const provisionAndInspect = (
  state: LeafState,
  project: ProjectConfig,
  opts?: { baseBranch?: Option.Option<string> }
) =>
  Effect.gen(function* () {
    const shellCalls = yield* Ref.make<ReadonlyArray<ShellCall>>([])
    const result = yield* Effect.gen(function* () {
      const ws = yield* WorkspaceService
      const config = yield* ConfigService
      const db = yield* DatabaseService
      const proxy = yield* ProxyService
      const git = yield* GitService
      const events = Chunk.toReadonlyArray(
        yield* Stream.runCollect(
          ws.provision({
            projectAlias: alias,
            projectConfig: project,
            branch,
            baseBranch: opts?.baseBranch ?? Option.none(),
          })
        )
      )
      const workspaces = yield* config.loadWorkspaces()
      const dbExists = yield* db.exists(
        { runtime: project.database.runtime, user: project.database.user },
        Schema.decodeSync(DbName)(expectedDb)
      )
      const routes = yield* proxy.getRoutes()
      const worktrees = yield* git.worktreeList(repo)
      return { events, workspaces, dbExists, routes, worktrees }
    }).pipe(Effect.provide(makeLayer(state, shellCalls)))
    const calls = yield* Ref.get(shellCalls)
    return { ...result, calls }
  })

const stepEvents = (events: ReadonlyArray<ProvisionEvent>) =>
  events.filter((e): e is StepEvent<any> => e._tag === "step")

const completedEvent = (
  events: ReadonlyArray<ProvisionEvent>
): ProvisionResult => {
  const c = events.find((e) => e._tag === "completed")
  assert.isDefined(c)
  return (c as { _tag: "completed"; result: ProvisionResult }).result
}

// ---------------------------------------------------------------------------
// provision — fresh
// ---------------------------------------------------------------------------

describe("WorkspaceService.provision (fresh)", () => {
  it.effect("emits full ordered step sequence + completed alreadyComplete=false", () =>
    Effect.gen(function* () {
      const { events, workspaces } = yield* provisionAndInspect(
        { dbs: [Schema.decodeSync(DbName)("app_source")] },
        makeProject({ install: "npm i", generate: "gen", migrate: "mig" })
      )
      const steps = stepEvents(events).map((e) => e.step)
      // register FIRST (before worktree/database). No probe (nothing partial).
      assert.deepStrictEqual(steps, [
        "register",
        "sync-base",
        "worktree",
        "database",
        "env",
        "install",
        "generate",
        "migrate",
        "proxy-route",
      ])
      const result = completedEvent(events)
      assert.strictEqual(result.alreadyComplete, false)
      assert.strictEqual(result.workspace.dbName, expectedDb)
      assert.strictEqual(result.workspace.proxyDomain, expectedDomain)
      assert.strictEqual(result.workspace.path, expectedWorktree)
      // Registry now carries exactly one entry.
      assert.strictEqual(workspaces.length, 1)
      assert.strictEqual(workspaces[0]!.branch, branch)
    })
  )

  it.effect("register precedes worktree and database mutations in event order", () =>
    Effect.gen(function* () {
      const { events } = yield* collectProvision(
        { dbs: [Schema.decodeSync(DbName)("app_source")] },
        makeProject()
      )
      const steps = stepEvents(events).map((e) => e.step)
      const regIdx = steps.indexOf("register")
      const wtIdx = steps.indexOf("worktree")
      const dbIdx = steps.indexOf("database")
      assert.isTrue(regIdx >= 0 && regIdx < wtIdx)
      assert.isTrue(regIdx < dbIdx)
    })
  )

  it.effect("created date comes from Clock (TestClock-controllable)", () =>
    Effect.gen(function* () {
      // 2021-01-01T00:00:00Z = 1609459200000 ms
      yield* TestClock.setTime(1609459200000)
      const { events } = yield* collectProvision(
        { dbs: [Schema.decodeSync(DbName)("app_source")] },
        makeProject()
      )
      const result = completedEvent(events)
      assert.strictEqual(result.workspace.created, "2021-01-01")
    })
  )

  it.effect("install/generate/migrate run via shell.execInDir in the worktree", () =>
    Effect.gen(function* () {
      const { calls } = yield* collectProvision(
        { dbs: [Schema.decodeSync(DbName)("app_source")] },
        makeProject({ install: "npm i", generate: "gen", migrate: "mig" })
      )
      // execInDir is recorded as ShellCall { command, args: [], cwd }
      const inDir = calls.filter((c) => c.cwd === expectedWorktree)
      assert.deepStrictEqual(
        inDir.map((c) => c.command),
        ["npm i", "gen", "mig"]
      )
    })
  )

  it.effect("install/generate/migrate skipped when not configured", () =>
    Effect.gen(function* () {
      const { events, calls } = yield* collectProvision(
        { dbs: [Schema.decodeSync(DbName)("app_source")] },
        makeProject({})
      )
      const steps = stepEvents(events).map((e) => e.step)
      assert.isFalse(steps.includes("install"))
      assert.isFalse(steps.includes("generate"))
      assert.isFalse(steps.includes("migrate"))
      const inDir = calls.filter((c) => c.cwd === expectedWorktree)
      assert.deepStrictEqual(inDir, [])
    })
  )

  it.effect("sync-base done carries an 'already up to date' summary when head did not move", () =>
    Effect.gen(function* () {
      const { events } = yield* collectProvision(
        { dbs: [Schema.decodeSync(DbName)("app_source")] },
        makeProject()
      )
      const syncBase = stepEvents(events).find((s) => s.step === "sync-base")
      assert.strictEqual(syncBase!.status, "done")
      assert.strictEqual(syncBase!.detail, "already up to date")
    })
  )

  it.effect("sync-base done carries a fast-forwarded + migrated summary when head moved", () =>
    Effect.gen(function* () {
      const { events } = yield* collectProvision(
        {
          dbs: [Schema.decodeSync(DbName)("app_source")],
          repoState: { head: "old", headAfterPull: "new" },
        },
        makeProject({ migrate: "mig" })
      )
      const syncBase = stepEvents(events).find((s) => s.step === "sync-base")
      assert.strictEqual(syncBase!.status, "done")
      assert.strictEqual(syncBase!.detail, "main fast-forwarded; migrated app_source")
    })
  )

  it.effect("database is cloned from pc.database.source (memory adapter records it)", () =>
    Effect.gen(function* () {
      const { dbExists } = yield* provisionAndInspect(
        { dbs: [Schema.decodeSync(DbName)("app_source")] },
        makeProject()
      )
      assert.isTrue(dbExists)
    })
  )

  it.effect("proxy route added with allocated port", () =>
    Effect.gen(function* () {
      const { routes } = yield* provisionAndInspect(
        { dbs: [Schema.decodeSync(DbName)("app_source")] },
        makeProject()
      )
      const route = routes.find((r) => r.domain === expectedDomain)
      assert.isDefined(route)
      // nextPort allocates above BASE_PORT (5173) → first free is 5174
      assert.strictEqual(route!.port, 5174)
    })
  )
})

// ---------------------------------------------------------------------------
// provision — all-four-present short circuit
// ---------------------------------------------------------------------------

describe("WorkspaceService.provision (all present)", () => {
  const existingWs = new Workspace({
    project: alias,
    branch,
    path: Schema.decodeSync(WorktreePath)(expectedWorktree),
    port: Schema.decodeSync(HostPort)(5200),
    dbName: Schema.decodeSync(DbName)(expectedDb),
    proxyDomain: Schema.decodeSync(ProxyDomain)(expectedDomain),
    created: "2020-01-01",
  })

  const fullState: LeafState = {
    config: { workspaces: [existingWs] },
    repoState: { worktrees: new Map([[expectedWorktree, branch as string]]) },
    dbs: [Schema.decodeSync(DbName)("app_source"), Schema.decodeSync(DbName)(expectedDb)],
    routes: [
      {
        domain: Schema.decodeSync(ProxyDomain)(expectedDomain),
        port: Schema.decodeSync(HostPort)(5200),
      },
    ],
  }

  it.effect("single completed event, alreadyComplete=true, no step events", () =>
    Effect.gen(function* () {
      const { events } = yield* collectProvision(fullState, makeProject())
      const steps = stepEvents(events)
      assert.deepStrictEqual(steps, [])
      const result = completedEvent(events)
      assert.strictEqual(result.alreadyComplete, true)
      assert.strictEqual(result.workspace.port, 5200)
    })
  )

  it.effect("no mutations in any memory adapter", () =>
    Effect.gen(function* () {
      const { workspaces, routes, calls } = yield* provisionAndInspect(
        fullState,
        makeProject({ install: "npm i" })
      )
      // registry unchanged (still exactly the one we seeded, same port)
      assert.strictEqual(workspaces.length, 1)
      assert.strictEqual(workspaces[0]!.port, 5200)
      // routes unchanged
      assert.strictEqual(routes.length, 1)
      // no shell calls (no install/generate/migrate)
      assert.deepStrictEqual(calls, [])
    })
  )
})

// ---------------------------------------------------------------------------
// provision — partial-state resume matrix
// ---------------------------------------------------------------------------

describe("WorkspaceService.provision (resume matrix)", () => {
  it.effect("worktree present (db/route absent) → probe resuming + skipped worktree + skipped sync-base", () =>
    Effect.gen(function* () {
      const { events, calls } = yield* collectProvision(
        {
          repoState: { worktrees: new Map([[expectedWorktree, branch as string]]) },
          dbs: [Schema.decodeSync(DbName)("app_source")],
        },
        makeProject({ install: "npm i" })
      )
      const steps = stepEvents(events)
      const probe = steps.find((s) => s.step === "probe")
      assert.isDefined(probe)
      assert.strictEqual(probe!.detail, "resuming partial setup")
      const worktree = steps.find((s) => s.step === "worktree")
      assert.strictEqual(worktree!.status, "skipped-existing")
      // sync-base skipped when worktree already on disk
      const syncBase = steps.find((s) => s.step === "sync-base")
      assert.strictEqual(syncBase!.status, "skipped-existing")
      // sync (fetch/pull) must not have run — no shell calls from sync.
      const syncCalls = calls.filter((c) => c.cwd === expectedWorktree && c.command === "npm i")
      // install still runs in worktree (it's freshly cloned db side); confirm install present
      assert.strictEqual(syncCalls.length, 1)
    })
  )

  it.effect("db present (worktree/route absent) → probe resuming + skipped database", () =>
    Effect.gen(function* () {
      const { events } = yield* collectProvision(
        {
          dbs: [
            Schema.decodeSync(DbName)("app_source"),
            Schema.decodeSync(DbName)(expectedDb),
          ],
        },
        makeProject()
      )
      const steps = stepEvents(events)
      const probe = steps.find((s) => s.step === "probe")
      assert.isDefined(probe)
      const dbStep = steps.find((s) => s.step === "database")
      assert.strictEqual(dbStep!.status, "skipped-existing")
      // worktree still created
      const worktree = steps.find((s) => s.step === "worktree")
      assert.strictEqual(worktree!.status, "done")
    })
  )

  it.effect("route present (worktree/db absent) → probe resuming + skipped proxy-route, port reused from route", () =>
    Effect.gen(function* () {
      const { events } = yield* collectProvision(
        {
          dbs: [Schema.decodeSync(DbName)("app_source")],
          routes: [
            {
              domain: Schema.decodeSync(ProxyDomain)(expectedDomain),
              port: Schema.decodeSync(HostPort)(5999),
            },
          ],
        },
        makeProject()
      )
      const steps = stepEvents(events)
      assert.isDefined(steps.find((s) => s.step === "probe"))
      const routeStep = steps.find((s) => s.step === "proxy-route")
      assert.strictEqual(routeStep!.status, "skipped-existing")
      const result = completedEvent(events)
      assert.strictEqual(result.workspace.port, 5999)
    })
  )

  it.effect("registered ws present (others absent) → probe resuming, port reused from registry, no duplicate register mutation", () =>
    Effect.gen(function* () {
      const registered = new Workspace({
        project: alias,
        branch,
        path: Schema.decodeSync(WorktreePath)(expectedWorktree),
        port: Schema.decodeSync(HostPort)(5300),
        dbName: Schema.decodeSync(DbName)(expectedDb),
        proxyDomain: Schema.decodeSync(ProxyDomain)(expectedDomain),
        created: "2020-02-02",
      })
      const { events, workspaces } = yield* provisionAndInspect(
        {
          config: { workspaces: [registered] },
          dbs: [Schema.decodeSync(DbName)("app_source")],
        },
        makeProject()
      )
      assert.isDefined(stepEvents(events).find((s) => s.step === "probe"))
      const result = completedEvent(events)
      assert.strictEqual(result.workspace.port, 5300)
      // still a single registry entry
      assert.strictEqual(workspaces.length, 1)
    })
  )
})

// ---------------------------------------------------------------------------
// provision — db.ping false
// ---------------------------------------------------------------------------

describe("WorkspaceService.provision (unreachable db)", () => {
  // An unreachable database (ping false) via the public memory adapter.
  const dbDownLayer = DatabaseService.layerMemory([], { reachable: false })

  it.effect("ping false → stream fails DatabaseUnreachableError before any mutation", () =>
    Effect.gen(function* () {
      const shellCalls = yield* Ref.make<ReadonlyArray<ShellCall>>([])
      const leaves = Layer.mergeAll(
        ConfigService.layerMemory(),
        GitService.layerMemory(),
        dbDownLayer,
        ProxyService.layerMemory(),
        EnvService.layerMemory(),
        ClaudeService.layerMemory(),
        ShellService.layerMemory({ calls: shellCalls }),
        NodeContext.layer
      )
      const layer = WorkspaceService.layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(SyncService.layer.pipe(Layer.provideMerge(leaves)), leaves)
        )
      )
      const exit = yield* Effect.gen(function* () {
        const ws = yield* WorkspaceService
        const config = yield* ConfigService
        const e = yield* Stream.runCollect(
          ws.provision({
            projectAlias: alias,
            projectConfig: makeProject(),
            branch,
            baseBranch: Option.none(),
          })
        ).pipe(Effect.either)
        const workspaces = yield* config.loadWorkspaces()
        return { e, workspaces }
      }).pipe(Effect.provide(layer))

      assert.isTrue(exit.e._tag === "Left")
      if (exit.e._tag === "Left") {
        assert.strictEqual(exit.e.left._tag, "DatabaseUnreachableError")
      }
      // No registry mutation before the failure.
      assert.strictEqual(exit.workspaces.length, 0)
      // No shell calls.
      const calls = yield* Ref.get(shellCalls)
      assert.deepStrictEqual(calls, [])
    })
  )
})

// ---------------------------------------------------------------------------
// teardown — down vs gc divergence
// ---------------------------------------------------------------------------

const teardownWs = new Workspace({
  project: alias,
  branch,
  path: Schema.decodeSync(WorktreePath)(expectedWorktree),
  port: Schema.decodeSync(HostPort)(5173),
  dbName: Schema.decodeSync(DbName)(expectedDb),
  proxyDomain: Schema.decodeSync(ProxyDomain)(expectedDomain),
  created: "2020-01-01",
})

const collectTeardown = (
  state: LeafState,
  opts: { removeWorktree: boolean; force: boolean; deleteRemoteBranch: boolean }
) =>
  Effect.gen(function* () {
    const shellCalls = yield* Ref.make<ReadonlyArray<ShellCall>>([])
    const result = yield* Effect.gen(function* () {
      const ws = yield* WorkspaceService
      const config = yield* ConfigService
      const git = yield* GitService
      const db = yield* DatabaseService
      const proxy = yield* ProxyService
      const events = Chunk.toReadonlyArray(
        yield* Stream.runCollect(ws.teardown(teardownWs, makeProject(), opts))
      )
      const workspaces = yield* config.loadWorkspaces()
      const worktrees = yield* git.worktreeList(repo)
      const dbExists = yield* db.exists(
        { runtime: local, user: "app" },
        Schema.decodeSync(DbName)(expectedDb)
      )
      const routes = yield* proxy.getRoutes()
      return { events: events as ReadonlyArray<StepEvent<TeardownStep>>, workspaces, worktrees, dbExists, routes }
    }).pipe(Effect.provide(makeLayer(state, shellCalls)))
    return result
  })

describe("WorkspaceService.teardown", () => {
  const seededState: LeafState = {
    config: { workspaces: [teardownWs] },
    repoState: {
      worktrees: new Map([[expectedWorktree, branch as string]]),
      branches: new Set([branch as string]),
      remoteBranches: new Set([branch as string]),
    },
    dbs: [Schema.decodeSync(DbName)(expectedDb)],
    routes: [
      {
        domain: Schema.decodeSync(ProxyDomain)(expectedDomain),
        port: Schema.decodeSync(HostPort)(5173),
      },
    ],
  }

  it.effect("down (dbOnly): keeps worktree, drops db + route, no branch/remote steps", () =>
    Effect.gen(function* () {
      const { events, worktrees, dbExists, routes } = yield* collectTeardown(
        seededState,
        { removeWorktree: false, force: false, deleteRemoteBranch: false }
      )
      const steps = events.map((e) => e.step)
      assert.deepStrictEqual(steps, ["proxy-route", "database"])
      // worktree kept
      assert.strictEqual(worktrees.length, 1)
      // db dropped, route removed
      assert.isFalse(dbExists)
      assert.strictEqual(routes.length, 0)
    })
  )

  it.effect("down (full, no remote): removes worktree + branch + claude, NOT remote branch", () =>
    Effect.gen(function* () {
      const { events, worktrees } = yield* collectTeardown(
        seededState,
        { removeWorktree: true, force: false, deleteRemoteBranch: false }
      )
      const steps = events.map((e) => e.step)
      assert.deepStrictEqual(steps, [
        "proxy-route",
        "database",
        "worktree",
        "branch",
        "claude-convos",
      ])
      assert.isFalse(steps.includes("remote-branch"))
      assert.strictEqual(worktrees.length, 0)
    })
  )

  it.effect("gc: removes worktree + branch + remote-branch + claude", () =>
    Effect.gen(function* () {
      const { events } = yield* collectTeardown(seededState, {
        removeWorktree: true,
        force: true,
        deleteRemoteBranch: true,
      })
      const steps = events.map((e) => e.step)
      assert.deepStrictEqual(steps, [
        "proxy-route",
        "database",
        "worktree",
        "branch",
        "remote-branch",
        "claude-convos",
      ])
    })
  )

  it.effect("teardown never touches the workspace registry (D6)", () =>
    Effect.gen(function* () {
      const { workspaces } = yield* collectTeardown(seededState, {
        removeWorktree: true,
        force: true,
        deleteRemoteBranch: true,
      })
      assert.strictEqual(workspaces.length, 1)
    })
  )

  it.effect("step failures emit warning events; stream never fails", () =>
    Effect.gen(function* () {
      // Empty state: route missing, db drop idempotent, worktree/branch/remote
      // all absent → git memory adapter fails on remove/delete → warnings.
      const { events } = yield* collectTeardown(
        { config: { workspaces: [teardownWs] } },
        { removeWorktree: true, force: false, deleteRemoteBranch: true }
      )
      // proxy-route not found → warning
      const routeStep = events.find((e) => e.step === "proxy-route")
      assert.strictEqual(routeStep!.status, "warning")
      // worktree remove fails (force false, absent) → warning
      const worktreeStep = events.find((e) => e.step === "worktree")
      assert.strictEqual(worktreeStep!.status, "warning")
      // branch absent → warning
      const branchStep = events.find((e) => e.step === "branch")
      assert.strictEqual(branchStep!.status, "warning")
      // remote-branch absent → warning
      const remoteStep = events.find((e) => e.step === "remote-branch")
      assert.strictEqual(remoteStep!.status, "warning")
    })
  )

  it.effect("worktree git-remove fails (force false) → filesystem fallback clears the dir", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      // A real on-disk worktree dir that `git worktree remove` will refuse.
      const dir = yield* fs.makeTempDirectory()
      yield* fs.writeFileString(`${dir}/dirty.txt`, "uncommitted")

      const wsOnDisk = new Workspace({
        project: alias,
        branch,
        path: Schema.decodeSync(WorktreePath)(dir),
        port: Schema.decodeSync(HostPort)(5173),
        dbName: Schema.decodeSync(DbName)(expectedDb),
        proxyDomain: Schema.decodeSync(ProxyDomain)(expectedDomain),
        created: "2020-01-01",
      })

      const shellCalls = yield* Ref.make<ReadonlyArray<ShellCall>>([])
      const events = yield* Effect.gen(function* () {
        const ws = yield* WorkspaceService
        return Chunk.toReadonlyArray(
          yield* Stream.runCollect(
            ws.teardown(wsOnDisk, makeProject(), {
              removeWorktree: true,
              force: false,
              deleteRemoteBranch: false,
            })
          )
        )
      }).pipe(
        Effect.provide(
          makeLayer(
            {
              config: { workspaces: [wsOnDisk] },
              repoState: {
                worktrees: new Map([[dir, branch as string]]),
                worktreeRemoveFails: true,
                branches: new Set([branch as string]),
              },
            },
            shellCalls
          )
        )
      )

      const worktreeStep = events.find((e) => e.step === "worktree")
      assert.strictEqual(worktreeStep!.status, "done")
      assert.strictEqual(worktreeStep!.detail, "removed (force)")
      // The directory was force-deleted from disk by the fallback.
      assert.isFalse(yield* fs.exists(dir))
    }).pipe(Effect.provide(NodeContext.layer))
  )
})

// ---------------------------------------------------------------------------
// resetDatabase
// ---------------------------------------------------------------------------

const collectReset = (state: LeafState, project: ProjectConfig, fresh: boolean) =>
  Effect.gen(function* () {
    const shellCalls = yield* Ref.make<ReadonlyArray<ShellCall>>([])
    const result = yield* Effect.gen(function* () {
      const ws = yield* WorkspaceService
      const db = yield* DatabaseService
      const events = Chunk.toReadonlyArray(
        yield* Stream.runCollect(ws.resetDatabase(teardownWs, project, { fresh }))
      )
      const dbExists = yield* db.exists(
        { runtime: local, user: "app" },
        Schema.decodeSync(DbName)(expectedDb)
      )
      return { events: events as ReadonlyArray<StepEvent<ResetStep>>, dbExists }
    }).pipe(Effect.provide(makeLayer(state, shellCalls)))
    const calls = yield* Ref.get(shellCalls)
    return { ...result, calls }
  })

describe("WorkspaceService.resetDatabase", () => {
  it.effect("fresh → drop, create, migrate, seed", () =>
    Effect.gen(function* () {
      const { events, calls, dbExists } = yield* collectReset(
        { dbs: [Schema.decodeSync(DbName)(expectedDb)] },
        makeProject({ migrate: "mig", seed: "seed" }),
        true
      )
      const steps = events.map((e) => e.step)
      assert.deepStrictEqual(steps, ["drop", "create", "migrate", "seed"])
      assert.isTrue(dbExists)
      // migrate + seed run in the workspace dir
      const inDir = calls.filter((c) => c.cwd === expectedWorktree)
      assert.deepStrictEqual(
        inDir.map((c) => c.command),
        ["mig", "seed"]
      )
    })
  )

  it.effect("clone (not fresh) → drop, clone, migrate; no seed", () =>
    Effect.gen(function* () {
      const { events, calls } = yield* collectReset(
        {
          dbs: [
            Schema.decodeSync(DbName)("app_source"),
            Schema.decodeSync(DbName)(expectedDb),
          ],
        },
        makeProject({ migrate: "mig", seed: "seed" }),
        false
      )
      const steps = events.map((e) => e.step)
      assert.deepStrictEqual(steps, ["drop", "clone", "migrate"])
      const inDir = calls.filter((c) => c.cwd === expectedWorktree)
      assert.deepStrictEqual(
        inDir.map((c) => c.command),
        ["mig"]
      )
    })
  )

  it.effect("fresh without migrate/seed configured → drop, create only", () =>
    Effect.gen(function* () {
      const { events } = yield* collectReset(
        { dbs: [Schema.decodeSync(DbName)(expectedDb)] },
        makeProject({}),
        true
      )
      assert.deepStrictEqual(events.map((e) => e.step), ["drop", "create"])
    })
  )
})
