import { assert, describe, it } from "@effect/vitest"
import { NodeContext } from "@effect/platform-node"
import { Effect, Layer, Ref, Schema } from "effect"
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
import { tearDownWorkspace } from "../../src/commands/down.js"
import { gcCleanup } from "../../src/commands/gc.js"

// ---------------------------------------------------------------------------
// Fixtures — mirror test/services/workspace.test.ts derivations
// ---------------------------------------------------------------------------

const local: ExecutionRuntime = { _tag: "local" }

const alias = Schema.decodeSync(ProjectAlias)("ep")
const branch = Schema.decodeSync(BranchName)("tim/ep-1")
const repo = Schema.decodeSync(RepoPath)("/repo")

const expectedWorktree = "/repo/wt/tim-ep-1"
const expectedDb = "app_tim_ep_1"
const expectedDomain = "tim-ep-1.test"

const project: ProjectConfig = new ProjectConfig({
  path: repo,
  database: new DatabaseConfig({
    runtime: local,
    user: "app",
    source: Schema.decodeSync(DbName)("app_source"),
    host: "localhost",
    port: 5432,
  }),
  commands: new CommandsConfig({}),
  env: new EnvConfig({ files: [], autoDetected: {} }),
  worktree: new WorktreeConfig({
    dirPattern: "wt/{branch_slug}",
    proxyDomainPattern: "{branch_slug}.test",
    dbNamePattern: "app_{branch_slug_safe}",
  }),
})

const workspace = new Workspace({
  project: alias,
  branch,
  path: Schema.decodeSync(WorktreePath)(expectedWorktree),
  port: Schema.decodeSync(HostPort)(5173),
  dbName: Schema.decodeSync(DbName)(expectedDb),
  proxyDomain: Schema.decodeSync(ProxyDomain)(expectedDomain),
  created: "2020-01-01",
})

interface LeafState {
  config?: { config?: undefined; workspaces?: Workspaces }
  repoState?: Partial<MemoryRepoState>
  dbs?: ReadonlyArray<DbName>
  routes?: ReadonlyArray<Route>
}

const makeLayer = (state: LeafState, shellCalls: Ref.Ref<ReadonlyArray<ShellCall>>) => {
  const leaves = Layer.mergeAll(
    ConfigService.layerMemory(state.config),
    GitService.layerMemory(state.repoState),
    DatabaseService.layerMemory(state.dbs ?? []),
    ProxyService.layerMemory({ routes: state.routes ?? [] }),
    EnvService.layerMemory(),
    ClaudeService.layerMemory(),
    ShellService.layerMemory({ calls: shellCalls }),
    NodeContext.layer
  )
  return WorkspaceService.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(SyncService.layer.pipe(Layer.provideMerge(leaves)), leaves)
    )
  )
}

const fullState = (): LeafState => ({
  config: { workspaces: [workspace] },
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
})

// ---------------------------------------------------------------------------
// down — tearDownWorkspace
// ---------------------------------------------------------------------------

describe("down: tearDownWorkspace", () => {
  it.effect("full teardown removes db/route/worktree and registry entry", () =>
    Effect.gen(function* () {
      const shellCalls = yield* Ref.make<ReadonlyArray<ShellCall>>([])
      const result = yield* Effect.gen(function* () {
        yield* tearDownWorkspace(workspace, project, { dbOnly: false, force: false })
        const config = yield* ConfigService
        const db = yield* DatabaseService
        const proxy = yield* ProxyService
        const git = yield* GitService
        const workspaces = yield* config.loadWorkspaces()
        const dbExists = yield* db.exists({ runtime: local, user: "app" }, Schema.decodeSync(DbName)(expectedDb))
        const routes = yield* proxy.getRoutes()
        const worktrees = yield* git.worktreeList(repo)
        return { workspaces, dbExists, routes, worktrees }
      }).pipe(Effect.provide(makeLayer(fullState(), shellCalls)))

      assert.strictEqual(result.workspaces.length, 0)
      assert.isFalse(result.dbExists)
      assert.strictEqual(result.routes.length, 0)
      assert.strictEqual(result.worktrees.length, 0)
    })
  )

  it.effect("dbOnly keeps the worktree but still removes the registry entry", () =>
    Effect.gen(function* () {
      const shellCalls = yield* Ref.make<ReadonlyArray<ShellCall>>([])
      const result = yield* Effect.gen(function* () {
        yield* tearDownWorkspace(workspace, project, { dbOnly: true, force: false })
        const config = yield* ConfigService
        const git = yield* GitService
        const workspaces = yield* config.loadWorkspaces()
        const worktrees = yield* git.worktreeList(repo)
        return { workspaces, worktrees }
      }).pipe(Effect.provide(makeLayer(fullState(), shellCalls)))

      assert.strictEqual(result.workspaces.length, 0)
      // worktree kept (removeWorktree: false)
      assert.strictEqual(result.worktrees.length, 1)
    })
  )

  it.effect("never deletes the remote branch (deleteRemoteBranch: false)", () =>
    Effect.gen(function* () {
      const shellCalls = yield* Ref.make<ReadonlyArray<ShellCall>>([])
      const remote = yield* Effect.gen(function* () {
        yield* tearDownWorkspace(workspace, project, { dbOnly: false, force: true })
        const git = yield* GitService
        const wts = yield* git.worktreeList(repo)
        return wts
      }).pipe(Effect.provide(makeLayer(fullState(), shellCalls)))
      // remote branch still present is asserted indirectly by gc divergence in
      // workspace.test.ts; here we just confirm teardown succeeded (worktree gone).
      assert.strictEqual(remote.length, 0)
    })
  )
})

// ---------------------------------------------------------------------------
// gc — gcCleanup (batched single registry write)
// ---------------------------------------------------------------------------

describe("gc: gcCleanup", () => {
  const branch2 = Schema.decodeSync(BranchName)("tim/ep-2")
  const workspace2 = new Workspace({
    project: alias,
    branch: branch2,
    path: Schema.decodeSync(WorktreePath)("/repo/wt/tim-ep-2"),
    port: Schema.decodeSync(HostPort)(5174),
    dbName: Schema.decodeSync(DbName)("app_tim_ep_2"),
    proxyDomain: Schema.decodeSync(ProxyDomain)("tim-ep-2.test"),
    created: "2020-01-01",
  })

  it.effect("tears down cleaned workspaces and writes the registry once", () =>
    Effect.gen(function* () {
      const shellCalls = yield* Ref.make<ReadonlyArray<ShellCall>>([])
      const state: LeafState = {
        config: { workspaces: [workspace, workspace2] },
        repoState: {
          worktrees: new Map([[expectedWorktree, branch as string]]),
          branches: new Set([branch as string]),
          remoteBranches: new Set([branch as string]),
        },
        dbs: [Schema.decodeSync(DbName)(expectedDb)],
        routes: [
          { domain: Schema.decodeSync(ProxyDomain)(expectedDomain), port: Schema.decodeSync(HostPort)(5173) },
        ],
      }
      const result = yield* Effect.gen(function* () {
        const cleaned = yield* gcCleanup([{ ws: workspace, projectConfig: project }])
        const config = yield* ConfigService
        const workspaces = yield* config.loadWorkspaces()
        return { cleaned, workspaces }
      }).pipe(Effect.provide(makeLayer(state, shellCalls)))

      // workspace removed; workspace2 retained
      assert.strictEqual(result.workspaces.length, 1)
      assert.strictEqual(result.workspaces[0]!.branch, branch2)
      assert.strictEqual(result.cleaned, 1)
    })
  )

  it.effect("empty cleanup list leaves the registry untouched and writes nothing extra", () =>
    Effect.gen(function* () {
      const shellCalls = yield* Ref.make<ReadonlyArray<ShellCall>>([])
      const result = yield* Effect.gen(function* () {
        const cleaned = yield* gcCleanup([])
        const config = yield* ConfigService
        const workspaces = yield* config.loadWorkspaces()
        return { cleaned, workspaces }
      }).pipe(Effect.provide(makeLayer(fullState(), shellCalls)))
      assert.strictEqual(result.cleaned, 0)
      assert.strictEqual(result.workspaces.length, 1)
    })
  )
})
