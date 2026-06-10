import { assert, describe, it } from "@effect/vitest"
import { FileSystem, Path } from "@effect/platform"
import { NodeContext } from "@effect/platform-node"
import { Effect, Exit, Layer, Option, Schema } from "effect"
import * as os from "node:os"
import {
  DatabaseConfig,
  CommandsConfig,
  EnvConfig,
  ProjectConfig,
  ShipConfig,
  WorktreeConfig,
} from "../../src/schema/config.js"
import {
  BranchName,
  ContainerName,
  DbName,
  HostPort,
  ProjectAlias,
  ProxyDomain,
  RepoPath,
  WorktreePath,
} from "../../src/schema/ids.js"
import { Workspace, type Workspaces } from "../../src/schema/workspace.js"
import { ConfigService } from "../../src/services/config.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const alias = (s: string): ProjectAlias => Schema.decodeSync(ProjectAlias)(s)
const branch = (s: string): BranchName => Schema.decodeSync(BranchName)(s)

const project = (): ProjectConfig =>
  new ProjectConfig({
    path: RepoPath.make("/repo/app"),
    database: new DatabaseConfig({
      runtime: { _tag: "docker", container: ContainerName.make("pg17") },
      user: "app",
      source: DbName.make("app_dev"),
      host: "localhost",
      port: 5432,
    }),
    commands: new CommandsConfig({}),
    env: new EnvConfig({ files: [], autoDetected: {} }),
    worktree: new WorktreeConfig({
      dirPattern: "../{branch_slug}",
      proxyDomainPattern: "{branch_slug}.app.test",
      dbNamePattern: "app_{branch_slug_safe}",
    }),
  })

const workspace = (proj: string, br: string): Workspace =>
  new Workspace({
    project: alias(proj),
    branch: branch(br),
    path: WorktreePath.make(`/wt/${br}`),
    port: HostPort.make(5173),
    dbName: DbName.make(`app_${br}`),
    proxyDomain: ProxyDomain.make(`${br}.app.test`),
    created: "2026-06-10",
  })

const withMemory = <A, E>(
  initial: { config?: ShipConfig; workspaces?: Workspaces },
  body: (service: ConfigService["Type"]) => Effect.Effect<A, E>
) =>
  Effect.gen(function* () {
    const service = yield* ConfigService
    return yield* body(service)
  }).pipe(Effect.provide(ConfigService.layerMemory(initial)))

// ---------------------------------------------------------------------------
// layerMemory contract
// ---------------------------------------------------------------------------

describe("ConfigService.layerMemory contract", () => {
  it.effect("addWorkspace then findWorkspace returns it", () =>
    withMemory({}, (service) =>
      Effect.gen(function* () {
        const ws = workspace("app", "feat-x")
        yield* service.addWorkspace(ws)
        const found = yield* service.findWorkspace(alias("app"), branch("feat-x"))
        assert.isTrue(Option.isSome(found))
        assert.strictEqual(Option.getOrThrow(found).branch, ws.branch)
      })
    )
  )

  it.effect("findWorkspace returns none when absent", () =>
    withMemory({}, (service) =>
      Effect.gen(function* () {
        const found = yield* service.findWorkspace(alias("app"), branch("nope"))
        assert.isTrue(Option.isNone(found))
      })
    )
  )

  it.effect("addWorkspace replaces an existing project/branch entry", () =>
    withMemory({ workspaces: [workspace("app", "feat-x")] }, (service) =>
      Effect.gen(function* () {
        yield* service.addWorkspace(workspace("app", "feat-x"))
        const ws = yield* service.loadWorkspaces()
        assert.strictEqual(ws.length, 1)
      })
    )
  )

  it.effect("removeWorkspace drops the entry", () =>
    withMemory({ workspaces: [workspace("app", "feat-x")] }, (service) =>
      Effect.gen(function* () {
        yield* service.removeWorkspace(alias("app"), branch("feat-x"))
        const found = yield* service.findWorkspace(alias("app"), branch("feat-x"))
        assert.isTrue(Option.isNone(found))
      })
    )
  )

  it.effect("getProject returns the project config", () =>
    withMemory(
      { config: new ShipConfig({ projects: { [alias("app")]: project() } }) },
      (service) =>
        Effect.gen(function* () {
          const pc = yield* service.getProject(alias("app"))
          assert.strictEqual(pc.path, "/repo/app")
        })
    )
  )

  it.effect("getProject fails ProjectNotFoundError when absent", () =>
    withMemory({}, (service) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(service.getProject(alias("missing")))
        assert.isTrue(Exit.isFailure(exit))
      })
    )
  )

  it.effect("addProject then getProject", () =>
    withMemory({}, (service) =>
      Effect.gen(function* () {
        yield* service.addProject(alias("app"), project())
        const pc = yield* service.getProject(alias("app"))
        assert.strictEqual(pc.database.user, "app")
      })
    )
  )
})

// ---------------------------------------------------------------------------
// layer over a real tmpdir — D10 self-migration
// ---------------------------------------------------------------------------

const legacyConfigJson = JSON.stringify(
  {
    projects: {
      app: {
        path: "/repo/app",
        database: {
          container: "pg17",
          user: "app",
          source: "app_dev",
        },
        commands: {},
        env: { files: [], autoDetected: {} },
        worktree: {
          dirPattern: "../{branch_slug}",
          proxyDomainPattern: "{branch_slug}.app.test",
          dbNamePattern: "app_{branch_slug_safe}",
        },
      },
    },
  },
  null,
  2
)

// Run a body with HOME pointed at a fresh tmpdir so ConfigService.layer (which
// reads process.env.HOME) targets it. Restores HOME afterward.
const withTmpHome = <A, E>(
  body: (
    tmp: string,
    configPath: string
  ) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const tmp = yield* fs.makeTempDirectory()
    const configPath = path.join(tmp, ".config", "ship", "config.json")
    const prevHome = process.env.HOME
    process.env.HOME = tmp
    return yield* Effect.ensuring(
      body(tmp, configPath),
      Effect.sync(() => {
        if (prevHome === undefined) delete process.env.HOME
        else process.env.HOME = prevHome
      })
    )
  }).pipe(Effect.provide(NodeContext.layer))

describe("ConfigService.layer (tmpdir) — legacy migration (D10)", () => {
  it.effect("loadConfig decodes legacy { container } into runtime AND rewrites canonical on disk", () =>
    withTmpHome((tmp, configPath) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        yield* fs.makeDirectory(path.dirname(configPath), { recursive: true })
        yield* fs.writeFileString(configPath, legacyConfigJson)

        yield* Effect.gen(function* () {
          const service = yield* ConfigService
          const config = yield* service.loadConfig()
          const pc = config.projects[alias("app")]
          assert.isDefined(pc)
          assert.strictEqual(pc.database.runtime._tag, "docker")
          if (pc.database.runtime._tag === "docker") {
            assert.strictEqual(pc.database.runtime.container, "pg17")
          }
          assert.strictEqual(pc.database.user, "app")
          assert.strictEqual(pc.database.source, "app_dev")
        }).pipe(Effect.provide(ConfigService.layer))

        // file on disk is now canonical: no bare `container`, has `runtime`
        const after = yield* fs.readFileString(configPath)
        const raw = JSON.parse(after)
        assert.isUndefined(raw.projects.app.database.container)
        assert.isDefined(raw.projects.app.database.runtime)
        assert.strictEqual(raw.projects.app.database.runtime._tag, "docker")
        assert.strictEqual(raw.projects.app.database.runtime.container, "pg17")
      })
    )
  )

  it.effect("loadConfig on already-canonical config still loads and stays canonical", () =>
    withTmpHome((tmp, configPath) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem

        yield* Effect.gen(function* () {
          const service = yield* ConfigService
          yield* service.addProject(alias("app"), project())
          const config = yield* service.loadConfig()
          const pc = config.projects[alias("app")]
          assert.isDefined(pc)
          assert.strictEqual(pc!.database.runtime._tag, "docker")
        }).pipe(Effect.provide(ConfigService.layer))

        const after = yield* fs.readFileString(configPath)
        const raw = JSON.parse(after)
        assert.isUndefined(raw.projects.app.database.container)
        assert.strictEqual(raw.projects.app.database.runtime._tag, "docker")
      })
    )
  )
})
