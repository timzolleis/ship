import { Command, Options } from "@effect/cli"
import { Console, Effect, Option, Stream } from "effect"
import { locateWorkspace } from "../domain/workspace-locate.js"
import type { Workspace } from "../schema/workspace.js"
import { ConfigService } from "../services/config.js"
import { WorkspaceService } from "../services/workspace.js"
import type { ResetStep, StepEvent } from "../services/workspace.js"
import { bold, green, red } from "../fmt.js"

// ---------------------------------------------------------------------------
// ship reset [--fresh]
//
// Thin command: locate the current workspace, then render the event stream
// from WorkspaceService.resetDatabase. All reset logic lives in the service.
// ---------------------------------------------------------------------------

const freshOpt = Options.boolean("fresh")

const renderEvent = (ws: Workspace) => (event: StepEvent<ResetStep>) => {
  switch (event.step) {
    case "drop":
      return Console.log(`  ${green("✓")} Dropped ${ws.dbName}`)
    case "create":
      return Console.log(`  ${green("✓")} Created empty ${ws.dbName}`)
    case "clone":
      return Console.log(`  ${green("✓")} Cloned → ${ws.dbName}`)
    case "migrate":
      return Console.log(`  ${green("✓")} Migrations applied`)
    case "seed":
      return Console.log(`  ${green("✓")} Seeded`)
  }
}

export const runReset = (cwd: string, fresh: boolean) =>
  Effect.gen(function* () {
    const config = yield* ConfigService
    const ws = yield* WorkspaceService

    const workspaces = yield* config.loadWorkspaces()
    const located = locateWorkspace(workspaces, { cwd })

    if (Option.isNone(located)) {
      yield* Console.log(`  ${red("✗")} Not inside a workspace.`)
      return
    }
    const workspace = located.value

    const projectConfig = yield* config.getProject(workspace.project)

    yield* Console.log("")
    yield* Console.log(`  Resetting database for ${bold(workspace.branch)}...`)
    yield* Console.log("")

    yield* Stream.runForEach(
      ws.resetDatabase(workspace, projectConfig, { fresh }),
      renderEvent(workspace)
    )

    yield* Console.log("")
    yield* Console.log(`  ${green("Database reset.")}`)
    yield* Console.log("")
  }).pipe(
    Effect.catchAll((e) => Console.error(`\n  ${red("Error:")} ${e.message}\n`))
  )

export const resetCommand = Command.make(
  "reset",
  { fresh: freshOpt },
  ({ fresh }) => runReset(process.cwd(), fresh)
)
