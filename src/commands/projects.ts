import { Command } from "@effect/cli"
import { Console, Effect } from "effect"
import { ConfigService } from "../services/config.js"
import { dockerContainerOf } from "../schema/config.js"
import { bold, dim, blue } from "../fmt.js"

// ---------------------------------------------------------------------------
// ship projects — list registered projects
// ---------------------------------------------------------------------------

export const projectsCommand = Command.make(
  "projects",
  {},
  () =>
    Effect.gen(function* () {
      const config = yield* ConfigService
      const shipConfig = yield* config.loadConfig()
      const entries = Object.entries(shipConfig.projects)

      if (entries.length === 0) {
        yield* Console.log("")
        yield* Console.log(`  ${dim("No projects registered.")}`)
        yield* Console.log(`  ${dim("Register one with: ship init")}`)
        yield* Console.log("")
        return
      }

      const aliasWidth = Math.max(7, ...entries.map(([a]) => a.length))

      yield* Console.log("")
      yield* Console.log(
        `  ${"ALIAS".padEnd(aliasWidth)}  ${"PATH".padEnd(40)}  ${"DB CONTAINER"}`
      )
      yield* Console.log(
        `  ${dim("─".repeat(aliasWidth))}  ${dim("─".repeat(40))}  ${dim("─".repeat(16))}`
      )

      for (const [alias, project] of entries) {
        yield* Console.log(
          `  ${bold(alias.padEnd(aliasWidth))}  ${blue(project.path.padEnd(40))}  ${dockerContainerOf(project.database)}`
        )
      }

      yield* Console.log("")
      yield* Console.log(`  ${dim(`${entries.length} project${entries.length === 1 ? "" : "s"}`)}`)
      yield* Console.log("")
    }).pipe(
      Effect.catchAll((e) =>
        Console.error(`Error: ${e.message}`)
      )
    )
)
