import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Ref, Schema } from "effect"
import { ShellExecError } from "../../src/errors.js"
import { ExecutionRuntime } from "../../src/schema/config.js"
import { ContainerName, DbName } from "../../src/schema/ids.js"
import {
  type DatabaseTarget,
  DatabaseService,
} from "../../src/services/database.js"
import { CommandRunner, type RunnerCall } from "../../src/services/runner.js"

const local: ExecutionRuntime = { _tag: "local" }
const docker: ExecutionRuntime = {
  _tag: "docker",
  container: Schema.decodeSync(ContainerName)("pg17"),
}

const localTarget: DatabaseTarget = { runtime: local, user: "app" }
const dockerTarget: DatabaseTarget = { runtime: docker, user: "app" }

const db = (name: string): DbName => Schema.decodeSync(DbName)(name)

// Drive DatabaseService.layerPostgres over CommandRunner.layerMemory so we can
// assert the EXACT RunnerCall table emitted per operation.
const withDb = <A, E>(
  body: (
    service: DatabaseService["Type"],
    calls: Ref.Ref<ReadonlyArray<RunnerCall>>
  ) => Effect.Effect<A, E>,
  opts?: { stub?: (call: RunnerCall) => any }
) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<RunnerCall>>([])
    const program = Effect.gen(function* () {
      const service = yield* DatabaseService
      return yield* body(service, calls)
    }).pipe(
      Effect.provide(
        DatabaseService.layerPostgres.pipe(
          Layer.provideMerge(
            CommandRunner.layerMemory({ calls, stub: opts?.stub })
          )
        )
      )
    )
    return yield* program
  })

describe("DatabaseService.layerPostgres over CommandRunner.layerMemory", () => {
  // -- create -------------------------------------------------------------
  it.effect("create (local) → createdb -U user db", () =>
    withDb((service, calls) =>
      Effect.gen(function* () {
        yield* service.create(localTarget, db("app_dev"))
        const recorded = yield* Ref.get(calls)
        assert.deepStrictEqual(recorded, [
          {
            runtime: local,
            kind: "run",
            command: "createdb",
            args: ["-U", "app", "app_dev"],
          },
        ])
      })
    )
  )

  it.effect("create (docker) → createdb -U user db on docker runtime", () =>
    withDb((service, calls) =>
      Effect.gen(function* () {
        yield* service.create(dockerTarget, db("app_dev"))
        const recorded = yield* Ref.get(calls)
        assert.deepStrictEqual(recorded, [
          {
            runtime: docker,
            kind: "run",
            command: "createdb",
            args: ["-U", "app", "app_dev"],
          },
        ])
      })
    )
  )

  // -- drop ---------------------------------------------------------------
  it.effect("drop (local) → dropdb --if-exists -U user db", () =>
    withDb((service, calls) =>
      Effect.gen(function* () {
        yield* service.drop(localTarget, db("app_dev"))
        const recorded = yield* Ref.get(calls)
        assert.deepStrictEqual(recorded, [
          {
            runtime: local,
            kind: "run",
            command: "dropdb",
            args: ["--if-exists", "-U", "app", "app_dev"],
          },
        ])
      })
    )
  )

  it.effect("drop (docker) → dropdb --if-exists -U user db on docker", () =>
    withDb((service, calls) =>
      Effect.gen(function* () {
        yield* service.drop(dockerTarget, db("app_dev"))
        const recorded = yield* Ref.get(calls)
        assert.deepStrictEqual(recorded, [
          {
            runtime: docker,
            kind: "run",
            command: "dropdb",
            args: ["--if-exists", "-U", "app", "app_dev"],
          },
        ])
      })
    )
  )

  // -- clone --------------------------------------------------------------
  it.effect("clone (local) → createdb then runScript pg_dump | psql", () =>
    withDb((service, calls) =>
      Effect.gen(function* () {
        yield* service.clone(localTarget, db("app_src"), db("app_dev"))
        const recorded = yield* Ref.get(calls)
        assert.deepStrictEqual(recorded, [
          {
            runtime: local,
            kind: "run",
            command: "createdb",
            args: ["-U", "app", "app_dev"],
          },
          {
            runtime: local,
            kind: "runScript",
            command: "pg_dump -U app app_src | psql -U app app_dev",
            args: [],
          },
        ])
      })
    )
  )

  it.effect("clone (docker) → createdb then runScript on docker runtime", () =>
    withDb((service, calls) =>
      Effect.gen(function* () {
        yield* service.clone(dockerTarget, db("app_src"), db("app_dev"))
        const recorded = yield* Ref.get(calls)
        assert.deepStrictEqual(recorded, [
          {
            runtime: docker,
            kind: "run",
            command: "createdb",
            args: ["-U", "app", "app_dev"],
          },
          {
            runtime: docker,
            kind: "runScript",
            command: "pg_dump -U app app_src | psql -U app app_dev",
            args: [],
          },
        ])
      })
    )
  )

  // -- exists -------------------------------------------------------------
  it.effect("exists (local) → psql -U user -lqt; true when line matches", () =>
    withDb(
      (service, calls) =>
        Effect.gen(function* () {
          const found = yield* service.exists(localTarget, db("app_dev"))
          assert.isTrue(found)
          const recorded = yield* Ref.get(calls)
          assert.deepStrictEqual(recorded, [
            {
              runtime: local,
              kind: "run",
              command: "psql",
              args: ["-U", "app", "-lqt"],
            },
          ])
        }),
      { stub: () => ({ stdout: " app_dev | app | UTF8\n", stderr: "", exitCode: 0 }) }
    )
  )

  it.effect("exists (docker) → false when no line matches", () =>
    withDb(
      (service) =>
        Effect.gen(function* () {
          const found = yield* service.exists(dockerTarget, db("missing"))
          assert.isFalse(found)
        }),
      { stub: () => ({ stdout: " app_dev | app | UTF8\n", stderr: "", exitCode: 0 }) }
    )
  )

  it.effect("exists → catchAll → false on command failure", () =>
    withDb(
      (service) =>
        Effect.gen(function* () {
          const found = yield* service.exists(localTarget, db("app_dev"))
          assert.isFalse(found)
        }),
      {
        stub: () => new ShellExecError({ command: "psql", stderr: "boom" }),
      }
    )
  )

  // -- ping ---------------------------------------------------------------
  it.effect("ping (local) → pg_isready -q; true on success", () =>
    withDb((service, calls) =>
      Effect.gen(function* () {
        const ok = yield* service.ping(localTarget)
        assert.isTrue(ok)
        const recorded = yield* Ref.get(calls)
        assert.deepStrictEqual(recorded, [
          {
            runtime: local,
            kind: "run",
            command: "pg_isready",
            args: ["-q"],
          },
        ])
      })
    )
  )

  it.effect("ping (docker) → pg_isready -q on docker runtime; true on success", () =>
    withDb((service, calls) =>
      Effect.gen(function* () {
        const ok = yield* service.ping(dockerTarget)
        assert.isTrue(ok)
        const recorded = yield* Ref.get(calls)
        assert.deepStrictEqual(recorded, [
          {
            runtime: docker,
            kind: "run",
            command: "pg_isready",
            args: ["-q"],
          },
        ])
      })
    )
  )

  it.effect("ping → false on failure", () =>
    withDb(
      (service) =>
        Effect.gen(function* () {
          const ok = yield* service.ping(localTarget)
          assert.isFalse(ok)
        }),
      {
        stub: () => new ShellExecError({ command: "pg_isready", stderr: "down" }),
      }
    )
  )

  // -- query --------------------------------------------------------------
  it.effect("query (local) → psql -U user db -c sql; returns stdout", () =>
    withDb(
      (service, calls) =>
        Effect.gen(function* () {
          const out = yield* service.query(
            localTarget,
            db("app_dev"),
            "SELECT 1"
          )
          assert.strictEqual(out, "result\n")
          const recorded = yield* Ref.get(calls)
          assert.deepStrictEqual(recorded, [
            {
              runtime: local,
              kind: "run",
              command: "psql",
              args: ["-U", "app", "app_dev", "-c", "SELECT 1"],
            },
          ])
        }),
      { stub: () => ({ stdout: "result\n", stderr: "", exitCode: 0 }) }
    )
  )

  it.effect("query (docker) → psql -U user db -c sql on docker runtime", () =>
    withDb((service, calls) =>
      Effect.gen(function* () {
        yield* service.query(dockerTarget, db("app_dev"), "SELECT 1")
        const recorded = yield* Ref.get(calls)
        assert.deepStrictEqual(recorded, [
          {
            runtime: docker,
            kind: "run",
            command: "psql",
            args: ["-U", "app", "app_dev", "-c", "SELECT 1"],
          },
        ])
      })
    )
  )

  // -- session ------------------------------------------------------------
  it.effect("session (local) → runInteractive psql -U user db", () =>
    withDb((service, calls) =>
      Effect.gen(function* () {
        yield* service.session(localTarget, db("app_dev"))
        const recorded = yield* Ref.get(calls)
        assert.deepStrictEqual(recorded, [
          {
            runtime: local,
            kind: "runInteractive",
            command: "psql",
            args: ["-U", "app", "app_dev"],
          },
        ])
      })
    )
  )

  it.effect("session (docker) → runInteractive psql -U user db on docker", () =>
    withDb((service, calls) =>
      Effect.gen(function* () {
        yield* service.session(dockerTarget, db("app_dev"))
        const recorded = yield* Ref.get(calls)
        assert.deepStrictEqual(recorded, [
          {
            runtime: docker,
            kind: "runInteractive",
            command: "psql",
            args: ["-U", "app", "app_dev"],
          },
        ])
      })
    )
  )
})
