import { Context, Effect, Layer, Ref } from "effect"
import { DatabaseError } from "../errors.js"
import type { ExecutionRuntime } from "../schema/config.js"
import type { DbName } from "../schema/ids.js"
import { CommandRunner } from "./runner.js"

// ---------------------------------------------------------------------------
// DatabaseService — engine-agnostic interface over a CommandRunner. The
// production adapter (layerPostgres) speaks postgres CLI tools; the runtime
// (local | docker) is carried per-call as DatabaseTarget data (D1).
// ---------------------------------------------------------------------------

export interface DatabaseTarget {
  readonly runtime: ExecutionRuntime
  readonly user: string
}

export interface DatabaseShape {
  readonly create: (t: DatabaseTarget, db: DbName) => Effect.Effect<void, DatabaseError>
  readonly drop: (t: DatabaseTarget, db: DbName) => Effect.Effect<void, DatabaseError>
  readonly clone: (
    t: DatabaseTarget,
    source: DbName,
    db: DbName
  ) => Effect.Effect<void, DatabaseError>
  readonly exists: (t: DatabaseTarget, db: DbName) => Effect.Effect<boolean>
  readonly ping: (t: DatabaseTarget) => Effect.Effect<boolean>
  readonly query: (
    t: DatabaseTarget,
    db: DbName,
    sql: string
  ) => Effect.Effect<string, DatabaseError>
  readonly session: (t: DatabaseTarget, db: DbName) => Effect.Effect<void, DatabaseError>
}

const dbError = (op: string, database: string) => (detail: string) =>
  new DatabaseError({ op, database, detail })

export class DatabaseService extends Context.Tag("ship/DatabaseService")<
  DatabaseService,
  DatabaseShape
>() {
  static layerPostgres: Layer.Layer<DatabaseService, never, CommandRunner> = Layer.effect(
    DatabaseService,
    Effect.gen(function* () {
      const runner = yield* CommandRunner

      const create: DatabaseShape["create"] = (t, db) =>
        runner
          .run(t.runtime, "createdb", ["-U", t.user, db])
          .pipe(
            Effect.asVoid,
            Effect.mapError((e) => dbError("create", db)(e.message))
          )

      const drop: DatabaseShape["drop"] = (t, db) =>
        runner
          .run(t.runtime, "dropdb", ["--if-exists", "-U", t.user, db])
          .pipe(
            Effect.asVoid,
            Effect.mapError((e) => dbError("drop", db)(e.message))
          )

      const clone: DatabaseShape["clone"] = (t, source, db) =>
        runner.run(t.runtime, "createdb", ["-U", t.user, db]).pipe(
          Effect.zipRight(
            runner.runScript(
              t.runtime,
              `pg_dump -U ${t.user} ${source} | psql -U ${t.user} ${db}`
            )
          ),
          Effect.asVoid,
          Effect.mapError((e) => dbError("clone", db)(e.message))
        )

      const exists: DatabaseShape["exists"] = (t, db) =>
        runner.run(t.runtime, "psql", ["-U", t.user, "-lqt"]).pipe(
          Effect.map((r) =>
            r.stdout.split("\n").some((line) => line.trim().startsWith(db))
          ),
          Effect.catchAll(() => Effect.succeed(false))
        )

      const ping: DatabaseShape["ping"] = (t) =>
        runner.run(t.runtime, "pg_isready", ["-q"]).pipe(
          Effect.as(true),
          Effect.catchAll(() => Effect.succeed(false))
        )

      const query: DatabaseShape["query"] = (t, db, sql) =>
        runner
          .run(t.runtime, "psql", ["-U", t.user, db, "-c", sql])
          .pipe(
            Effect.map((r) => r.stdout),
            Effect.mapError((e) => dbError("query", db)(e.message))
          )

      const session: DatabaseShape["session"] = (t, db) =>
        runner
          .runInteractive(t.runtime, "psql", ["-U", t.user, db])
          .pipe(Effect.mapError((e) => dbError("session", db)(e.message)))

      return { create, drop, clone, exists, ping, query, session }
    })
  )

  static layer: Layer.Layer<DatabaseService, never, CommandRunner> = DatabaseService.layerPostgres

  static layerMemory: (
    initial?: ReadonlyArray<DbName>,
    opts?: { reachable?: boolean }
  ) => Layer.Layer<DatabaseService> = (initial, opts) =>
    Layer.effect(
      DatabaseService,
      Effect.gen(function* () {
        const set = yield* Ref.make(new Set<string>(initial ?? []))
        const reachable = opts?.reachable ?? true

        const create: DatabaseShape["create"] = (_t, db) =>
          Ref.get(set).pipe(
            Effect.flatMap((s) =>
              s.has(db)
                ? Effect.fail(dbError("create", db)("already exists"))
                : Ref.update(set, (cur) => new Set([...cur, db as string]))
            )
          )

        const drop: DatabaseShape["drop"] = (_t, db) =>
          Ref.update(set, (s) => {
            const next = new Set(s)
            next.delete(db)
            return next
          })

        const clone: DatabaseShape["clone"] = (_t, source, db) =>
          Ref.get(set).pipe(
            Effect.flatMap((s) =>
              s.has(source)
                ? Ref.update(set, (cur) => new Set([...cur, db as string]))
                : Effect.fail(dbError("clone", db)(`source '${source}' does not exist`))
            )
          )

        const exists: DatabaseShape["exists"] = (_t, db) =>
          Ref.get(set).pipe(Effect.map((s) => s.has(db)))

        const ping: DatabaseShape["ping"] = () => Effect.succeed(reachable)

        const query: DatabaseShape["query"] = () => Effect.succeed("")

        const session: DatabaseShape["session"] = () => Effect.void

        return { create, drop, clone, exists, ping, query, session }
      })
    )
}
