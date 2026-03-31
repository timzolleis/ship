import { FileSystem, Path } from "@effect/platform"
import type { PlatformError } from "@effect/platform/Error"
import { Effect } from "effect"
import type { EnvConfig } from "../schema/config.js"

// ---------------------------------------------------------------------------
// .env patching
// ---------------------------------------------------------------------------

export interface EnvPatchContext {
  readonly dbName: string
  readonly proxyDomain: string
  readonly port: number
}

interface PatchResult {
  readonly file: string
  readonly changes: ReadonlyArray<{ key: string; from: string; to: string }>
}

/**
 * Copy .env files from source project to worktree, patching URL values.
 */
export const patchEnvFiles = (
  sourceDir: string,
  targetDir: string,
  envConfig: EnvConfig,
  ctx: EnvPatchContext
): Effect.Effect<ReadonlyArray<PatchResult>, PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const pathSvc = yield* Path.Path
    const results: PatchResult[] = []

    for (const file of envConfig.files) {
      const sourcePath = pathSvc.join(sourceDir, file)
      const targetPath = pathSvc.join(targetDir, file)

      const exists = yield* fs.exists(sourcePath)
      if (!exists) continue

      const content = yield* fs.readFileString(sourcePath)
      const changes: PatchResult["changes"][number][] = []
      const lines: string[] = []

      for (const line of content.split("\n")) {
        const match = line.match(/^([A-Z_]+)=(.+)$/)
        if (!match) {
          lines.push(line)
          continue
        }
        const [, key, rawValue] = match
        if (!key || !rawValue) {
          lines.push(line)
          continue
        }

        const varConfig = envConfig.autoDetected[key]
        if (!varConfig) {
          lines.push(line)
          continue
        }

        const value = rawValue.replace(/^["']|["']$/g, "")
        let newValue = value

        switch (varConfig.type) {
          case "database_url": {
            // Replace the database name in the URL
            newValue = value.replace(/\/([^/]+)$/, `/${ctx.dbName}`)
            break
          }
          case "proxy_url": {
            // Replace the domain with the proxy domain
            newValue = value.replace(/https?:\/\/[^/]+/, `https://${ctx.proxyDomain}`)
            break
          }
          case "dev_url": {
            // Replace with localhost:port + optional path
            const urlPath = varConfig.path ?? ""
            newValue = `http://localhost:${ctx.port}${urlPath}`
            break
          }
          default:
            break
        }

        if (newValue !== value) {
          changes.push({ key, from: value, to: newValue })
        }
        lines.push(`${key}=${newValue}`)
      }

      // Ensure target directory exists
      const targetDirPath = pathSvc.dirname(targetPath)
      yield* fs.makeDirectory(targetDirPath, { recursive: true })
      yield* fs.writeFileString(targetPath, lines.join("\n"))
      results.push({ file, changes })
    }

    return results
  })
