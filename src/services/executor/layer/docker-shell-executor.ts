import { Config, ConfigError, Effect, Layer } from "effect";
import { ShellService } from "../../shell";
import {
  ShellExecutionError,
  ShellExecutor,
} from "../definition/shell-executor";

export const DockerShellExecutor: Layer.Layer<
  ShellExecutor,
  ConfigError.ConfigError,
  ShellService
> = Layer.effect(
  ShellExecutor,
  Effect.gen(function* () {
    const shell = yield* ShellService;
    const container = yield* Config.string("SHIP_DOCKER_CONTAINER");

    return ShellExecutor.of({
      executeCommand: Effect.fn("dockerShellExecutor.executeCommand")(
        function* (command, args) {
          yield* Effect.annotateCurrentSpan({
            "docker.container": container,
            "shell.command": command,
            "shell.args": args,
          });
          const result = yield* shell
            .exec("docker", ["exec", container, command, ...args])
            .pipe(
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
