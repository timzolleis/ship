import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Option, Ref, Schema } from "effect"
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
  DbName,
  HostPort,
  ProjectAlias,
  ProxyDomain,
  RepoPath,
  WorktreePath,
} from "../../src/schema/ids.js"
import { Workspace, type Workspaces } from "../../src/schema/workspace.js"
import { ConfigService } from "../../src/services/config.js"
import { ProxyService, type Route } from "../../src/services/proxy.js"
import { ShellService, type ShellCall } from "../../src/services/shell.js"
import { runUp } from "../../src/commands/up.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const local: ExecutionRuntime = { _tag: "local" }

const alias = Schema.decodeSync(ProjectAlias)("ep")
const repo = "/repo"

const baseProject = (overrides?: Partial<{ domain: ProxyDomain; port: HostPort; dev: string }>) =>
  new ProjectConfig({
    path: Schema.decodeSync(RepoPath)(repo),
    domain: overrides?.domain,
    port: overrides?.port,
    database: new DatabaseConfig({
      runtime: local,
      user: "app",
      source: Schema.decodeSync(DbName)("app_source"),
      host: "localhost",
      port: 5432,
    }),
    commands: new CommandsConfig({ dev: overrides?.dev }),
    env: new EnvConfig({ files: [], autoDetected: {} }),
    worktree: new WorktreeConfig({
      dirPattern: "wt/{branch_slug}",
      proxyDomainPattern: "{branch_slug}.test",
      dbNamePattern: "app_{branch_slug_safe}",
    }),
  })

const workspace = new Workspace({
  project: alias,
  branch: Schema.decodeSync(Schema.String.pipe(Schema.brand("BranchName")))("tim/ep-1"),
  path: Schema.decodeSync(WorktreePath)("/repo/wt/tim-ep-1"),
  port: Schema.decodeSync(HostPort)(5180),
  dbName: Schema.decodeSync(DbName)("app_tim_ep_1"),
  proxyDomain: Schema.decodeSync(ProxyDomain)("tim-ep-1.test"),
  created: "2020-01-01",
})

interface LeafState {
  config: ShipConfig
  workspaces?: Workspaces
  routes?: ReadonlyArray<Route>
  running?: boolean
}

const makeLayer = (state: LeafState, shellCalls: Ref.Ref<ReadonlyArray<ShellCall>>) =>
  Layer.mergeAll(
    ConfigService.layerMemory({ config: state.config, workspaces: state.workspaces ?? [] }),
    ProxyService.layerMemory({ routes: state.routes ?? [], running: state.running ?? false }),
    ShellService.layerMemory({ calls: shellCalls })
  )

// ---------------------------------------------------------------------------
// up — runUp
// ---------------------------------------------------------------------------

describe("up: runUp", () => {
  it.effect("inside a workspace cwd, adds the workspace route and runs the dev command", () =>
    Effect.gen(function* () {
      const shellCalls = yield* Ref.make<ReadonlyArray<ShellCall>>([])
      const config = new ShipConfig({ projects: { [alias]: baseProject({ dev: "npm run dev --port {port}" }) } })
      const result = yield* Effect.gen(function* () {
        yield* runUp("/repo/wt/tim-ep-1/src", false)
        const proxy = yield* ProxyService
        const routes = yield* proxy.getRoutes()
        const calls = yield* Ref.get(shellCalls)
        return { routes, calls }
      }).pipe(
        Effect.provide(makeLayer({ config, workspaces: [workspace] }, shellCalls))
      )

      // route for the workspace domain/port
      assert.deepStrictEqual(result.routes, [{ domain: workspace.proxyDomain, port: workspace.port }])
      // dev command resolved with the workspace port and run in the worktree dir
      const devCall = result.calls.find((c) => c.cwd === workspace.path)
      assert.isDefined(devCall)
      assert.strictEqual(devCall!.command, "npm run dev --port 5180")
    })
  )

  it.effect("starts the proxy when it is not already running", () =>
    Effect.gen(function* () {
      const shellCalls = yield* Ref.make<ReadonlyArray<ShellCall>>([])
      const config = new ShipConfig({ projects: { [alias]: baseProject() } })
      const running = yield* Effect.gen(function* () {
        yield* runUp("/repo/wt/tim-ep-1", false)
        const proxy = yield* ProxyService
        return yield* proxy.isRunning()
      }).pipe(Effect.provide(makeLayer({ config, workspaces: [workspace], running: false }, shellCalls)))

      assert.isTrue(running)
    })
  )

  it.effect("root-project fallback uses the project's own domain and port", () =>
    Effect.gen(function* () {
      const shellCalls = yield* Ref.make<ReadonlyArray<ShellCall>>([])
      const project = baseProject({
        domain: Schema.decodeSync(ProxyDomain)("ep.localhost"),
        port: Schema.decodeSync(HostPort)(5200),
        dev: "vite --port {port}",
      })
      const config = new ShipConfig({ projects: { [alias]: project } })
      const result = yield* Effect.gen(function* () {
        // cwd is the repo root, no workspace registered
        yield* runUp("/repo", false)
        const proxy = yield* ProxyService
        const routes = yield* proxy.getRoutes()
        const calls = yield* Ref.get(shellCalls)
        return { routes, calls }
      }).pipe(Effect.provide(makeLayer({ config, workspaces: [] }, shellCalls)))

      assert.deepStrictEqual(result.routes, [
        { domain: Schema.decodeSync(ProxyDomain)("ep.localhost"), port: Schema.decodeSync(HostPort)(5200) },
      ])
      const devCall = result.calls.find((c) => c.cwd === repo)
      assert.isDefined(devCall)
      assert.strictEqual(devCall!.command, "vite --port 5200")
    })
  )

  it.effect("root-project without a port backfills via nextPort and persists it", () =>
    Effect.gen(function* () {
      const shellCalls = yield* Ref.make<ReadonlyArray<ShellCall>>([])
      // project has no port (registered before root routes existed)
      const project = baseProject({ domain: Schema.decodeSync(ProxyDomain)("ep.localhost") })
      const config = new ShipConfig({ projects: { [alias]: project } })
      const result = yield* Effect.gen(function* () {
        yield* runUp("/repo", false)
        const cfg = yield* ConfigService
        const proxy = yield* ProxyService
        const persisted = yield* cfg.getProject(alias)
        const routes = yield* proxy.getRoutes()
        return { persisted, routes }
      }).pipe(
        // pre-existing route at 5173 forces nextPort to allocate 5174
        Effect.provide(
          makeLayer(
            {
              config,
              workspaces: [],
              routes: [
                { domain: Schema.decodeSync(ProxyDomain)("other.localhost"), port: Schema.decodeSync(HostPort)(5173) },
              ],
            },
            shellCalls
          )
        )
      )

      // port backfilled and persisted to config
      assert.isTrue(Option.isSome(Option.fromNullable(result.persisted.port)))
      assert.strictEqual(result.persisted.port, 5174)
      // route added for the backfilled port
      const epRoute = result.routes.find((r) => r.domain === "ep.localhost")
      assert.isDefined(epRoute)
      assert.strictEqual(epRoute!.port, 5174)
    })
  )

  it.effect("root-project without an explicit domain derives <alias>.localhost", () =>
    Effect.gen(function* () {
      const shellCalls = yield* Ref.make<ReadonlyArray<ShellCall>>([])
      const project = baseProject({ port: Schema.decodeSync(HostPort)(5200) })
      const config = new ShipConfig({ projects: { [alias]: project } })
      const routes = yield* Effect.gen(function* () {
        yield* runUp("/repo", false)
        const proxy = yield* ProxyService
        return yield* proxy.getRoutes()
      }).pipe(Effect.provide(makeLayer({ config, workspaces: [] }, shellCalls)))

      assert.deepStrictEqual(routes, [
        { domain: Schema.decodeSync(ProxyDomain)("ep.localhost"), port: Schema.decodeSync(HostPort)(5200) },
      ])
    })
  )

  it.effect("not inside a workspace or registered project does nothing destructive", () =>
    Effect.gen(function* () {
      const shellCalls = yield* Ref.make<ReadonlyArray<ShellCall>>([])
      const config = new ShipConfig({ projects: { [alias]: baseProject() } })
      const result = yield* Effect.gen(function* () {
        yield* runUp("/somewhere/else", false)
        const proxy = yield* ProxyService
        const routes = yield* proxy.getRoutes()
        const calls = yield* Ref.get(shellCalls)
        return { routes, calls }
      }).pipe(Effect.provide(makeLayer({ config, workspaces: [workspace] }, shellCalls)))

      assert.strictEqual(result.routes.length, 0)
      assert.strictEqual(result.calls.length, 0)
    })
  )
})
