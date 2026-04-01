import { Command as PlatformCommand, CommandExecutor } from "@effect/platform"
import { Effect, Stream } from "effect"
import { ShellExecError } from "../errors.js"

// ---------------------------------------------------------------------------
// ShellService
// ---------------------------------------------------------------------------

export interface ExecResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

export interface ScopedShell {
  readonly exec: (command: string, args: ReadonlyArray<string>) => Effect.Effect<ExecResult, ShellExecError>
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

export class ShellService extends Effect.Service<ShellService>()("ShellService", {
  effect: Effect.gen(function* () {
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

    const exec: (command: string, args: ReadonlyArray<string>) => Effect.Effect<ExecResult, ShellExecError> =
      Effect.fn("ShellService.exec")(function* (command, args) {
        return yield* runProc(PlatformCommand.make(command, ...args), `${command} ${args.join(" ")}`)
      })

    const execInteractive: (command: string, args: ReadonlyArray<string>) => Effect.Effect<void, ShellExecError> =
      Effect.fn("ShellService.execInteractive")(function* (command, args) {
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
      })

    const execInDir: (cwd: string, command: string, envOverrides?: Record<string, string>) => Effect.Effect<void, ShellExecError> =
      Effect.fn("ShellService.execInDir")(function* (cwd, command, envOverrides) {
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
      })

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
}) {}
