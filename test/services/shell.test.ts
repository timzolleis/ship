import { assert, describe, it } from "@effect/vitest"
import { Effect, Ref } from "effect"
import { ShellExecError } from "../../src/errors.js"
import {
  type ExecResult,
  type ShellCall,
  ShellService,
} from "../../src/services/shell.js"

describe("ShellService.layerMemory", () => {
  it.effect("exec returns the default stub result and records the call", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<ShellCall>>([])
      const program = Effect.gen(function* () {
        const shell = yield* ShellService
        return yield* shell.exec("git", ["status", "--short"])
      }).pipe(Effect.provide(ShellService.layerMemory({ calls })))

      const result = yield* program
      assert.deepStrictEqual(result, { stdout: "", stderr: "", exitCode: 0 })

      const recorded = yield* Ref.get(calls)
      assert.deepStrictEqual(recorded, [
        { command: "git", args: ["status", "--short"] },
      ])
    })
  )

  it.effect("exec returns a custom stub result", () =>
    Effect.gen(function* () {
      const stub = (): ExecResult => ({
        stdout: "hello",
        stderr: "warn",
        exitCode: 0,
      })
      const program = Effect.gen(function* () {
        const shell = yield* ShellService
        return yield* shell.exec("echo", ["hi"])
      }).pipe(Effect.provide(ShellService.layerMemory({ stub })))

      const result = yield* program
      assert.deepStrictEqual(result, {
        stdout: "hello",
        stderr: "warn",
        exitCode: 0,
      })
    })
  )

  it.effect("a ShellExecError stub result fails the effect", () =>
    Effect.gen(function* () {
      const stub = (call: ShellCall) =>
        new ShellExecError({ command: call.command, stderr: "boom" })
      const program = Effect.gen(function* () {
        const shell = yield* ShellService
        return yield* shell.exec("false", [])
      }).pipe(Effect.provide(ShellService.layerMemory({ stub })))

      const exit = yield* Effect.exit(program)
      assert.isTrue(exit._tag === "Failure")
      const error = yield* Effect.flip(program)
      assert.strictEqual(error._tag, "ShellExecError")
      assert.strictEqual(error.stderr, "boom")
    })
  )

  it.effect("execInDir records the cwd on the recorded call", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<ShellCall>>([])
      const program = Effect.gen(function* () {
        const shell = yield* ShellService
        yield* shell.execInDir("/tmp/work", "pnpm install")
      }).pipe(Effect.provide(ShellService.layerMemory({ calls })))

      yield* program
      const recorded = yield* Ref.get(calls)
      assert.strictEqual(recorded.length, 1)
      const call = recorded[0]!
      assert.strictEqual(call.cwd, "/tmp/work")
    })
  )

  it.effect("execInteractive records the call", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<ShellCall>>([])
      const program = Effect.gen(function* () {
        const shell = yield* ShellService
        yield* shell.execInteractive("psql", ["-U", "app", "app_dev"])
      }).pipe(Effect.provide(ShellService.layerMemory({ calls })))

      yield* program
      const recorded = yield* Ref.get(calls)
      assert.deepStrictEqual(recorded, [
        { command: "psql", args: ["-U", "app", "app_dev"] },
      ])
    })
  )

  it.effect("inDir records the cwd on the recorded call", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<ShellCall>>([])
      const program = Effect.gen(function* () {
        const shell = yield* ShellService
        return yield* shell.inDir("/repo").exec("git", ["rev-parse", "HEAD"])
      }).pipe(Effect.provide(ShellService.layerMemory({ calls })))

      const result = yield* program
      assert.deepStrictEqual(result, { stdout: "", stderr: "", exitCode: 0 })
      const recorded = yield* Ref.get(calls)
      assert.deepStrictEqual(recorded, [
        { command: "git", args: ["rev-parse", "HEAD"], cwd: "/repo" },
      ])
    })
  )
})
