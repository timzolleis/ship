import { FileSystem, Path } from "@effect/platform"
import { Effect, Option, Schema } from "effect"
import { spawn } from "node:child_process"
import { chmod, realpath } from "node:fs/promises"
import { ConfigService } from "./config.js"
import { ShellService } from "./shell.js"
import { UpdateCache } from "../schema/update-cache.js"
import { VERSION } from "../version.js"
import { dim } from "../fmt.js"
import {
  EncodeConfigError,
  UnsupportedPlatformError,
  UpdateCheckError,
  UpdateDownloadError,
  UpdateInstallError,
  WriteFileError
} from "../errors.js"

const REPO = "timzolleis/ship"
const CACHE_FILENAME = "update-cache.json"
const STALE_AFTER_MS = 60 * 60 * 1000
const REFRESH_CMD = "__refresh-update-cache"

const UpdateCacheJson = Schema.parseJson(UpdateCache, { space: 2 })

const assetName = (platform: string, arch: string) => `ship-${platform}-${arch}`

export class UpdaterService extends Effect.Service<UpdaterService>()("UpdaterService", {
  effect: Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const pathSvc = yield* Path.Path
    const config = yield* ConfigService
    const shell = yield* ShellService

    const cachePath = pathSvc.join(config.configDir(), CACHE_FILENAME)

    // -- Cache I/O (all errors swallowed: cache is best-effort) --

    const readCache = (): Effect.Effect<Option.Option<UpdateCache>> =>
      Effect.gen(function* () {
        const exists = yield* fs.exists(cachePath).pipe(Effect.orElseSucceed(() => false))
        if (!exists) return Option.none()
        const raw = yield* fs.readFileString(cachePath).pipe(
          Effect.map(Option.some),
          Effect.orElseSucceed(() => Option.none<string>())
        )
        if (Option.isNone(raw)) return Option.none()
        return yield* Schema.decode(UpdateCacheJson)(raw.value).pipe(
          Effect.map(Option.some),
          Effect.orElseSucceed(() => Option.none<UpdateCache>())
        )
      })

    const writeCache = (cache: UpdateCache): Effect.Effect<void, WriteFileError | EncodeConfigError> =>
      Effect.gen(function* () {
        const json = yield* Schema.encode(UpdateCacheJson)(cache).pipe(
          Effect.mapError((e) => new EncodeConfigError({ detail: String(e) }))
        )
        yield* fs.writeFileString(cachePath, json + "\n").pipe(
          Effect.mapError((e) => new WriteFileError({ path: cachePath, detail: String(e) }))
        )
      })

    const isCacheStale = (cache: UpdateCache): boolean => {
      const t = Date.parse(cache.lastCheckedAt)
      if (Number.isNaN(t)) return true
      return Date.now() - t > STALE_AFTER_MS
    }

    // -- Network --

    const fetchLatestVersion = (): Effect.Effect<string, UpdateCheckError> =>
      Effect.tryPromise({
        try: async () => {
          const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
            headers: { Accept: "application/vnd.github+json" }
          })
          if (!res.ok) throw new Error(`GitHub API responded ${res.status}`)
          const json = (await res.json()) as { tag_name?: string }
          if (!json.tag_name) throw new Error("response missing tag_name")
          return json.tag_name
        },
        catch: (e) => new UpdateCheckError({ detail: String(e) })
      })

    const refreshCache = (): Effect.Effect<void, UpdateCheckError | WriteFileError | EncodeConfigError> =>
      Effect.gen(function* () {
        const latest = yield* fetchLatestVersion()
        yield* writeCache(new UpdateCache({
          lastCheckedAt: new Date().toISOString(),
          latestVersion: latest
        }))
      })

    // -- Post-command hook helpers --

    const isRefreshInvocation = process.argv.slice(1).includes(REFRESH_CMD)

    const notifyIfAvailable = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (VERSION === "dev") return
        if (isRefreshInvocation) return
        const cache = yield* readCache()
        if (Option.isNone(cache)) return
        if (cache.value.latestVersion === VERSION) return
        // Notice goes to stderr so command stdout (used in pipes) stays clean.
        console.error(dim(`ship ${cache.value.latestVersion} is available — run 'ship update'`))
      })

    const spawnBackgroundRefreshIfStale = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (VERSION === "dev") return
        if (isRefreshInvocation) return
        const cache = yield* readCache()
        if (Option.isSome(cache) && !isCacheStale(cache.value)) return
        yield* Effect.try(() => {
          const child = spawn(process.execPath, [REFRESH_CMD], {
            detached: true,
            stdio: "ignore"
          })
          child.unref()
        }).pipe(Effect.ignore)
      })

    // -- ship update --

    const installLatest = (version: string): Effect.Effect<
      void,
      UpdateDownloadError | UpdateInstallError | UnsupportedPlatformError
    > =>
      Effect.gen(function* () {
        if (VERSION === "dev") {
          return yield* new UpdateInstallError({
            detail: "running from source (bun run dev); rebuild with `bun run build` instead of self-updating"
          })
        }

        const platform = process.platform
        const arch = process.arch
        if (platform !== "darwin" || (arch !== "arm64" && arch !== "x64")) {
          return yield* new UnsupportedPlatformError({ platform, arch })
        }

        const asset = assetName(platform, arch)
        const url = `https://github.com/${REPO}/releases/download/${version}/${asset}`

        const target = yield* Effect.tryPromise({
          try: () => realpath(process.execPath),
          catch: (e) => new UpdateInstallError({ detail: `cannot resolve binary path: ${e}` })
        })
        const tempPath = `${target}.new`

        const bytes = yield* Effect.tryPromise({
          try: async () => {
            const res = await fetch(url)
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            return new Uint8Array(await res.arrayBuffer())
          },
          catch: (e) => new UpdateDownloadError({ url, detail: String(e) })
        })

        yield* fs.writeFile(tempPath, bytes).pipe(
          Effect.mapError((e) => new UpdateInstallError({ detail: `write temp: ${e}` }))
        )

        yield* Effect.tryPromise({
          try: () => chmod(tempPath, 0o755),
          catch: (e) => new UpdateInstallError({ detail: `chmod: ${e}` })
        })

        yield* shell.exec("codesign", ["--sign", "-", "--force", tempPath]).pipe(
          Effect.mapError((e) => new UpdateInstallError({ detail: `codesign: ${e.message}` }))
        )

        yield* fs.rename(tempPath, target).pipe(
          Effect.mapError((e) => new UpdateInstallError({ detail: `rename: ${e}` }))
        )

        yield* writeCache(new UpdateCache({
          lastCheckedAt: new Date().toISOString(),
          latestVersion: version
        })).pipe(Effect.ignore)
      })

    return {
      readCache,
      writeCache,
      isCacheStale,
      fetchLatestVersion,
      refreshCache,
      notifyIfAvailable,
      spawnBackgroundRefreshIfStale,
      installLatest
    }
  }),
  dependencies: [ConfigService.Default, ShellService.Default]
}) {}
