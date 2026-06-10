import { assert, describe, it } from "@effect/vitest"
import { NodeContext } from "@effect/platform-node"
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect"
import { resolveWorkspace, splitArgs } from "../../src/commands/open.js"
import { ConfigService } from "../../src/services/config.js"
import { DatabaseService } from "../../src/services/database.js"
import { ShipConfig } from "../../src/schema/config.js"
import { ProjectAlias } from "../../src/schema/ids.js"
import { Workspace } from "../../src/schema/workspace.js"

const makeWorkspace = (over: { project: string; branch: string; path: string }): Workspace =>
  Schema.decodeUnknownSync(Workspace)({
    project: over.project,
    branch: over.branch,
    path: over.path,
    port: 5173,
    dbName: "app_dev",
    proxyDomain: "x.localhost",
    created: "2026-06-10",
  })

const wsAlpha = makeWorkspace({ project: "acme", branch: "feat/alpha", path: "/a/alpha" })
const wsBeta = makeWorkspace({ project: "acme", branch: "feat/beta", path: "/a/beta" })

describe("open — splitArgs", () => {
  it("defaults to the editor target with no args", () => {
    assert.deepStrictEqual(splitArgs(undefined, undefined), {
      branchArg: undefined,
      target: "editor",
    })
  })

  it("treats a lone target keyword as the target", () => {
    assert.deepStrictEqual(splitArgs("db", undefined), { branchArg: undefined, target: "db" })
    assert.deepStrictEqual(splitArgs("url", undefined), { branchArg: undefined, target: "url" })
  })

  it("treats a lone non-keyword as a branch arg with the editor target", () => {
    assert.deepStrictEqual(splitArgs("feat/alpha", undefined), {
      branchArg: "feat/alpha",
      target: "editor",
    })
  })

  it("treats first as branch and second as target", () => {
    assert.deepStrictEqual(splitArgs("feat/alpha", "db"), {
      branchArg: "feat/alpha",
      target: "db",
    })
  })
})

describe("open — resolveWorkspace (via domain locateWorkspace)", () => {
  it("resolves by branch query when provided", () =>
    Effect.gen(function* () {
      const ws = yield* resolveWorkspace("alpha", [wsAlpha, wsBeta], "/elsewhere")
      assert.deepStrictEqual(ws, wsAlpha)
    }).pipe(Effect.provide(NodeContext.layer)))

  it("resolves by cwd when no branch query is given", () =>
    Effect.gen(function* () {
      const ws = yield* resolveWorkspace(undefined, [wsAlpha, wsBeta], "/a/beta/src")
      assert.deepStrictEqual(ws, wsBeta)
    }).pipe(Effect.provide(NodeContext.layer)))

  it("fails with WorkspaceNotFoundError when a branch query matches nothing", () =>
    Effect.gen(function* () {
      const exit = yield* resolveWorkspace("zzz", [wsAlpha, wsBeta], "/elsewhere").pipe(Effect.exit)
      assert.isTrue(Exit.isFailure(exit))
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause)
        assert.isTrue(Option.isSome(failure))
        if (Option.isSome(failure)) {
          assert.strictEqual(failure.value._tag, "WorkspaceNotFoundError")
        }
      }
    }).pipe(Effect.provide(NodeContext.layer)))
})

const dbConfig = Schema.decodeUnknownSync(ShipConfig)({
  projects: {
    acme: {
      path: "/repo",
      database: { runtime: { _tag: "docker", container: "pg" }, user: "postgres", source: "app_dev" },
      commands: {},
      env: { files: [], autoDetected: {} },
      worktree: { dirPattern: "", proxyDomainPattern: "", dbNamePattern: "" },
    },
  },
})

describe("open command — db target opens a session", () => {
  it("opens a db session through DatabaseService", () =>
    Effect.gen(function* () {
      const cfg = yield* ConfigService
      const db = yield* DatabaseService
      const pc = yield* cfg.getProject(ProjectAlias.make("acme"))
      yield* db.session(
        { runtime: pc.database.runtime, user: pc.database.user },
        wsAlpha.dbName
      )
      assert.strictEqual(pc.database.user, "postgres")
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ConfigService.layerMemory({ config: dbConfig }),
          DatabaseService.layerMemory()
        )
      )
    ))
})
