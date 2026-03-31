import { Command, Options } from "@effect/cli"
import { CommandExecutor } from "@effect/platform"
import { Console, Effect, Option } from "effect"
import { ConfigService } from "../services/config.js"
import { ProxyService } from "../services/proxy.js"
import * as Shell from "../services/shell.js"

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const red = (s: string) => `\x1b[31m${s}\x1b[0m`
const blue = (s: string) => `\x1b[34m${s}\x1b[0m`

// ---------------------------------------------------------------------------
// ship up [--open]
// ---------------------------------------------------------------------------

const openOpt = Options.boolean("open")

export const upCommand = Command.make(
  "up",
  { open: openOpt },
  ({ open }) =>
    Effect.gen(function* () {
      const config = yield* ConfigService
      const proxy = yield* ProxyService
      const executor = yield* CommandExecutor.CommandExecutor

      const run = <A, E>(effect: Effect.Effect<A, E, CommandExecutor.CommandExecutor>) =>
        Effect.provideService(effect, CommandExecutor.CommandExecutor, executor)

      // Find current workspace from cwd
      const workspaces = yield* config.loadWorkspaces()
      const cwd = process.cwd()
      const workspace = workspaces.find((w) => cwd.startsWith(w.path))

      if (!workspace) {
        yield* Console.log(`  ${red("✗")} Not inside a workspace. cd into one first, or use 'ship create'.`)
        return
      }

      const projectConfig = yield* config.getProject(workspace.project)

      // Ensure proxy is running
      const proxyRunning = yield* proxy.isRunning()
      if (!proxyRunning) {
        yield* proxy.start()
        yield* Console.log(`  ${green("●")} Proxy started.`)
      }

      // Ensure route exists
      yield* proxy.addRoute(workspace.proxyDomain, workspace.port).pipe(
        Effect.catchAll(() => Effect.void)
      )

      yield* Console.log(`  ${green("●")} ${bold(workspace.proxyDomain)} ${dim("→")} localhost:${blue(String(workspace.port))}`)

      // Resolve dev command
      const devCmd = projectConfig.commands.dev
      if (!devCmd) {
        yield* Console.log(`  ${dim("No dev command configured. Proxy route is active.")}`)
        return
      }

      const resolvedCmd = devCmd.replace(/\{port\}/g, String(workspace.port))

      if (open) {
        // Open browser after a short delay
        setTimeout(() => {
          import("child_process").then((cp) => {
            cp.exec(`open https://${workspace.proxyDomain}`)
          })
        }, 2000)
      }

      yield* Console.log(`  ${dim(`Running: ${resolvedCmd}`)}`)
      yield* Console.log("")

      // exec the dev command (replaces this process)
      yield* run(Shell.execInDir(workspace.path, resolvedCmd))
    }).pipe(
      Effect.catchAll((e) =>
        Console.error(`\n  ${red("Error:")} ${"message" in e ? e.message : String(e)}\n`)
      )
    )
)
