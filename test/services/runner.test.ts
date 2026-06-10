import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Ref, Schema } from "effect"
import { ExecutionRuntime } from "../../src/schema/config.js"
import { ContainerName } from "../../src/schema/ids.js"
import { CommandRunner } from "../../src/services/runner.js"
import { type ShellCall, ShellService } from "../../src/services/shell.js"

const local: ExecutionRuntime = { _tag: "local" }
const docker: ExecutionRuntime = {
  _tag: "docker",
  container: Schema.decodeSync(ContainerName)("pg17"),
}

const withRunner = <A, E>(
  body: (
    runner: CommandRunner["Type"],
    calls: Ref.Ref<ReadonlyArray<ShellCall>>
  ) => Effect.Effect<A, E>
) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<ShellCall>>([])
    const program = Effect.gen(function* () {
      const runner = yield* CommandRunner
      return yield* body(runner, calls)
    }).pipe(
      Effect.provide(
        CommandRunner.layer.pipe(
          Layer.provideMerge(ShellService.layerMemory({ calls }))
        )
      )
    )
    return yield* program
  })

describe("CommandRunner.layer over ShellService.layerMemory", () => {
  it.effect("local run → shell.exec passthrough", () =>
    withRunner((runner, calls) =>
      Effect.gen(function* () {
        yield* runner.run(local, "createdb", ["-U", "app", "app_dev"])
        const recorded = yield* Ref.get(calls)
        assert.deepStrictEqual(recorded, [
          { command: "createdb", args: ["-U", "app", "app_dev"] },
        ])
      })
    )
  )

  it.effect("docker run → docker exec <container> prefix", () =>
    withRunner((runner, calls) =>
      Effect.gen(function* () {
        yield* runner.run(docker, "createdb", ["-U", "app", "app_dev"])
        const recorded = yield* Ref.get(calls)
        assert.deepStrictEqual(recorded, [
          {
            command: "docker",
            args: ["exec", "pg17", "createdb", "-U", "app", "app_dev"],
          },
        ])
      })
    )
  )

  it.effect("local runScript → sh -c", () =>
    withRunner((runner, calls) =>
      Effect.gen(function* () {
        yield* runner.runScript(local, "pg_dump app | psql app2")
        const recorded = yield* Ref.get(calls)
        assert.deepStrictEqual(recorded, [
          { command: "sh", args: ["-c", "pg_dump app | psql app2"] },
        ])
      })
    )
  )

  it.effect("docker runScript → docker exec <container> bash -c", () =>
    withRunner((runner, calls) =>
      Effect.gen(function* () {
        yield* runner.runScript(docker, "pg_dump app | psql app2")
        const recorded = yield* Ref.get(calls)
        assert.deepStrictEqual(recorded, [
          {
            command: "docker",
            args: ["exec", "pg17", "bash", "-c", "pg_dump app | psql app2"],
          },
        ])
      })
    )
  )

  it.effect("local runInteractive → shell.exec passthrough (no prefix)", () =>
    withRunner((runner, calls) =>
      Effect.gen(function* () {
        yield* runner.runInteractive(local, "psql", ["-U", "app", "app_dev"])
        const recorded = yield* Ref.get(calls)
        assert.deepStrictEqual(recorded, [
          { command: "psql", args: ["-U", "app", "app_dev"] },
        ])
      })
    )
  )

  it.effect("docker runInteractive → docker exec -it <container> prefix", () =>
    withRunner((runner, calls) =>
      Effect.gen(function* () {
        yield* runner.runInteractive(docker, "psql", ["-U", "app", "app_dev"])
        const recorded = yield* Ref.get(calls)
        assert.deepStrictEqual(recorded, [
          {
            command: "docker",
            args: ["exec", "-it", "pg17", "psql", "-U", "app", "app_dev"],
          },
        ])
      })
    )
  )
})
