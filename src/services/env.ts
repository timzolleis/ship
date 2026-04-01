import { FileSystem, Path } from "@effect/platform"
import { Effect } from "effect"
import type { EnvConfig } from "../schema/config.js"
import { CreateDirectoryError, ReadFileError, WriteFileError } from "../errors.js"

// ---------------------------------------------------------------------------
// EnvService
// ---------------------------------------------------------------------------

export interface EnvPatchContext {
  readonly dbName: string
  readonly proxyDomain: string
  readonly port: number
}

export interface PatchResult {
  readonly file: string
  readonly changes: ReadonlyArray<{ key: string; from: string; to: string }>
}

type EnvError = CreateDirectoryError | ReadFileError | WriteFileError

export class EnvService extends Effect.Service<EnvService>()("EnvService", {
  effect: Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const pathSvc = yield* Path.Path

    const patchEnvFiles: (
      sourceDir: string,
      targetDir: string,
      envConfig: EnvConfig,
      ctx: EnvPatchContext
    ) => Effect.Effect<ReadonlyArray<PatchResult>, EnvError> =
      Effect.fn("EnvService.patchEnvFiles")(function* (sourceDir, targetDir, envConfig, ctx) {
        const results: PatchResult[] = []

        for (const file of envConfig.files) {
          const sourcePath = pathSvc.join(sourceDir, file)
          const targetPath = pathSvc.join(targetDir, file)

          const exists = yield* fs.exists(sourcePath).pipe(
            Effect.mapError((e) => new ReadFileError({ path: sourcePath, detail: String(e) }))
          )
          if (!exists) continue

          const content = yield* fs.readFileString(sourcePath).pipe(
            Effect.mapError((e) => new ReadFileError({ path: sourcePath, detail: String(e) }))
          )
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
                newValue = value.replace(/\/([^/]+)$/, `/${ctx.dbName}`)
                break
              }
              case "proxy_url": {
                newValue = value.replace(/https?:\/\/[^/]+/, `https://${ctx.proxyDomain}`)
                break
              }
              case "dev_url": {
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

          const targetDirPath = pathSvc.dirname(targetPath)
          yield* fs.makeDirectory(targetDirPath, { recursive: true }).pipe(
            Effect.mapError((e) => new CreateDirectoryError({ path: targetDirPath, detail: String(e) }))
          )
          yield* fs.writeFileString(targetPath, lines.join("\n")).pipe(
            Effect.mapError((e) => new WriteFileError({ path: targetPath, detail: String(e) }))
          )
          results.push({ file, changes })
        }

        return results
      })

    return { patchEnvFiles }
  })
}) {}
