import { FileSystem, Path } from "@effect/platform"
import { Effect } from "effect"
import { ShellService } from "./shell.js"
import {
  ShellExecError,
  RouteExistsError,
  RouteNotFoundError,
  CertNotFoundError,
  CreateDirectoryError,
  ReadFileError,
  WriteFileError
} from "../errors.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Route {
  readonly domain: string
  readonly port: number
}

type FsError = CreateDirectoryError | ReadFileError | WriteFileError

export type ProxyError =
  | RouteExistsError
  | RouteNotFoundError
  | CertNotFoundError
  | ShellExecError
  | FsError

// ---------------------------------------------------------------------------
// ProxyService
// ---------------------------------------------------------------------------

const CONTAINER = "ship-proxy"
const BASE_PORT = 5173

export class ProxyService extends Effect.Service<ProxyService>()("ProxyService", {
  effect: Effect.gen(function* () {
    const fsSvc = yield* FileSystem.FileSystem
    const pathSvc = yield* Path.Path
    const shell = yield* ShellService

    const home = process.env.HOME ?? process.env.USERPROFILE ?? "~"
    const proxyDir = pathSvc.join(home, ".config", "ship")
    const caddyfile = pathSvc.join(proxyDir, "Caddyfile")
    const caddyData = pathSvc.join(proxyDir, "caddy-data")
    const caddyConfig = pathSvc.join(proxyDir, "caddy-config")

    // -- Fs helpers with mapped errors --

    const mkDir = (path: string): Effect.Effect<void, CreateDirectoryError> =>
      fsSvc.makeDirectory(path, { recursive: true }).pipe(
        Effect.mapError((e) => new CreateDirectoryError({ path, detail: String(e) }))
      )

    const readFile = (path: string): Effect.Effect<string, ReadFileError> =>
      fsSvc.readFileString(path).pipe(
        Effect.mapError((e) => new ReadFileError({ path, detail: String(e) }))
      )

    const writeFile = (path: string, content: string): Effect.Effect<void, WriteFileError> =>
      fsSvc.writeFileString(path, content).pipe(
        Effect.mapError((e) => new WriteFileError({ path, detail: String(e) }))
      )

    const fileExists = (path: string): Effect.Effect<boolean, ReadFileError> =>
      fsSvc.exists(path).pipe(
        Effect.mapError((e) => new ReadFileError({ path, detail: String(e) }))
      )

    // -- Internal helpers --

    const ensureSetup: () => Effect.Effect<void, FsError> =
      Effect.fn("ProxyService.ensureSetup")(function* () {
        yield* mkDir(proxyDir)
        yield* mkDir(caddyData)
        yield* mkDir(caddyConfig)
        const exists = yield* fileExists(caddyfile)
        if (!exists) yield* writeFile(caddyfile, "")
      })

    const readCaddyfile = (): Effect.Effect<string, FsError> =>
      Effect.gen(function* () {
        yield* ensureSetup()
        return yield* readFile(caddyfile)
      })

    // -- Public methods --

    const isRunning: () => Effect.Effect<boolean> =
      Effect.fn("ProxyService.isRunning")(function* () {
        return yield* shell.exec("docker", ["ps", "--format", "{{.Names}}"]).pipe(
          Effect.map((result) =>
            result.stdout.split("\n").some((name) => name.trim() === CONTAINER)
          ),
          Effect.catchAll(() => Effect.succeed(false))
        )
      })

    const getRoutes: () => Effect.Effect<ReadonlyArray<Route>, FsError> =
      Effect.fn("ProxyService.getRoutes")(function* () {
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

    const reload: () => Effect.Effect<void> =
      Effect.fn("ProxyService.reload")(function* () {
        yield* isRunning().pipe(
          Effect.flatMap((running) =>
            running
              ? shell.exec("docker", ["exec", CONTAINER, "caddy", "reload", "--config", "/etc/caddy/Caddyfile"]).pipe(
                  Effect.asVoid,
                  Effect.catchAll(() => Effect.void)
                )
              : Effect.void
          )
        )
      })

    const addRoute: (domain: string, port: number) => Effect.Effect<void, RouteExistsError | FsError> =
      Effect.fn("ProxyService.addRoute")(function* (domain, port) {
        const content = yield* readCaddyfile()
        if (content.includes(`${domain} {`)) {
          return yield* new RouteExistsError({ domain })
        }
        const block = `\n${domain} {\n    reverse_proxy host.docker.internal:${port}\n}\n`
        yield* writeFile(caddyfile, content + block)
        yield* reload()
      })

    const removeRoute: (domain: string) => Effect.Effect<void, RouteNotFoundError | FsError> =
      Effect.fn("ProxyService.removeRoute")(function* (domain) {
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
        yield* writeFile(caddyfile, cleaned)
        yield* reload()
      })

    const start: () => Effect.Effect<void, ShellExecError | FsError> =
      Effect.fn("ProxyService.start")(function* () {
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
      })

    const stop: () => Effect.Effect<void> =
      Effect.fn("ProxyService.stop")(function* () {
        yield* shell.exec("docker", ["rm", "-f", CONTAINER]).pipe(
          Effect.catchAll(() => Effect.void)
        )
      })

    const trust: () => Effect.Effect<void, CertNotFoundError | ShellExecError | ReadFileError> =
      Effect.fn("ProxyService.trust")(function* () {
        const caPath = pathSvc.join(caddyData, "caddy", "pki", "authorities", "local", "root.crt")
        const exists = yield* fileExists(caPath)
        if (!exists) return yield* new CertNotFoundError()
        yield* shell.exec("sudo", [
          "security", "add-trusted-cert", "-d", "-r", "trustRoot",
          "-k", "/Library/Keychains/System.keychain", caPath
        ])
      })

    const nextPort: () => Effect.Effect<number, FsError> =
      Effect.fn("ProxyService.nextPort")(function* () {
        const routes = yield* getRoutes()
        let max = BASE_PORT
        for (const route of routes) {
          if (route.port > max) max = route.port
        }
        return max + 1
      })

    const editCaddyfile: () => Effect.Effect<void, ShellExecError | FsError> =
      Effect.fn("ProxyService.editCaddyfile")(function* () {
        yield* ensureSetup()
        const editor = process.env.EDITOR ?? "vi"
        yield* shell.execInteractive(editor, [caddyfile])
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
      status: () => Effect.all({ running: isRunning(), routes: getRoutes() }),
      trust,
      nextPort,
      editCaddyfile
    }
  }),
  dependencies: [ShellService.Default]
}) {}
