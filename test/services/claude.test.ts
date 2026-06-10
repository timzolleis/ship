import { assert, describe, it } from "@effect/vitest"
import { Effect, Ref } from "effect"
import { ClaudeService } from "../../src/services/claude.js"

describe("ClaudeService.layerMemory contract", () => {
  it.effect("removeProjectConvo returns true", () =>
    Effect.gen(function* () {
      const claude = yield* ClaudeService
      const removed = yield* claude.removeProjectConvo("/Users/tim/IdeaProjects/ship")
      assert.isTrue(removed)
    }).pipe(Effect.provide(ClaudeService.layerMemory()))
  )

  it.effect("records removed paths in the supplied Ref", () =>
    Effect.gen(function* () {
      const removed = yield* Ref.make<ReadonlyArray<string>>([])
      yield* Effect.gen(function* () {
        const claude = yield* ClaudeService
        yield* claude.removeProjectConvo("/Users/tim/IdeaProjects/ship")
        yield* claude.removeProjectConvo("/Users/tim/other")
      }).pipe(Effect.provide(ClaudeService.layerMemory(removed)))
      const seen = yield* Ref.get(removed)
      assert.deepStrictEqual(seen, [
        "/Users/tim/IdeaProjects/ship",
        "/Users/tim/other",
      ])
    })
  )

  it.effect("without a Ref still succeeds and returns true", () =>
    Effect.gen(function* () {
      const claude = yield* ClaudeService
      assert.isTrue(yield* claude.removeProjectConvo("/any/path"))
    }).pipe(Effect.provide(ClaudeService.layerMemory()))
  )
})
