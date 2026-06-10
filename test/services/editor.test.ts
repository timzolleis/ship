import { assert, describe, it } from "@effect/vitest"
import { Effect, Ref } from "effect"
import { EditorService } from "../../src/services/editor.js"

describe("EditorService.layerMemory", () => {
  it.effect("open records the opened path", () =>
    Effect.gen(function* () {
      const opened = yield* Ref.make<ReadonlyArray<string>>([])
      const program = Effect.gen(function* () {
        const editor = yield* EditorService
        yield* editor.open("/repo/feat-x")
      }).pipe(Effect.provide(EditorService.layerMemory(opened)))

      yield* program
      const recorded = yield* Ref.get(opened)
      assert.deepStrictEqual(recorded, ["/repo/feat-x"])
    })
  )

  it.effect("open records each path in order", () =>
    Effect.gen(function* () {
      const opened = yield* Ref.make<ReadonlyArray<string>>([])
      const program = Effect.gen(function* () {
        const editor = yield* EditorService
        yield* editor.open("/a")
        yield* editor.open("/b")
      }).pipe(Effect.provide(EditorService.layerMemory(opened)))

      yield* program
      const recorded = yield* Ref.get(opened)
      assert.deepStrictEqual(recorded, ["/a", "/b"])
    })
  )

  it.effect("open succeeds without a Ref provided", () =>
    Effect.gen(function* () {
      const program = Effect.gen(function* () {
        const editor = yield* EditorService
        yield* editor.open("/x")
      }).pipe(Effect.provide(EditorService.layerMemory()))

      yield* program
    })
  )
})
