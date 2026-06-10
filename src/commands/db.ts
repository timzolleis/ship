import { Args, Command } from "@effect/cli"
import { Console, Effect, Option } from "effect"
import { ConfigService } from "../services/config.js"
import { DatabaseService } from "../services/database.js"
import { locateWorkspace } from "../domain/workspace-locate.js"
import { bold, red } from "../fmt.js"

// ---------------------------------------------------------------------------
// Locate the current workspace (by cwd) and run SQL against its database.
// ---------------------------------------------------------------------------

export const runExec = (cwd: string, sql: string) =>
  Effect.gen(function* () {
    const config = yield* ConfigService
    const db = yield* DatabaseService

    const workspaces = yield* config.loadWorkspaces()
    const located = locateWorkspace(workspaces, { cwd })

    if (Option.isNone(located)) {
      yield* Console.error(
        `  ${red("✗")} Not inside a workspace. Navigate to a workspace directory first.`
      )
      return
    }
    const workspace = located.value

    const projectConfig = yield* config.getProject(workspace.project)
    const dbConfig = projectConfig.database

    const output = yield* db.query(
      { runtime: dbConfig.runtime, user: dbConfig.user },
      workspace.dbName,
      sql
    )
    yield* Console.log(output.trimEnd())
  })

// ---------------------------------------------------------------------------
// ship db exec <sql>
// ---------------------------------------------------------------------------

const sqlArg = Args.text({ name: "sql" })

const execCommand = Command.make("exec", { sql: sqlArg }, ({ sql }) =>
  runExec(process.cwd(), sql).pipe(
    Effect.catchAll((e) => Console.error(`\n  ${red("Error:")} ${e.message}\n`))
  )
)

// ---------------------------------------------------------------------------
// ship db (parent)
// ---------------------------------------------------------------------------

export const dbCommand = Command.make("db", {}, () =>
  Console.log(`
  ${bold("ship db")} — database utilities

  ${bold("Usage")}
    ship db exec <sql>    Execute SQL against the current workspace database

  ${bold("Examples")}
    ship db exec "SELECT * FROM users LIMIT 5"
    ship db exec "DROP TABLE sessions"
    ship db exec "\\dt"
`)
).pipe(Command.withSubcommands([execCommand]))
