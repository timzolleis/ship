import { Effect, Layer } from "effect";
import { ShellExecutor } from "../../executor/definition/shell-executor";
import {
  DatabaseError,
  DatabaseService,
} from "../definition/database-service";

export const PostgresDatabaseService: Layer.Layer<DatabaseService, never, ShellExecutor> =
  Layer.effect(
    DatabaseService,
    Effect.gen(function* () {
      const shellExecutor = yield* ShellExecutor;

      const toDatabaseError = (error: { message: string }) =>
        new DatabaseError({ message: error.message });

      return DatabaseService.of({
        createDatabase: Effect.fn("postgresDatabaseService.createDatabase")(
          function* ({ database, user }) {
            yield* Effect.annotateCurrentSpan({
              "database.user": user,
              "database.name": database,
            });
            yield* shellExecutor
              .executeCommand("createdb", ["-U", user, database])
              .pipe(Effect.mapError(toDatabaseError));
          },
        ),

        removeDatabase: Effect.fn("postgresDatabaseService.removeDatabase")(
          function* ({ database, user }) {
            yield* Effect.annotateCurrentSpan({
              "database.user": user,
              "database.name": database,
            });
            yield* shellExecutor
              .executeCommand("dropdb", ["--if-exists", "-U", user, database])
              .pipe(Effect.mapError(toDatabaseError));
          },
        ),

        cloneDatabase: Effect.fn("postgresDatabaseService.cloneDatabase")(
          function* ({ database, sourceDatabase, user }) {
            yield* Effect.annotateCurrentSpan({
              "database.user": user,
              "database.name": database,
              "database.source": sourceDatabase,
            });
            yield* shellExecutor
              .executeCommand("createdb", ["-U", user, database])
              .pipe(Effect.mapError(toDatabaseError));
            yield* shellExecutor
              .executeCommand("bash", [
                "-c",
                `pg_dump -U ${user} ${sourceDatabase} | psql -U ${user} ${database}`,
              ])
              .pipe(Effect.mapError(toDatabaseError));
          },
        ),

        databaseExists: Effect.fn("postgresDatabaseService.databaseExists")(
          function* ({ database, user }) {
            yield* Effect.annotateCurrentSpan({
              "database.user": user,
              "database.name": database,
            });
            return yield* shellExecutor
              .executeCommand("psql", ["-U", user, "-lqt"])
              .pipe(
                Effect.map((result) =>
                  result.stdout
                    .split("\n")
                    .some((line) => line.trim().startsWith(database)),
                ),
                Effect.catchAll(() => Effect.succeed(false)),
              );
          },
        ),

        executeQuery: Effect.fn("postgresDatabaseService.executeQuery")(
          function* ({ database, user, query }) {
            yield* Effect.annotateCurrentSpan({
              "database.user": user,
              "database.name": database,
            });
            const result = yield* shellExecutor
              .executeCommand("psql", ["-U", user, database, "-c", query])
              .pipe(Effect.mapError(toDatabaseError));
            return result.stdout;
          },
        ),
      });
    }),
  );
