import { Effect } from "effect"
import type { ShellExecError } from "../errors.js"
import { ShellService } from "./shell.js"

// ---------------------------------------------------------------------------
// DatabaseService
// ---------------------------------------------------------------------------

export class DatabaseService extends Effect.Service<DatabaseService>()("DatabaseService", {
  effect: Effect.gen(function* () {
    const shell = yield* ShellService

    const dockerExec = (container: string, args: ReadonlyArray<string>) =>
      shell.exec("docker", ["exec", container, ...args])

    const createDb: (container: string, user: string, dbName: string) => Effect.Effect<void, ShellExecError> =
      Effect.fn("DatabaseService.createDb")(function* (container, user, dbName) {
        yield* dockerExec(container, ["createdb", "-U", user, dbName])
      })

    const dropDb: (container: string, user: string, dbName: string) => Effect.Effect<void, ShellExecError> =
      Effect.fn("DatabaseService.dropDb")(function* (container, user, dbName) {
        yield* dockerExec(container, ["dropdb", "--if-exists", "-U", user, dbName])
      })

    const cloneDb: (container: string, user: string, sourceDb: string, targetDb: string) => Effect.Effect<void, ShellExecError> =
      Effect.fn("DatabaseService.cloneDb")(function* (container, user, sourceDb, targetDb) {
        yield* dockerExec(container, ["createdb", "-U", user, targetDb])
        yield* shell.exec("docker", [
          "exec", container, "bash", "-c",
          `pg_dump -U ${user} ${sourceDb} | psql -U ${user} ${targetDb}`
        ])
      })

    const dbExists: (container: string, user: string, dbName: string) => Effect.Effect<boolean, ShellExecError> =
      Effect.fn("DatabaseService.dbExists")(function* (container, user, dbName) {
        return yield* dockerExec(container, ["psql", "-U", user, "-lqt"]).pipe(
          Effect.map((r) => r.stdout.split("\n").some((line) => line.trim().startsWith(dbName))),
          Effect.catchAll(() => Effect.succeed(false))
        )
      })

    const isContainerRunning: (container: string) => Effect.Effect<boolean> =
      Effect.fn("DatabaseService.isContainerRunning")(function* (container) {
        return yield* shell.exec("docker", ["exec", container, "pg_isready", "-q"]).pipe(
          Effect.map(() => true),
          Effect.catchAll(() => Effect.succeed(false))
        )
      })

    return { createDb, dropDb, cloneDb, dbExists, isContainerRunning }
  }),
  dependencies: [ShellService.Default]
}) {}
