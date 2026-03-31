import { Command as PlatformCommand, CommandExecutor } from "@effect/platform"
import type { PlatformError } from "@effect/platform/Error"
import { Effect } from "effect"

// ---------------------------------------------------------------------------
// ShellService — functions for child process execution
// ---------------------------------------------------------------------------

export interface ExecResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

/** Run a command and capture stdout. Fails on non-zero exit. */
export const exec = (
  command: string,
  args: ReadonlyArray<string>
): Effect.Effect<ExecResult, PlatformError, CommandExecutor.CommandExecutor> => {
  const proc = PlatformCommand.make(command, ...args)
  return PlatformCommand.string(proc).pipe(
    Effect.map((stdout) => ({ stdout, stderr: "", exitCode: 0 }) as ExecResult)
  )
}

/** Run a command that inherits stdio (interactive). */
export const execInteractive = (
  command: string,
  args: ReadonlyArray<string>
): Effect.Effect<void, PlatformError, CommandExecutor.CommandExecutor> => {
  const proc = PlatformCommand.make(command, ...args).pipe(
    PlatformCommand.stdin("inherit"),
    PlatformCommand.stdout("inherit"),
    PlatformCommand.stderr("inherit")
  )
  return PlatformCommand.exitCode(proc).pipe(Effect.asVoid)
}

/** Run a shell command string in a specific directory, inheriting stdio. */
export const execInDir = (
  cwd: string,
  command: string,
  envOverrides?: Record<string, string>
): Effect.Effect<void, PlatformError, CommandExecutor.CommandExecutor> => {
  let proc = PlatformCommand.make("sh", "-c", command).pipe(
    PlatformCommand.workingDirectory(cwd),
    PlatformCommand.stdout("inherit"),
    PlatformCommand.stderr("inherit")
  )
  if (envOverrides) {
    proc = PlatformCommand.env(proc, envOverrides)
  }
  return PlatformCommand.exitCode(proc).pipe(Effect.asVoid)
}
