import { FileSystem, Path } from "@effect/platform"
import { Context, Effect, Layer, Ref } from "effect"
import { type EnvPatchContext, patchEnvContent } from "../domain/env-patch.js"
import { CreateDirectoryError, ReadFileError, WriteFileError } from "../errors.js"
import type { EnvConfig } from "../schema/config.js"

// ---------------------------------------------------------------------------
// EnvService — thin FS shell over domain/env-patch.
//
// patchEnvFiles iterates the configured files, reads each source, delegates ALL
// line transformation to `patchEnvContent`, and writes the patched content to
// the target. Missing source files are skipped. No transform logic lives here.
// ---------------------------------------------------------------------------

export interface PatchResult {
  readonly file: string
  readonly changes: ReadonlyArray<{ key: string; from: string; to: string }>
}

export interface EnvCall {
  readonly sourceDir: string
  readonly targetDir: string
  readonly env: EnvConfig
  readonly ctx: EnvPatchContext
}

type FsError = CreateDirectoryError | ReadFileError | WriteFileError

export interface EnvShape {
  readonly patchEnvFiles: (
    sourceDir: string,
    targetDir: string,
    env: EnvConfig,
    ctx: EnvPatchContext
  ) => Effect.Effect<ReadonlyArray<PatchResult>, FsError>
}

export class EnvService extends Context.Tag("ship/EnvService")<EnvService, EnvShape>() {
  static layer: Layer.Layer<EnvService, never, FileSystem.FileSystem | Path.Path> = Layer.effect(
    EnvService,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const pathSvc = yield* Path.Path

      const patchEnvFiles: EnvShape["patchEnvFiles"] = Effect.fn("EnvService.patchEnvFiles")(
        function* (sourceDir, targetDir, env, ctx) {
          const results: PatchResult[] = []

          for (const file of env.files) {
            const sourcePath = pathSvc.join(sourceDir, file)
            const targetPath = pathSvc.join(targetDir, file)

            const exists = yield* fs.exists(sourcePath).pipe(
              Effect.mapError((e) => new ReadFileError({ path: sourcePath, detail: String(e) }))
            )
            if (!exists) continue

            const content = yield* fs.readFileString(sourcePath).pipe(
              Effect.mapError((e) => new ReadFileError({ path: sourcePath, detail: String(e) }))
            )

            const patched = patchEnvContent(content, env, ctx)

            const targetDirPath = pathSvc.dirname(targetPath)
            yield* fs.makeDirectory(targetDirPath, { recursive: true }).pipe(
              Effect.mapError((e) => new CreateDirectoryError({ path: targetDirPath, detail: String(e) }))
            )
            yield* fs.writeFileString(targetPath, patched.content).pipe(
              Effect.mapError((e) => new WriteFileError({ path: targetPath, detail: String(e) }))
            )
            results.push({ file, changes: patched.changes })
          }

          return results
        }
      )

      return { patchEnvFiles }
    })
  )

  static layerMemory: (opts?: {
    results?: ReadonlyArray<PatchResult>
    calls?: Ref.Ref<ReadonlyArray<EnvCall>>
  }) => Layer.Layer<EnvService> = (opts) =>
    Layer.sync(EnvService, () => {
      const results = opts?.results ?? []

      const record = (call: EnvCall): Effect.Effect<void> =>
        opts?.calls ? Ref.update(opts.calls, (xs) => [...xs, call]) : Effect.void

      return {
        patchEnvFiles: (sourceDir, targetDir, env, ctx) =>
          record({ sourceDir, targetDir, env, ctx }).pipe(Effect.as(results)),
      }
    })
}
