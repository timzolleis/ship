import { Command as PlatformCommand, CommandExecutor } from "@effect/platform"
import type { PlatformError } from "@effect/platform/Error"
import { Context, Effect, Layer } from "effect"

// ---------------------------------------------------------------------------
// ShellService
// ---------------------------------------------------------------------------

export interface ExecResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

export class ShellService extends Context.Tag("ShellService")<
  ShellService,
  {
    readonly exec: (command: string, args: ReadonlyArray<string>) => Effect.Effect<ExecResult, PlatformError>
    readonly execInteractive: (command: string, args: ReadonlyArray<string>) => Effect.Effect<void, PlatformError>
    readonly execInDir: (cwd: string, command: string, envOverrides?: Record<string, string>) => Effect.Effect<void, PlatformError>
  }
>() {}

export const ShellServiceLive = Layer.effect(
  ShellService,
  Effect.gen(function* () {
    const executor = yield* CommandExecutor.CommandExecutor

    const provide = <A, E>(effect: Effect.Effect<A, E, CommandExecutor.CommandExecutor>): Effect.Effect<A, E> =>
      Effect.provideService(effect, CommandExecutor.CommandExecutor, executor)

    return ShellService.of({
      exec: (command, args) => {
        const proc = PlatformCommand.make(command, ...args)
        return provide(
          PlatformCommand.string(proc).pipe(
            Effect.map((stdout): ExecResult => ({ stdout, stderr: "", exitCode: 0 }))
          )
        )
      },

      execInteractive: (command, args) => {
        const proc = PlatformCommand.make(command, ...args).pipe(
          PlatformCommand.stdin("inherit"),
          PlatformCommand.stdout("inherit"),
          PlatformCommand.stderr("inherit")
        )
        return provide(PlatformCommand.exitCode(proc).pipe(Effect.asVoid))
      },

      execInDir: (cwd, command, envOverrides) => {
        let proc = PlatformCommand.make("sh", "-c", command).pipe(
          PlatformCommand.workingDirectory(cwd),
          PlatformCommand.stdout("inherit"),
          PlatformCommand.stderr("inherit")
        )
        if (envOverrides) {
          proc = PlatformCommand.env(proc, envOverrides)
        }
        return provide(PlatformCommand.exitCode(proc).pipe(Effect.asVoid))
      }
    })
  })
)
