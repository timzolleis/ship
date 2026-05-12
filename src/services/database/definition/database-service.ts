import { Context, Data, Effect } from "effect";

export class DatabaseError extends Data.TaggedError("DatabaseError")<{
  message: string;
}> {}

interface DatabaseOperationArgs {
  user: string;
  database: string;
}

export interface DatabaseServiceShape {
  createDatabase: (
    args: DatabaseOperationArgs,
  ) => Effect.Effect<void, DatabaseError>;
  removeDatabase: (
    args: DatabaseOperationArgs,
  ) => Effect.Effect<void, DatabaseError>;
  cloneDatabase: (
    args: DatabaseOperationArgs & { sourceDatabase: string },
  ) => Effect.Effect<void, DatabaseError>;
  databaseExists: (
    args: DatabaseOperationArgs,
  ) => Effect.Effect<boolean, DatabaseError>;
  executeQuery: (
    args: DatabaseOperationArgs & { query: string },
  ) => Effect.Effect<string, DatabaseError>;
}

export class DatabaseService extends Context.Tag(
  "ship/services/database/definition/database-service/DatabaseService",
)<DatabaseService, DatabaseServiceShape>() {}
