import { Args, Command } from "@effect/cli"
import { CommandExecutor } from "@effect/platform"
import { Console, Effect } from "effect"
import { ConfigService } from "../services/config.js"
import * as Shell from "../services/shell.js"

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`
const red = (s: string) => `\x1b[31m${s}\x1b[0m`
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`

// ---------------------------------------------------------------------------
// ship open [target]
//   target: editor (default), url, db
// ---------------------------------------------------------------------------

const targetArg = Args.text({ name: "target" }).pipe(Args.withDefault("editor"))

export const openCommand = Command.make(
  "open",
  { target: targetArg },
  ({ target }) =>
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

      switch (target) {
        case "editor": {
          const shipConfig = yield* config.loadConfig()
          const editor = shipConfig.editor ?? "code"
          yield* Console.log(`  Opening in ${bold(editor)}...`)
          yield* run(Shell.exec(editor, [workspace.path]))
          break
        }
        case "url": {
          const url = `https://${workspace.proxyDomain}`
          yield* Console.log(`  Opening ${bold(url)}...`)
          yield* run(Shell.exec("open", [url]))
          break
        }
        case "db": {
          const db = projectConfig.database
          yield* Console.log(`  Connecting to ${bold(workspace.dbName)}...`)
          yield* run(Shell.execInteractive("docker", [
            "exec", "-it", db.container,
            "psql", "-U", db.user, workspace.dbName
          ]))
          break
        }
        default:
          yield* Console.log(`  ${red("✗")} Unknown target '${target}'. Use: editor, url, db`)
      }
    }).pipe(
      Effect.catchAll((e) =>
        Console.error(`\n  ${red("Error:")} ${"message" in e ? e.message : String(e)}\n`)
      )
    )
)
