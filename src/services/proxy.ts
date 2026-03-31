import { CommandExecutor, FileSystem, Path } from "@effect/platform"
import type { PlatformError } from "@effect/platform/Error"
import { Effect, Context, Layer } from "effect"
import * as Shell from "./shell.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Route {
  readonly domain: string
  readonly port: number
}

export type ProxyError = Error | PlatformError

// ---------------------------------------------------------------------------
// ProxyService
// ---------------------------------------------------------------------------

export class ProxyService extends Context.Tag("ProxyService")<
  ProxyService,
  {
    readonly configDir: () => Effect.Effect<string>
    readonly caddyfilePath: () => Effect.Effect<string>
    readonly ensureSetup: () => Effect.Effect<void, ProxyError>
    readonly isRunning: () => Effect.Effect<boolean>
    readonly getRoutes: () => Effect.Effect<ReadonlyArray<Route>, ProxyError>
    readonly addRoute: (domain: string, port: number) => Effect.Effect<void, ProxyError>
    readonly removeRoute: (domain: string) => Effect.Effect<void, ProxyError>
    readonly reload: () => Effect.Effect<void>
    readonly start: () => Effect.Effect<void, ProxyError>
    readonly stop: () => Effect.Effect<void>
    readonly status: () => Effect.Effect<{ running: boolean; routes: ReadonlyArray<Route> }, ProxyError>
    readonly trust: () => Effect.Effect<void, ProxyError>
    readonly nextPort: () => Effect.Effect<number, ProxyError>
    readonly editCaddyfile: () => Effect.Effect<void, ProxyError>
  }
>() {}

const CONTAINER = "ship-proxy"
const BASE_PORT = 5173

export const ProxyServiceLive = Layer.effect(
  ProxyService,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const executor = yield* CommandExecutor.CommandExecutor

    // Helper: provide CommandExecutor to shell effects
    const run = <A, E>(effect: Effect.Effect<A, E, CommandExecutor.CommandExecutor>) =>
      Effect.provideService(effect, CommandExecutor.CommandExecutor, executor)

    const home = process.env.HOME ?? process.env.USERPROFILE ?? "~"
    const proxyDir = path.join(home, ".config", "ship")
    const caddyfile = path.join(proxyDir, "Caddyfile")
    const caddyData = path.join(proxyDir, "caddy-data")
    const caddyConfig = path.join(proxyDir, "caddy-config")

    // -- Internal helpers --

    const ensureSetup = (): Effect.Effect<void, PlatformError> =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(proxyDir, { recursive: true })
        yield* fs.makeDirectory(caddyData, { recursive: true })
        yield* fs.makeDirectory(caddyConfig, { recursive: true })
        const exists = yield* fs.exists(caddyfile)
        if (!exists) {
          yield* fs.writeFileString(caddyfile, "")
        }
      })

    const readCaddyfile = (): Effect.Effect<string, PlatformError> =>
      Effect.gen(function* () {
        yield* ensureSetup()
        return yield* fs.readFileString(caddyfile)
      })

    const writeCaddyfile = (content: string): Effect.Effect<void, PlatformError> =>
      fs.writeFileString(caddyfile, content)

    // -- Public methods --

    const isRunning = (): Effect.Effect<boolean> =>
      run(Shell.exec("docker", ["ps", "--format", "{{.Names}}"])).pipe(
        Effect.map((result) =>
          result.stdout.split("\n").some((name) => name.trim() === CONTAINER)
        ),
        Effect.catchAll(() => Effect.succeed(false))
      )

    const getRoutes = (): Effect.Effect<ReadonlyArray<Route>, PlatformError> =>
      Effect.gen(function* () {
        const content = yield* readCaddyfile()
        if (content.trim().length === 0) return [] as ReadonlyArray<Route>
        const routes: Route[] = []
        const lines = content.split("\n")
        let currentDomain: string | null = null
        for (const line of lines) {
          const domainMatch = line.match(/^([a-z0-9][a-z0-9.\-]*)\s*\{/)
          if (domainMatch) {
            currentDomain = domainMatch[1]!
          }
          const proxyMatch = line.match(/reverse_proxy\s+host\.docker\.internal:(\d+)/)
          if (proxyMatch && currentDomain) {
            routes.push({ domain: currentDomain, port: parseInt(proxyMatch[1]!, 10) })
            currentDomain = null
          }
        }
        return routes as ReadonlyArray<Route>
      })

    const reload = (): Effect.Effect<void> =>
      isRunning().pipe(
        Effect.flatMap((running) =>
          running
            ? run(Shell.exec("docker", ["exec", CONTAINER, "caddy", "reload", "--config", "/etc/caddy/Caddyfile"])).pipe(
                Effect.asVoid,
                Effect.catchAll(() => Effect.void)
              )
            : Effect.void
        )
      )

    const addRoute = (domain: string, port: number): Effect.Effect<void, ProxyError> =>
      Effect.gen(function* () {
        const content = yield* readCaddyfile()
        if (content.includes(`${domain} {`)) {
          return yield* Effect.fail(new Error(`Route ${domain} already exists.`))
        }
        const block = `\n${domain} {\n    reverse_proxy host.docker.internal:${port}\n}\n`
        yield* writeCaddyfile(content + block)
        yield* reload()
      })

    const removeRoute = (domain: string): Effect.Effect<void, ProxyError> =>
      Effect.gen(function* () {
        const content = yield* readCaddyfile()
        if (!content.includes(`${domain} {`)) {
          return yield* Effect.fail(new Error(`Route ${domain} not found.`))
        }
        const lines = content.split("\n")
        const result: string[] = []
        let skip = false
        for (const line of lines) {
          if (line.startsWith(`${domain} {`)) {
            skip = true
            continue
          }
          if (skip && line.trim() === "}") {
            skip = false
            continue
          }
          if (!skip) {
            result.push(line)
          }
        }
        const cleaned = result.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n"
        yield* writeCaddyfile(cleaned)
        yield* reload()
      })

    const start = (): Effect.Effect<void, ProxyError> =>
      Effect.gen(function* () {
        yield* ensureSetup()
        const running = yield* isRunning()
        if (running) return
        yield* run(Shell.exec("docker", ["rm", "-f", CONTAINER])).pipe(Effect.catchAll(() => Effect.void))
        yield* run(Shell.exec("docker", [
          "run", "-d",
          "--name", CONTAINER,
          "--restart", "unless-stopped",
          "-p", "80:80",
          "-p", "443:443",
          "-v", `${caddyfile}:/etc/caddy/Caddyfile:ro`,
          "-v", `${caddyData}:/data`,
          "-v", `${caddyConfig}:/config`,
          "caddy:2-alpine"
        ]))
      }).pipe(Effect.asVoid)

    const stop = (): Effect.Effect<void> =>
      run(Shell.exec("docker", ["rm", "-f", CONTAINER])).pipe(
        Effect.catchAll(() => Effect.void),
        Effect.asVoid
      )

    const trust = (): Effect.Effect<void, ProxyError> =>
      Effect.gen(function* () {
        const caPath = path.join(caddyData, "caddy", "pki", "authorities", "local", "root.crt")
        const exists = yield* fs.exists(caPath)
        if (!exists) {
          return yield* Effect.fail(
            new Error("No CA cert yet. Start the proxy and make a request first.")
          )
        }
        yield* run(Shell.exec("sudo", [
          "security", "add-trusted-cert", "-d", "-r", "trustRoot",
          "-k", "/Library/Keychains/System.keychain", caPath
        ]))
      }).pipe(Effect.asVoid)

    const nextPort = (): Effect.Effect<number, ProxyError> =>
      getRoutes().pipe(
        Effect.map((routes) => {
          let max = BASE_PORT
          for (const route of routes) {
            if (route.port > max) max = route.port
          }
          return max + 1
        })
      )

    const editCaddyfile = (): Effect.Effect<void, ProxyError> =>
      Effect.gen(function* () {
        yield* ensureSetup()
        const editor = process.env.EDITOR ?? "vi"
        yield* run(Shell.execInteractive(editor, [caddyfile]))
        yield* reload()
      })

    return {
      configDir: () => Effect.succeed(proxyDir),
      caddyfilePath: () => Effect.succeed(caddyfile),
      ensureSetup,
      isRunning,
      getRoutes,
      addRoute,
      removeRoute,
      reload,
      start,
      stop,
      status: (): Effect.Effect<{ running: boolean; routes: ReadonlyArray<Route> }, ProxyError> =>
        Effect.all({ running: isRunning(), routes: getRoutes() }),
      trust,
      nextPort,
      editCaddyfile
    }
  })
)
