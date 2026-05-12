import { Context, Data, Effect } from "effect";

export class ShellExecutionError extends Data.TaggedClass(
  "ShellExecutionError",
)<{
  message: string;
  command: string;
}> {}

export interface ShellExecutionResult {
  stdout: string;
  stderr: string;
}

export interface ShellExecutorShape {
  executeCommand: (
    command: string,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<ShellExecutionResult, ShellExecutionError>;
}

export class ShellExecutor extends Context.Tag(
  "ship/services/executor/definition/shell-executor/ShellExecutor",
)<ShellExecutor, ShellExecutorShape>() {}
