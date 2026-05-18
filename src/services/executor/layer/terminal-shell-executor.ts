import { Effect, Layer } from "effect";
import { ShellService } from "../../shell";
import {
  ShellExecutionError,
  ShellExecutor,
} from "../definition/shell-executor";

export const TerminalShellExecutor: Layer.Layer<
  ShellExecutor,
  never,
  ShellService
> = Layer.effect(
  ShellExecutor,
  Effect.gen(function* () {
    const shell = yield* ShellService;

    return ShellExecutor.of({
      executeCommand: Effect.fn("terminalShellExecutor.executeCommand")(
        function* (command, args) {
          yield* Effect.annotateCurrentSpan({
            "shell.command": command,
            "shell.args": args,
          });
          const result = yield* shell.exec(command, args).pipe(
            Effect.mapError(
              (error) =>
                new ShellExecutionError({
                  message: error.stderr,
                  command: error.command,
                }),
            ),
          );
          return { stdout: result.stdout, stderr: result.stderr };
        },
      ),
    });
  }),
);
