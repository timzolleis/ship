import { Args, Command } from "@effect/cli"
import { Console, Effect } from "effect"
import { ConfigService } from "../services/config.js"
import { SyncService } from "../services/sync.js"
import { bold, dim, green, yellow, red } from "../fmt.js"

// ---------------------------------------------------------------------------
// ship sync <project>
// ---------------------------------------------------------------------------

const projectArg = Args.text({ name: "project" })

export const syncCommand = Command.make(
  "sync",
  { project: projectArg },
  ({ project }) =>
    Effect.gen(function* () {
      const config = yield* ConfigService
      const sync = yield* SyncService

      const projectConfig = yield* config.getProject(project)

      yield* Console.log("")
      yield* Console.log(`  Syncing ${bold(project)}...`)

      const result = yield* sync.sync(projectConfig)

      yield* Console.log(`  ${green("✓")} Fetched        origin`)

      if (result.pulled && result.headMoved) {
        yield* Console.log(`  ${green("✓")} Pulled         main ${dim("(fast-forward)")}`)
      } else if (result.pulled) {
        yield* Console.log(`  ${dim("  ·")} Pulled         ${dim("already up to date")}`)
      } else if (result.skippedPull) {
        yield* Console.log(`  ${yellow("⚠")} Skipped pull   ${dim(result.skippedPull)}`)
      }

      if (result.installed) {
        yield* Console.log(`  ${green("✓")} Dependencies   installed`)
      }
      if (result.migrated) {
        yield* Console.log(`  ${green("✓")} Migrations     applied ${dim(`(${projectConfig.database.source})`)}`)
      }

      yield* Console.log("")
    }).pipe(
      Effect.catchAll((e) =>
        Console.error(`\n  ${red("Error:")} ${e.message}\n`)
      )
    )
)
