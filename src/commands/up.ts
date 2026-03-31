import { Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { ConfigService } from "../services/config.js"
import { ProxyService } from "../services/proxy.js"
import { ShellService } from "../services/shell.js"
import { bold, dim, green, red, blue } from "../fmt.js"

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
      const shell = yield* ShellService

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

      // Open browser after a short delay (in a background fiber)
      if (open) {
        yield* shell.exec("open", [`https://${workspace.proxyDomain}`]).pipe(
          Effect.delay("2 seconds"),
          Effect.catchAll(() => Effect.void),
          Effect.fork
        )
      }

      yield* Console.log(`  ${dim(`Running: ${resolvedCmd}`)}`)
      yield* Console.log("")

      // Run the dev command (blocks until it exits)
      yield* shell.execInDir(workspace.path, resolvedCmd)
    }).pipe(
      Effect.catchAll((e) =>
        Console.error(`\n  ${red("Error:")} ${e.message}\n`)
      )
    )
)
