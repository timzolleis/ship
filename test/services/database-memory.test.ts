import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Schema } from "effect"
import { DbName } from "../../src/schema/ids.js"
import { ExecutionRuntime } from "../../src/schema/config.js"
import {
  type DatabaseTarget,
  DatabaseService,
} from "../../src/services/database.js"

const local: ExecutionRuntime = { _tag: "local" }
const target: DatabaseTarget = { runtime: local, user: "app" }
const db = (name: string): DbName => Schema.decodeSync(DbName)(name)

const withMemory = <A, E>(
  initial: ReadonlyArray<DbName>,
  body: (service: DatabaseService["Type"]) => Effect.Effect<A, E>
) =>
  Effect.gen(function* () {
    const service = yield* DatabaseService
    return yield* body(service)
  }).pipe(Effect.provide(DatabaseService.layerMemory(initial)))

describe("DatabaseService.layerMemory contract", () => {
  it.effect("create adds to the set; exists reflects it", () =>
    withMemory([], (service) =>
      Effect.gen(function* () {
        assert.isFalse(yield* service.exists(target, db("app_dev")))
        yield* service.create(target, db("app_dev"))
        assert.isTrue(yield* service.exists(target, db("app_dev")))
      })
    )
  )

  it.effect("create errors (DatabaseError) on duplicate", () =>
    withMemory([db("app_dev")], (service) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(service.create(target, db("app_dev")))
        assert.isTrue(Exit.isFailure(exit))
      })
    )
  )

  it.effect("drop removes; idempotent when absent", () =>
    withMemory([db("app_dev")], (service) =>
      Effect.gen(function* () {
        yield* service.drop(target, db("app_dev"))
        assert.isFalse(yield* service.exists(target, db("app_dev")))
        // drop again — no error
        yield* service.drop(target, db("app_dev"))
      })
    )
  )

  it.effect("clone requires source; adds target", () =>
    withMemory([db("app_src")], (service) =>
      Effect.gen(function* () {
        yield* service.clone(target, db("app_src"), db("app_dev"))
        assert.isTrue(yield* service.exists(target, db("app_dev")))
      })
    )
  )

  it.effect("clone errors (DatabaseError) when source missing", () =>
    withMemory([], (service) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          service.clone(target, db("app_src"), db("app_dev"))
        )
        assert.isTrue(Exit.isFailure(exit))
      })
    )
  )

  it.effect("ping true by default", () =>
    withMemory([], (service) =>
      Effect.gen(function* () {
        assert.isTrue(yield* service.ping(target))
      })
    )
  )

  it.effect("ping false when reachable: false", () =>
    Effect.gen(function* () {
      const service = yield* DatabaseService
      assert.isFalse(yield* service.ping(target))
    }).pipe(Effect.provide(DatabaseService.layerMemory([], { reachable: false })))
  )

  it.effect("ping true when reachable: true (explicit)", () =>
    Effect.gen(function* () {
      const service = yield* DatabaseService
      assert.isTrue(yield* service.ping(target))
    }).pipe(Effect.provide(DatabaseService.layerMemory([], { reachable: true })))
  )

  it.effect("query returns empty string and succeeds", () =>
    withMemory([db("app_dev")], (service) =>
      Effect.gen(function* () {
        const out = yield* service.query(target, db("app_dev"), "SELECT 1")
        assert.strictEqual(out, "")
      })
    )
  )

  it.effect("session succeeds", () =>
    withMemory([db("app_dev")], (service) => service.session(target, db("app_dev")))
  )
})
