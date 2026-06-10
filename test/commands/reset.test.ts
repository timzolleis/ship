import { assert, describe, it } from "@effect/vitest"
import { NodeContext } from "@effect/platform-node"
import {
  Console,
  Effect,
  Layer,
  Ref,
  Schema,
} from "effect"
import { runReset } from "../../src/commands/reset.js"
import {
  CommandsConfig,
  DatabaseConfig,
  EnvConfig,
  type ExecutionRuntime,
  ProjectConfig,
  ShipConfig,
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
import { GitService } from "../../src/services/git.js"
import { ProxyService } from "../../src/services/proxy.js"
import { ShellService, type ShellCall } from "../../src/services/shell.js"
import { SyncService } from "../../src/services/sync.js"
import { WorkspaceService } from "../../src/services/workspace.js"

// ---------------------------------------------------------------------------
// Fixtures (mirror the workspace-service test fixtures)
// ---------------------------------------------------------------------------

const local: ExecutionRuntime = { _tag: "local" }
const alias = Schema.decodeSync(ProjectAlias)("ep")
const branch = Schema.decodeSync(BranchName)("tim/ep-1")
const repo = Schema.decodeSync(RepoPath)("/repo")
const worktreePath = "/repo/wt/tim-ep-1"
const expectedDb = "app_tim_ep_1"

const makeProject = (commands: {
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

const workspace = new Workspace({
  project: alias,
  branch,
  path: Schema.decodeSync(WorktreePath)(worktreePath),
  port: Schema.decodeSync(HostPort)(5173),
  dbName: Schema.decodeSync(DbName)(expectedDb),
  proxyDomain: Schema.decodeSync(ProxyDomain)("tim-ep-1.test"),
  created: "2020-01-01",
})

const makeConfig = (project: ProjectConfig): ShipConfig =>
  new ShipConfig({ projects: { [alias]: project } })

// A Console that records `log`/`error` lines into a Ref; everything else no-op.
const capturingConsole = (sink: Ref.Ref<ReadonlyArray<string>>): Console.Console => {
  const record = (...args: ReadonlyArray<any>) =>
    Ref.update(sink, (lines) => [...lines, args.join(" ")])
  const noop = Effect.void
  return {
    [Console.TypeId]: Console.TypeId,
    log: record,
    error: record,
    info: record,
    warn: record,
    debug: record,
    trace: record,
    assert: () => noop,
    clear: noop,
    count: () => noop,
    countReset: () => noop,
    dir: () => noop,
    dirxml: () => noop,
    group: () => noop,
    groupEnd: noop,
    table: () => noop,
    time: () => noop,
    timeEnd: () => noop,
    timeLog: () => noop,
    unsafe: undefined as never,
  } as Console.Console
}

interface RunOpts {
  project?: ProjectConfig
  workspaces?: Workspaces
  dbs?: ReadonlyArray<DbName>
  cwd?: string
  fresh?: boolean
}

const runResetCaptured = (opts: RunOpts) =>
  Effect.gen(function* () {
    const project = opts.project ?? makeProject()
    const sink = yield* Ref.make<ReadonlyArray<string>>([])
    const shellCalls = yield* Ref.make<ReadonlyArray<ShellCall>>([])

    const leaves = Layer.mergeAll(
      ConfigService.layerMemory({
        config: makeConfig(project),
        workspaces: opts.workspaces ?? [workspace],
      }),
      GitService.layerMemory(),
      DatabaseService.layerMemory(opts.dbs ?? [Schema.decodeSync(DbName)(expectedDb)]),
      ProxyService.layerMemory({ routes: [] }),
      EnvService.layerMemory(),
      ClaudeService.layerMemory(),
      ShellService.layerMemory({ calls: shellCalls }),
      NodeContext.layer,
    )
    const layer = WorkspaceService.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(SyncService.layer.pipe(Layer.provideMerge(leaves)), leaves)
      )
    )

    yield* runReset(opts.cwd ?? worktreePath, opts.fresh ?? false).pipe(
      Console.withConsole(capturingConsole(sink)),
      Effect.provide(layer)
    )

    const lines = yield* Ref.get(sink)
    const calls = yield* Ref.get(shellCalls)
    return { lines, calls }
  })

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "")

// ---------------------------------------------------------------------------

describe("ship reset command", () => {
  it.effect("not inside a workspace → prints message, runs nothing", () =>
    Effect.gen(function* () {
      const { lines } = yield* runResetCaptured({ cwd: "/elsewhere" })
      const text = lines.map(stripAnsi).join("\n")
      assert.include(text, "Not inside a workspace.")
      assert.notInclude(text, "Resetting database")
      assert.notInclude(text, "Database reset.")
    })
  )

  it.effect("clone (default): renders drop, clone, migrate; preserves header/footer", () =>
    Effect.gen(function* () {
      const { lines, calls } = yield* runResetCaptured({
        project: makeProject({ migrate: "mig" }),
        dbs: [
          Schema.decodeSync(DbName)("app_source"),
          Schema.decodeSync(DbName)(expectedDb),
        ],
        fresh: false,
      })
      const text = lines.map(stripAnsi).join("\n")
      assert.include(text, `Resetting database for ${branch}...`)
      assert.include(text, `Dropped ${expectedDb}`)
      assert.include(text, `Cloned → ${expectedDb}`)
      assert.include(text, "Migrations applied")
      assert.include(text, "Database reset.")
      // migrate ran in the workspace dir
      const inDir = calls.filter((c) => c.cwd === worktreePath)
      assert.deepStrictEqual(inDir.map((c) => c.command), ["mig"])
    })
  )

  it.effect("fresh: renders drop, created empty, migrate, seed", () =>
    Effect.gen(function* () {
      const { lines, calls } = yield* runResetCaptured({
        project: makeProject({ migrate: "mig", seed: "seed" }),
        dbs: [Schema.decodeSync(DbName)(expectedDb)],
        fresh: true,
      })
      const text = lines.map(stripAnsi).join("\n")
      assert.include(text, `Dropped ${expectedDb}`)
      assert.include(text, `Created empty ${expectedDb}`)
      assert.include(text, "Migrations applied")
      assert.include(text, "Seeded")
      assert.notInclude(text, "Cloned")
      const inDir = calls.filter((c) => c.cwd === worktreePath)
      assert.deepStrictEqual(inDir.map((c) => c.command), ["mig", "seed"])
    })
  )

  it.effect("locates by cwd inside the worktree (subdir)", () =>
    Effect.gen(function* () {
      const { lines } = yield* runResetCaptured({
        cwd: `${worktreePath}/src/deep`,
        fresh: true,
      })
      const text = lines.map(stripAnsi).join("\n")
      assert.include(text, `Resetting database for ${branch}...`)
      assert.include(text, "Database reset.")
    })
  )
})
