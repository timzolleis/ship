import { FileSystem, Path } from "@effect/platform"
import type { PlatformError } from "@effect/platform/Error"
import { Effect, Context, Layer } from "effect"
import { ShellService } from "./shell.js"
import { RouteExistsError, RouteNotFoundError, CertNotFoundError } from "../errors.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Route {
  readonly domain: string
  readonly port: number
}

export type ProxyError = RouteExistsError | RouteNotFoundError | CertNotFoundError | PlatformError

// ---------------------------------------------------------------------------
// ProxyService
// ---------------------------------------------------------------------------

export class ProxyService extends Context.Tag("ProxyService")<
  ProxyService,
  {
    readonly configDir: () => Effect.Effect<string>
    readonly caddyfilePath: () => Effect.Effect<string>
    readonly ensureSetup: () => Effect.Effect<void, PlatformError>
    readonly isRunning: () => Effect.Effect<boolean>
    readonly getRoutes: () => Effect.Effect<ReadonlyArray<Route>, PlatformError>
    readonly addRoute: (domain: string, port: number) => Effect.Effect<void, RouteExistsError | PlatformError>
    readonly removeRoute: (domain: string) => Effect.Effect<void, RouteNotFoundError | PlatformError>
    readonly reload: () => Effect.Effect<void>
    readonly start: () => Effect.Effect<void, PlatformError>
    readonly stop: () => Effect.Effect<void>
    readonly status: () => Effect.Effect<{ running: boolean; routes: ReadonlyArray<Route> }, PlatformError>
    readonly trust: () => Effect.Effect<void, CertNotFoundError | PlatformError>
    readonly nextPort: () => Effect.Effect<number, PlatformError>
    readonly editCaddyfile: () => Effect.Effect<void, PlatformError>
  }
>() {}

const CONTAINER = "ship-proxy"
const BASE_PORT = 5173

export const ProxyServiceLive = Layer.effect(
  ProxyService,
  Effect.gen(function* () {
    const fsSvc = yield* FileSystem.FileSystem
    const pathSvc = yield* Path.Path
    const shell = yield* ShellService

    const home = process.env.HOME ?? process.env.USERPROFILE ?? "~"
    const proxyDir = pathSvc.join(home, ".config", "ship")
    const caddyfile = pathSvc.join(proxyDir, "Caddyfile")
    const caddyData = pathSvc.join(proxyDir, "caddy-data")
    const caddyConfig = pathSvc.join(proxyDir, "caddy-config")

    // -- Internal helpers --

    const ensureSetup = (): Effect.Effect<void, PlatformError> =>
      Effect.gen(function* () {
        yield* fsSvc.makeDirectory(proxyDir, { recursive: true })
        yield* fsSvc.makeDirectory(caddyData, { recursive: true })
        yield* fsSvc.makeDirectory(caddyConfig, { recursive: true })
        const exists = yield* fsSvc.exists(caddyfile)
        if (!exists) yield* fsSvc.writeFileString(caddyfile, "")
      })

    const readCaddyfile = (): Effect.Effect<string, PlatformError> =>
      Effect.gen(function* () {
        yield* ensureSetup()
        return yield* fsSvc.readFileString(caddyfile)
      })

    const writeCaddyfile = (content: string): Effect.Effect<void, PlatformError> =>
      fsSvc.writeFileString(caddyfile, content)

    // -- Public methods --

    const isRunning = (): Effect.Effect<boolean> =>
      shell.exec("docker", ["ps", "--format", "{{.Names}}"]).pipe(
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
          if (domainMatch) currentDomain = domainMatch[1]!
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
            ? shell.exec("docker", ["exec", CONTAINER, "caddy", "reload", "--config", "/etc/caddy/Caddyfile"]).pipe(
                Effect.asVoid,
                Effect.catchAll(() => Effect.void)
              )
            : Effect.void
        )
      )

    const addRoute = (domain: string, port: number): Effect.Effect<void, RouteExistsError | PlatformError> =>
      Effect.gen(function* () {
        const content = yield* readCaddyfile()
        if (content.includes(`${domain} {`)) {
          return yield* new RouteExistsError({ domain })
        }
        const block = `\n${domain} {\n    reverse_proxy host.docker.internal:${port}\n}\n`
        yield* writeCaddyfile(content + block)
        yield* reload()
      })

    const removeRoute = (domain: string): Effect.Effect<void, RouteNotFoundError | PlatformError> =>
      Effect.gen(function* () {
        const content = yield* readCaddyfile()
        if (!content.includes(`${domain} {`)) {
          return yield* new RouteNotFoundError({ domain })
        }
        const lines = content.split("\n")
        const result: string[] = []
        let skip = false
        for (const line of lines) {
          if (line.startsWith(`${domain} {`)) { skip = true; continue }
          if (skip && line.trim() === "}") { skip = false; continue }
          if (!skip) result.push(line)
        }
        const cleaned = result.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n"
        yield* writeCaddyfile(cleaned)
        yield* reload()
      })

    const start = (): Effect.Effect<void, PlatformError> =>
      Effect.gen(function* () {
        yield* ensureSetup()
        const running = yield* isRunning()
        if (running) return
        yield* shell.exec("docker", ["rm", "-f", CONTAINER]).pipe(Effect.catchAll(() => Effect.void))
        yield* shell.exec("docker", [
          "run", "-d",
          "--name", CONTAINER,
          "--restart", "unless-stopped",
          "-p", "80:80",
          "-p", "443:443",
          "-v", `${caddyfile}:/etc/caddy/Caddyfile:ro`,
          "-v", `${caddyData}:/data`,
          "-v", `${caddyConfig}:/config`,
          "caddy:2-alpine"
        ])
      }).pipe(Effect.asVoid)

    const stop = (): Effect.Effect<void> =>
      shell.exec("docker", ["rm", "-f", CONTAINER]).pipe(
        Effect.catchAll(() => Effect.void),
        Effect.asVoid
      )

    const trust = (): Effect.Effect<void, CertNotFoundError | PlatformError> =>
      Effect.gen(function* () {
        const caPath = pathSvc.join(caddyData, "caddy", "pki", "authorities", "local", "root.crt")
        const exists = yield* fsSvc.exists(caPath)
        if (!exists) return yield* new CertNotFoundError()
        yield* shell.exec("sudo", [
          "security", "add-trusted-cert", "-d", "-r", "trustRoot",
          "-k", "/Library/Keychains/System.keychain", caPath
        ])
      }).pipe(Effect.asVoid)

    const nextPort = (): Effect.Effect<number, PlatformError> =>
      getRoutes().pipe(
        Effect.map((routes) => {
          let max = BASE_PORT
          for (const route of routes) {
            if (route.port > max) max = route.port
          }
          return max + 1
        })
      )

    const editCaddyfile = (): Effect.Effect<void, PlatformError> =>
      Effect.gen(function* () {
        yield* ensureSetup()
        const editor = process.env.EDITOR ?? "vi"
        yield* shell.execInteractive(editor, [caddyfile])
        yield* reload()
      })

    return ProxyService.of({
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
      status: () => Effect.all({ running: isRunning(), routes: getRoutes() }),
      trust,
      nextPort,
      editCaddyfile
    })
  })
)
