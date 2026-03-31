import type { PlatformError } from "@effect/platform/Error"
import { Context, Effect, Layer } from "effect"
import { ShellService } from "./shell.js"

// ---------------------------------------------------------------------------
// DatabaseService
// ---------------------------------------------------------------------------

export class DatabaseService extends Context.Tag("DatabaseService")<
  DatabaseService,
  {
    readonly createDb: (container: string, user: string, dbName: string) => Effect.Effect<void, PlatformError>
    readonly dropDb: (container: string, user: string, dbName: string) => Effect.Effect<void, PlatformError>
    readonly cloneDb: (container: string, user: string, sourceDb: string, targetDb: string) => Effect.Effect<void, PlatformError>
    readonly dbExists: (container: string, user: string, dbName: string) => Effect.Effect<boolean, PlatformError>
    readonly isContainerRunning: (container: string) => Effect.Effect<boolean>
  }
>() {}

export const DatabaseServiceLive = Layer.effect(
  DatabaseService,
  Effect.gen(function* () {
    const shell = yield* ShellService

    const dockerExec = (container: string, args: ReadonlyArray<string>) =>
      shell.exec("docker", ["exec", container, ...args])

    return DatabaseService.of({
      createDb: (container, user, dbName) =>
        dockerExec(container, ["createdb", "-U", user, dbName]).pipe(Effect.asVoid),

      dropDb: (container, user, dbName) =>
        dockerExec(container, ["dropdb", "--if-exists", "-U", user, dbName]).pipe(Effect.asVoid),

      cloneDb: (container, user, sourceDb, targetDb) =>
        Effect.gen(function* () {
          yield* dockerExec(container, ["createdb", "-U", user, targetDb])
          yield* shell.exec("docker", [
            "exec", container, "bash", "-c",
            `pg_dump -U ${user} ${sourceDb} | psql -U ${user} ${targetDb}`
          ])
        }).pipe(Effect.asVoid),

      dbExists: (container, user, dbName) =>
        dockerExec(container, ["psql", "-U", user, "-lqt"]).pipe(
          Effect.map((r) =>
            r.stdout.split("\n").some((line) => line.trim().startsWith(dbName))
          ),
          Effect.catchAll(() => Effect.succeed(false))
        ),

      isContainerRunning: (container) =>
        shell.exec("docker", ["exec", container, "pg_isready", "-q"]).pipe(
          Effect.map(() => true),
          Effect.catchAll(() => Effect.succeed(false))
        )
    })
  })
)
