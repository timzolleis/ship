import { it } from "@effect/vitest"
import { assert } from "@effect/vitest"
import { Effect } from "effect"

it.effect("the @effect/vitest harness runs a trivial Effect", () =>
  Effect.gen(function* () {
    const value = yield* Effect.succeed(42)
    assert.strictEqual(value, 42)
  }),
)
