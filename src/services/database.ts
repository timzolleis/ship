import { CommandExecutor } from "@effect/platform"
import type { PlatformError } from "@effect/platform/Error"
import { Effect } from "effect"
import * as Shell from "./shell.js"

// ---------------------------------------------------------------------------
// Database operations via docker exec
// ---------------------------------------------------------------------------

export type DbError = PlatformError

const dockerExec = (container: string, args: ReadonlyArray<string>) =>
  Shell.exec("docker", ["exec", container, ...args])

export const createDb = (
  container: string,
  user: string,
  dbName: string
): Effect.Effect<void, DbError, CommandExecutor.CommandExecutor> =>
  dockerExec(container, ["createdb", "-U", user, dbName]).pipe(Effect.asVoid)

export const dropDb = (
  container: string,
  user: string,
  dbName: string
): Effect.Effect<void, DbError, CommandExecutor.CommandExecutor> =>
  dockerExec(container, ["dropdb", "--if-exists", "-U", user, dbName]).pipe(Effect.asVoid)

export const cloneDb = (
  container: string,
  user: string,
  sourceDb: string,
  targetDb: string
): Effect.Effect<void, DbError, CommandExecutor.CommandExecutor> =>
  Effect.gen(function* () {
    yield* createDb(container, user, targetDb)
    // pg_dump source | psql target
    yield* Shell.exec("docker", [
      "exec", container, "bash", "-c",
      `pg_dump -U ${user} ${sourceDb} | psql -U ${user} ${targetDb}`
    ])
  }).pipe(Effect.asVoid)

export const dbExists = (
  container: string,
  user: string,
  dbName: string
): Effect.Effect<boolean, DbError, CommandExecutor.CommandExecutor> =>
  dockerExec(container, ["psql", "-U", user, "-lqt"]).pipe(
    Effect.map((r) =>
      r.stdout.split("\n").some((line) => line.trim().startsWith(dbName))
    ),
    Effect.catchAll(() => Effect.succeed(false))
  )

export const isContainerRunning = (
  container: string
): Effect.Effect<boolean, never, CommandExecutor.CommandExecutor> =>
  Shell.exec("docker", ["exec", container, "pg_isready", "-q"]).pipe(
    Effect.map(() => true),
    Effect.catchAll(() => Effect.succeed(false))
  )
