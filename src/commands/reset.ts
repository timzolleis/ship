import { Command, Options, Prompt } from "@effect/cli"
import { CommandExecutor, FileSystem, Path } from "@effect/platform"
import { Console, Effect } from "effect"
import { ConfigService } from "../services/config.js"
import * as Database from "../services/database.js"
import * as Env from "../services/env.js"
import * as Shell from "../services/shell.js"

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const red = (s: string) => `\x1b[31m${s}\x1b[0m`
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`

// ---------------------------------------------------------------------------
// ship reset [--fresh]
// ---------------------------------------------------------------------------

const freshOpt = Options.boolean("fresh")

export const resetCommand = Command.make(
  "reset",
  { fresh: freshOpt },
  ({ fresh }) =>
    Effect.gen(function* () {
      const config = yield* ConfigService
      const executor = yield* CommandExecutor.CommandExecutor

      const run = <A, E>(effect: Effect.Effect<A, E, CommandExecutor.CommandExecutor>) =>
        Effect.provideService(effect, CommandExecutor.CommandExecutor, executor)

      // Find current workspace
      const workspaces = yield* config.loadWorkspaces()
      const cwd = process.cwd()
      const workspace = workspaces.find((w) => cwd.startsWith(w.path))

      if (!workspace) {
        yield* Console.log(`  ${red("✗")} Not inside a workspace.`)
        return
      }

      const projectConfig = yield* config.getProject(workspace.project)
      const db = projectConfig.database

      yield* Console.log("")
      yield* Console.log(`  Resetting database for ${bold(workspace.branch)}...`)
      yield* Console.log("")

      // 1. Drop existing DB
      yield* run(Database.dropDb(db.container, db.user, workspace.dbName)).pipe(
        Effect.tap(() => Console.log(`  ${green("✓")} Dropped ${workspace.dbName}`)),
        Effect.catchAll(() =>
          Console.log(`  ${yellow("⚠")} ${workspace.dbName} did not exist`)
        )
      )

      if (fresh) {
        // 2a. Create empty DB
        yield* run(Database.createDb(db.container, db.user, workspace.dbName))
        yield* Console.log(`  ${green("✓")} Created empty ${workspace.dbName}`)
      } else {
        // 2b. Clone from source
        yield* run(Database.cloneDb(db.container, db.user, db.source, workspace.dbName))
        yield* Console.log(`  ${green("✓")} Cloned ${db.source} → ${workspace.dbName}`)
      }

      // 3. Re-run migrations
      if (projectConfig.commands.migrate) {
        const dbUrl = `postgresql://${db.user}@${db.host}:${db.port}/${workspace.dbName}`
        yield* run(Shell.execInDir(workspace.path, projectConfig.commands.migrate, {
          DATABASE_URL: dbUrl
        }))
        yield* Console.log(`  ${green("✓")} Migrations applied`)
      }

      // 4. Seed if fresh and seed command exists
      if (fresh && projectConfig.commands.seed) {
        yield* Console.log(`  Running seed...`)
        const dbUrl = `postgresql://${db.user}@${db.host}:${db.port}/${workspace.dbName}`
        yield* run(Shell.execInDir(workspace.path, projectConfig.commands.seed, {
          DATABASE_URL: dbUrl
        }))
        yield* Console.log(`  ${green("✓")} Seeded`)
      }

      yield* Console.log("")
      yield* Console.log(`  ${green("Database reset.")}`)
      yield* Console.log("")
    }).pipe(
      Effect.catchAll((e) =>
        Console.error(`\n  ${red("Error:")} ${"message" in e ? e.message : String(e)}\n`)
      )
    )
)
