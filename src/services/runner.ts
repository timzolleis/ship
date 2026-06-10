import { Context, Effect, Layer, Ref } from "effect"
import { ShellExecError } from "../errors.js"
import type { ExecutionRuntime } from "../schema/config.js"
import { type ExecResult, ShellService } from "./shell.js"

// ---------------------------------------------------------------------------
// CommandRunner — resolves an ExecutionRuntime (per-call data, D1) onto the
// ShellService. local → passthrough; docker → `docker exec <container> ...`.
// ---------------------------------------------------------------------------

export interface RunnerCall {
  readonly runtime: ExecutionRuntime
  readonly kind: "run" | "runScript" | "runInteractive"
  readonly command: string
  readonly args: ReadonlyArray<string>
}

export interface CommandRunnerShape {
  readonly run: (
    rt: ExecutionRuntime,
    command: string,
    args: ReadonlyArray<string>
  ) => Effect.Effect<ExecResult, ShellExecError>
  readonly runScript: (
    rt: ExecutionRuntime,
    script: string
  ) => Effect.Effect<ExecResult, ShellExecError>
  readonly runInteractive: (
    rt: ExecutionRuntime,
    command: string,
    args: ReadonlyArray<string>
  ) => Effect.Effect<void, ShellExecError>
}

export class CommandRunner extends Context.Tag("ship/CommandRunner")<CommandRunner, CommandRunnerShape>() {
  static layer: Layer.Layer<CommandRunner, never, ShellService> = Layer.effect(
    CommandRunner,
    Effect.gen(function* () {
      const shell = yield* ShellService

      const run: CommandRunnerShape["run"] = (rt, command, args) =>
        rt._tag === "docker"
          ? shell.exec("docker", ["exec", rt.container, command, ...args])
          : shell.exec(command, args)

      const runScript: CommandRunnerShape["runScript"] = (rt, script) =>
        rt._tag === "docker"
          ? shell.exec("docker", ["exec", rt.container, "bash", "-c", script])
          : shell.exec("sh", ["-c", script])

      const runInteractive: CommandRunnerShape["runInteractive"] = (rt, command, args) =>
        rt._tag === "docker"
          ? shell.execInteractive("docker", ["exec", "-it", rt.container, command, ...args])
          : shell.execInteractive(command, args)

      return { run, runScript, runInteractive }
    })
  )

  static layerMemory: (opts?: {
    stub?: (call: RunnerCall) => ExecResult | ShellExecError
    calls?: Ref.Ref<ReadonlyArray<RunnerCall>>
  }) => Layer.Layer<CommandRunner> = (opts) =>
    Layer.sync(CommandRunner, () => {
      const stub = opts?.stub ?? (() => ({ stdout: "", stderr: "", exitCode: 0 }))

      const record = (call: RunnerCall): Effect.Effect<void> =>
        opts?.calls ? Ref.update(opts.calls, (xs) => [...xs, call]) : Effect.void

      const dispatch = (call: RunnerCall): Effect.Effect<ExecResult, ShellExecError> =>
        record(call).pipe(
          Effect.zipRight(
            Effect.suspend(() => {
              const out = stub(call)
              return out instanceof ShellExecError ? Effect.fail(out) : Effect.succeed(out)
            })
          )
        )

      return {
        run: (runtime, command, args) => dispatch({ runtime, kind: "run", command, args }),
        runScript: (runtime, script) =>
          dispatch({ runtime, kind: "runScript", command: script, args: [] }),
        runInteractive: (runtime, command, args) =>
          dispatch({ runtime, kind: "runInteractive", command, args }).pipe(Effect.asVoid),
      }
    })
}
