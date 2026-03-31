import { Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { ConfigService } from "../services/config.js"
import { DatabaseService } from "../services/database.js"
import { ShellService } from "../services/shell.js"
import { bold, green, red, yellow } from "../fmt.js"

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
      const db = yield* DatabaseService
      const shell = yield* ShellService

      // Find current workspace
      const workspaces = yield* config.loadWorkspaces()
      const cwd = process.cwd()
      const workspace = workspaces.find((w) => cwd.startsWith(w.path))

      if (!workspace) {
        yield* Console.log(`  ${red("✗")} Not inside a workspace.`)
        return
      }

      const projectConfig = yield* config.getProject(workspace.project)
      const dbConfig = projectConfig.database

      yield* Console.log("")
      yield* Console.log(`  Resetting database for ${bold(workspace.branch)}...`)
      yield* Console.log("")

      // 1. Drop existing DB
      yield* db.dropDb(dbConfig.container, dbConfig.user, workspace.dbName).pipe(
        Effect.tap(() => Console.log(`  ${green("✓")} Dropped ${workspace.dbName}`)),
        Effect.catchAll(() =>
          Console.log(`  ${yellow("⚠")} ${workspace.dbName} did not exist`)
        )
      )

      if (fresh) {
        // 2a. Create empty DB
        yield* db.createDb(dbConfig.container, dbConfig.user, workspace.dbName)
        yield* Console.log(`  ${green("✓")} Created empty ${workspace.dbName}`)
      } else {
        // 2b. Clone from source
        yield* db.cloneDb(dbConfig.container, dbConfig.user, dbConfig.source, workspace.dbName)
        yield* Console.log(`  ${green("✓")} Cloned ${dbConfig.source} → ${workspace.dbName}`)
      }

      // 3. Re-run migrations
      if (projectConfig.commands.migrate) {
        yield* shell.execInDir(workspace.path, projectConfig.commands.migrate)
        yield* Console.log(`  ${green("✓")} Migrations applied`)
      }

      // 4. Seed if fresh and seed command exists
      if (fresh && projectConfig.commands.seed) {
        yield* Console.log(`  Running seed...`)
        yield* shell.execInDir(workspace.path, projectConfig.commands.seed)
        yield* Console.log(`  ${green("✓")} Seeded`)
      }

      yield* Console.log("")
      yield* Console.log(`  ${green("Database reset.")}`)
      yield* Console.log("")
    }).pipe(
      Effect.catchAll((e) =>
        Console.error(`\n  ${red("Error:")} ${e.message}\n`)
      )
    )
)
