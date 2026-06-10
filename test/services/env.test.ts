import { FileSystem, Path } from "@effect/platform"
import { NodeContext } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Ref, Schema } from "effect"
import type { EnvPatchContext } from "../../src/domain/env-patch.js"
import { EnvConfig } from "../../src/schema/config.js"
import { DbName, HostPort, ProxyDomain } from "../../src/schema/ids.js"
import {
  type EnvCall,
  type PatchResult,
  EnvService,
} from "../../src/services/env.js"

const ctx: EnvPatchContext = {
  dbName: Schema.decodeSync(DbName)("feat_x"),
  proxyDomain: Schema.decodeSync(ProxyDomain)("feat-x.app.test"),
  port: Schema.decodeSync(HostPort)(5174),
}

const envConfig = Schema.decodeUnknownSync(EnvConfig)({
  files: [".env"],
  autoDetected: {
    DATABASE_URL: { type: "database_url" },
  },
})

describe("EnvService.layerMemory contract", () => {
  it.effect("returns the canned results and records the call", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<EnvCall>>([])
      const results: ReadonlyArray<PatchResult> = [
        {
          file: ".env",
          changes: [{ key: "DATABASE_URL", from: "/old", to: "/feat_x" }],
        },
      ]

      const out = yield* Effect.gen(function* () {
        const env = yield* EnvService
        return yield* env.patchEnvFiles("/src", "/target", envConfig, ctx)
      }).pipe(Effect.provide(EnvService.layerMemory({ results, calls })))

      assert.deepStrictEqual(out, results)

      const recorded = yield* Ref.get(calls)
      assert.strictEqual(recorded.length, 1)
      const call = recorded[0]!
      assert.strictEqual(call.sourceDir, "/src")
      assert.strictEqual(call.targetDir, "/target")
      assert.deepStrictEqual(call.ctx, ctx)
      assert.strictEqual(call.env, envConfig)
    })
  )

  it.effect("returns empty results by default", () =>
    Effect.gen(function* () {
      const out = yield* Effect.gen(function* () {
        const env = yield* EnvService
        return yield* env.patchEnvFiles("/src", "/target", envConfig, ctx)
      }).pipe(Effect.provide(EnvService.layerMemory()))

      assert.deepStrictEqual(out, [])
    })
  )
})

describe("EnvService.layer over a real tmpdir FileSystem", () => {
  const run = <A, E>(body: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | EnvService>) =>
    body.pipe(
      Effect.provide(EnvService.layer),
      Effect.provide(NodeContext.layer)
    )

  it.effect("reads source files, writes patched content to target, skips missing sources", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const env = yield* EnvService

        const tmp = yield* fs.makeTempDirectoryScoped()
        const sourceDir = path.join(tmp, "source")
        const targetDir = path.join(tmp, "target")
        yield* fs.makeDirectory(sourceDir, { recursive: true })

        // .env exists in source, .env.local does NOT (missing source skipped)
        yield* fs.writeFileString(
          path.join(sourceDir, ".env"),
          "# comment\nDATABASE_URL=postgres://localhost:5432/old\nPLAIN=keep\n"
        )

        const config = Schema.decodeUnknownSync(EnvConfig)({
          files: [".env", ".env.local"],
          autoDetected: {
            DATABASE_URL: { type: "database_url" },
          },
        })

        const results = yield* env.patchEnvFiles(sourceDir, targetDir, config, ctx)

        // Only the .env file was processed; .env.local was skipped.
        assert.strictEqual(results.length, 1)
        assert.strictEqual(results[0]!.file, ".env")
        assert.deepStrictEqual(results[0]!.changes, [
          { key: "DATABASE_URL", from: "postgres://localhost:5432/old", to: "postgres://localhost:5432/feat_x" },
        ])

        // Target file written with patched content.
        const written = yield* fs.readFileString(path.join(targetDir, ".env"))
        assert.strictEqual(
          written,
          "# comment\nDATABASE_URL=postgres://localhost:5432/feat_x\nPLAIN=keep\n"
        )

        // Missing-source target was never written.
        const localExists = yield* fs.exists(path.join(targetDir, ".env.local"))
        assert.isFalse(localExists)
      }).pipe(Effect.scoped)
    )
  )
})
