import { Command as PlatformCommand, CommandExecutor } from "@effect/platform"
import { Context, Effect, Layer, Ref, Stream } from "effect"
import { ShellExecError } from "../errors.js"

// ---------------------------------------------------------------------------
// ShellService
// ---------------------------------------------------------------------------

// Lifecycle commands (install/generate/migrate/seed) run without a controlling
// prompt loop — CI=true makes tools like pnpm 11 (confirmModulesPurge) skip
// interactive confirmations instead of hanging or erroring.
export const nonInteractiveEnv = { CI: "true" }

export interface ExecResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

export interface ShellCall {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd?: string
}

export interface ScopedShell {
  readonly exec: (command: string, args: ReadonlyArray<string>) => Effect.Effect<ExecResult, ShellExecError>
}

export interface ShellShape {
  readonly exec: (command: string, args: ReadonlyArray<string>) => Effect.Effect<ExecResult, ShellExecError>
  readonly execInteractive: (command: string, args: ReadonlyArray<string>) => Effect.Effect<void, ShellExecError>
  readonly execInDir: (
    cwd: string,
    command: string,
    env?: Record<string, string>
  ) => Effect.Effect<void, ShellExecError>
  readonly inDir: (cwd: string) => ScopedShell
}

const collectBytes = (stream: Stream.Stream<Uint8Array>): Effect.Effect<Uint8Array> =>
  Stream.runCollect(stream).pipe(
    Effect.map((chunks) => {
      let len = 0
      for (const c of chunks) len += c.length
      const out = new Uint8Array(len)
      let off = 0
      for (const c of chunks) { out.set(c, off); off += c.length }
      return out
    })
  )

export class ShellService extends Context.Tag("ship/ShellService")<ShellService, ShellShape>() {
  static layer: Layer.Layer<ShellService, never, CommandExecutor.CommandExecutor> = Layer.effect(
    ShellService,
    Effect.gen(function* () {
      const executor = yield* CommandExecutor.CommandExecutor

      const provide = <A, E>(effect: Effect.Effect<A, E, CommandExecutor.CommandExecutor>): Effect.Effect<A, E> =>
        Effect.provideService(effect, CommandExecutor.CommandExecutor, executor)

      const runProc = (proc: PlatformCommand.Command, label: string): Effect.Effect<ExecResult, ShellExecError> =>
        provide(
          Effect.scoped(
            Effect.gen(function* () {
              const process = yield* PlatformCommand.start(proc)
              const decoder = new TextDecoder()
              const stdout = yield* collectBytes(process.stdout as any)
              const stderr = yield* collectBytes(process.stderr as any)
              const code = yield* process.exitCode
              const stdoutStr = decoder.decode(stdout)
              const stderrStr = decoder.decode(stderr)
              if (code !== 0) {
                return yield* new ShellExecError({
                  command: label,
                  stderr: stderrStr.trim() || `Process exited with code ${code}`
                })
              }
              return { stdout: stdoutStr, stderr: stderrStr, exitCode: code } as ExecResult
            })
          )
        ).pipe(Effect.mapError((e) =>
          e instanceof ShellExecError ? e : new ShellExecError({ command: label, stderr: String(e) })
        ))

      const exec: ShellShape["exec"] = Effect.fn("ShellService.exec")(function* (command, args) {
        return yield* runProc(PlatformCommand.make(command, ...args), `${command} ${args.join(" ")}`)
      })

      const execInteractive: ShellShape["execInteractive"] = Effect.fn("ShellService.execInteractive")(
        function* (command, args) {
          const proc = PlatformCommand.make(command, ...args).pipe(
            PlatformCommand.stdin("inherit"),
            PlatformCommand.stdout("inherit"),
            PlatformCommand.stderr("inherit")
          )
          yield* provide(PlatformCommand.exitCode(proc).pipe(
            Effect.mapError((e) => new ShellExecError({
              command: `${command} ${args.join(" ")}`,
              stderr: String(e)
            }))
          ))
        }
      )

      const execInDir: ShellShape["execInDir"] = Effect.fn("ShellService.execInDir")(
        function* (cwd, command, envOverrides) {
          let proc = PlatformCommand.make("sh", "-c", command).pipe(
            PlatformCommand.workingDirectory(cwd),
            PlatformCommand.stdout("inherit"),
            PlatformCommand.stderr("inherit")
          )
          if (envOverrides) {
            proc = PlatformCommand.env(proc, envOverrides)
          }
          yield* provide(PlatformCommand.exitCode(proc).pipe(
            Effect.mapError((e) => new ShellExecError({ command, stderr: String(e) }))
          ))
        }
      )

      const inDir = (cwd: string): ScopedShell => ({
        exec: Effect.fn("ShellService.inDir.exec")(function* (command: string, args: ReadonlyArray<string>) {
          return yield* runProc(
            PlatformCommand.make(command, ...args).pipe(PlatformCommand.workingDirectory(cwd)),
            `${command} ${args.join(" ")}`
          )
        })
      })

      return { exec, execInteractive, execInDir, inDir }
    })
  )

  static layerMemory: (opts?: {
    stub?: (call: ShellCall) => ExecResult | ShellExecError
    calls?: Ref.Ref<ReadonlyArray<ShellCall>>
  }) => Layer.Layer<ShellService> = (opts) =>
    Layer.sync(ShellService, () => {
      const stub = opts?.stub ?? (() => ({ stdout: "", stderr: "", exitCode: 0 }))

      const record = (call: ShellCall): Effect.Effect<void> =>
        opts?.calls ? Ref.update(opts.calls, (xs) => [...xs, call]) : Effect.void

      const dispatch = (call: ShellCall): Effect.Effect<ExecResult, ShellExecError> =>
        record(call).pipe(
          Effect.zipRight(
            Effect.suspend(() => {
              const out = stub(call)
              return out instanceof ShellExecError ? Effect.fail(out) : Effect.succeed(out)
            })
          )
        )

      return {
        exec: (command, args) => dispatch({ command, args }),
        execInteractive: (command, args) => dispatch({ command, args }).pipe(Effect.asVoid),
        execInDir: (cwd, command) => dispatch({ command, args: [], cwd }).pipe(Effect.asVoid),
        inDir: (cwd) => ({
          exec: (command, args) => dispatch({ command, args, cwd }),
        }),
      }
    })
}
