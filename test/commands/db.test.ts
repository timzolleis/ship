import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Ref, Schema } from "effect"
import { runExec } from "../../src/commands/db.js"
import { ConfigService } from "../../src/services/config.js"
import { DatabaseService } from "../../src/services/database.js"
import { CommandRunner, type RunnerCall } from "../../src/services/runner.js"
import { ShipConfig } from "../../src/schema/config.js"
import { ProjectAlias } from "../../src/schema/ids.js"
import { Workspace } from "../../src/schema/workspace.js"

const makeWorkspace = (over: { project: string; branch: string; path: string }): Workspace =>
  Schema.decodeUnknownSync(Workspace)({
    project: over.project,
    branch: over.branch,
    path: over.path,
    port: 5173,
    dbName: "acme_feat",
    proxyDomain: "x.localhost",
    created: "2026-06-10",
  })

const wsAlpha = makeWorkspace({ project: "acme", branch: "feat/alpha", path: "/a/alpha" })

const config = Schema.decodeUnknownSync(ShipConfig)({
  projects: {
    acme: {
      path: "/repo",
      database: {
        runtime: { _tag: "docker", container: "pg" },
        user: "postgres",
        source: "app_dev",
      },
      commands: {},
      env: { files: [], autoDetected: {} },
      worktree: { dirPattern: "", proxyDomainPattern: "", dbNamePattern: "" },
    },
  },
})

describe("db exec — runExec", () => {
  it("queries the located workspace database with the project's runtime/user (postgres adapter argv)", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<RunnerCall>>([])
      const layer = Layer.mergeAll(
        DatabaseService.layerPostgres.pipe(Layer.provide(CommandRunner.layerMemory({ calls }))),
        ConfigService.layerMemory({ config, workspaces: [wsAlpha] })
      )
      yield* runExec("/a/alpha/src", "SELECT 1").pipe(Effect.provide(layer))
      const recorded = yield* Ref.get(calls)
      // query → runner.run(rt, "psql", ["-U", user, db, "-c", sql])
      const expectedRuntime = config.projects[ProjectAlias.make("acme")]!.database.runtime
      assert.deepStrictEqual(recorded, [
        {
          runtime: expectedRuntime,
          kind: "run",
          command: "psql",
          args: ["-U", "postgres", "acme_feat", "-c", "SELECT 1"],
        },
      ])
    }))

  it("does nothing (no runner calls) when cwd is outside any workspace", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<RunnerCall>>([])
      const layer = Layer.mergeAll(
        DatabaseService.layerPostgres.pipe(Layer.provide(CommandRunner.layerMemory({ calls }))),
        ConfigService.layerMemory({ config, workspaces: [wsAlpha] })
      )
      yield* runExec("/elsewhere", "SELECT 1").pipe(Effect.provide(layer))
      // No workspace located → no query attempted.
      assert.deepStrictEqual(yield* Ref.get(calls), [])
    }))
})
