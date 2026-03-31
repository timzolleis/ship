import { Args, Command } from "@effect/cli"
import { Console, Effect, Option } from "effect"
import { ConfigService } from "../services/config.js"
import { bold, dim, blue } from "../fmt.js"

// ---------------------------------------------------------------------------
// ship ls [project]
// ---------------------------------------------------------------------------

const projectArg = Args.text({ name: "project" }).pipe(Args.optional)

export const listCommand = Command.make(
  "ls",
  { project: projectArg },
  ({ project: projectOpt }) =>
    Effect.gen(function* () {
      const config = yield* ConfigService
      const workspaces = yield* config.loadWorkspaces()

      // Filter by project if specified
      const filtered = Option.isSome(projectOpt)
        ? workspaces.filter((w) => w.project === projectOpt.value)
        : workspaces

      if (filtered.length === 0) {
        yield* Console.log("")
        yield* Console.log(`  ${dim("No active workspaces.")}`)
        yield* Console.log(`  ${dim("Create one with: ship create <project> <branch>")}`)
        yield* Console.log("")
        return
      }

      // Group by project
      const byProject = new Map<string, Array<typeof filtered[number]>>()
      for (const ws of filtered) {
        const existing = byProject.get(ws.project) ?? []
        existing.push(ws)
        byProject.set(ws.project, existing)
      }

      yield* Console.log("")

      for (const [project, workspacesList] of byProject) {
        yield* Console.log(`  ${bold(project)} workspaces:`)
        yield* Console.log("")

        // Header
        yield* Console.log(
          `  ${"BRANCH".padEnd(22)} ${"PROXY".padEnd(38)} ${"DB".padEnd(22)} ${"PORT"}`
        )
        yield* Console.log(
          `  ${dim("─".repeat(22))} ${dim("─".repeat(38))} ${dim("─".repeat(22))} ${dim("─".repeat(6))}`
        )

        for (const ws of workspacesList) {
          yield* Console.log(
            `  ${bold(ws.branch.padEnd(22))} ${blue(ws.proxyDomain.padEnd(38))} ${ws.dbName.padEnd(22)} ${blue(String(ws.port))}`
          )
        }
        yield* Console.log("")
      }

      yield* Console.log(`  ${dim(`${filtered.length} workspace${filtered.length === 1 ? "" : "s"}`)}`)
      yield* Console.log("")
    }).pipe(
      Effect.catchAll((e) =>
        Console.error(`Error: ${e.message}`)
      )
    )
)
