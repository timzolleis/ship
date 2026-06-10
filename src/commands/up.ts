import { Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { ConfigService } from "../services/config.js"
import { ProxyService } from "../services/proxy.js"
import { ShellService } from "../services/shell.js"
import { ProjectConfig } from "../schema/config.js"
import { bold, dim, green, red, blue } from "../fmt.js"

const isInside = (cwd: string, path: string) => cwd === path || cwd.startsWith(path + "/")

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

      // Find current workspace from cwd, falling back to a project root checkout
      const workspaces = yield* config.loadWorkspaces()
      const cwd = process.cwd()
      const workspace = workspaces.find((w) => isInside(cwd, w.path))

      let target: { project: string; domain: string; port: number; path: string }
      if (workspace) {
        target = {
          project: workspace.project,
          domain: workspace.proxyDomain,
          port: workspace.port,
          path: workspace.path
        }
      } else {
        const shipConfig = yield* config.loadConfig()
        const entry = Object.entries(shipConfig.projects).find(([, p]) => isInside(cwd, p.path))
        if (!entry) {
          yield* Console.log(`  ${red("✗")} Not inside a workspace or registered project. Use 'ship init' or 'ship create' first.`)
          return
        }
        const [alias, rootProject] = entry
        const domain = rootProject.domain ?? `${alias}.localhost`
        let port = rootProject.port
        if (port === undefined) {
          // Project registered before root routes existed — allocate and persist
          port = yield* proxy.nextPort()
          yield* config.addProject(alias, new ProjectConfig({ ...rootProject, domain, port }))
        }
        target = { project: alias, domain, port, path: rootProject.path }
      }

      const projectConfig = yield* config.getProject(target.project)

      // Ensure proxy is running
      const proxyRunning = yield* proxy.isRunning()
      if (!proxyRunning) {
        yield* proxy.start()
        yield* Console.log(`  ${green("●")} Proxy started.`)
      }

      // Ensure route exists
      yield* proxy.addRoute(target.domain, target.port).pipe(
        Effect.catchAll(() => Effect.void)
      )

      yield* Console.log(`  ${green("●")} ${bold(target.domain)} ${dim("→")} localhost:${blue(String(target.port))}`)

      // Resolve dev command
      const devCmd = projectConfig.commands.dev
      if (!devCmd) {
        yield* Console.log(`  ${dim("No dev command configured. Proxy route is active.")}`)
        return
      }

      const resolvedCmd = devCmd.replace(/\{port\}/g, String(target.port))

      // Open browser after a short delay (in a background fiber)
      if (open) {
        yield* shell.exec("open", [`https://${target.domain}`]).pipe(
          Effect.delay("2 seconds"),
          Effect.catchAll(() => Effect.void),
          Effect.fork
        )
      }

      yield* Console.log(`  ${dim(`Running: ${resolvedCmd}`)}`)
      yield* Console.log("")

      // Run the dev command (blocks until it exits)
      yield* shell.execInDir(target.path, resolvedCmd)
    }).pipe(
      Effect.catchAll((e) =>
        Console.error(`\n  ${red("Error:")} ${e.message}\n`)
      )
    )
)
