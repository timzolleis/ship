import { Args, Command } from "@effect/cli"
import { Console, Effect } from "effect"
import { ConfigService } from "../services/config.js"
import { DatabaseService } from "../services/database.js"
import { bold, red } from "../fmt.js"

// ---------------------------------------------------------------------------
// ship db exec <sql>
// ---------------------------------------------------------------------------

const sqlArg = Args.text({ name: "sql" })

const execCommand = Command.make(
  "exec",
  { sql: sqlArg },
  ({ sql }) =>
    Effect.gen(function* () {
      const config = yield* ConfigService
      const db = yield* DatabaseService

      const workspaces = yield* config.loadWorkspaces()
      const cwd = process.cwd()
      const workspace = workspaces.find((w) => cwd.startsWith(w.path))

      if (!workspace) {
        yield* Console.error(`  ${red("✗")} Not inside a workspace. Navigate to a workspace directory first.`)
        return
      }

      const projectConfig = yield* config.getProject(workspace.project)
      const dbConfig = projectConfig.database

      const output = yield* db.execSql(dbConfig.container, dbConfig.user, workspace.dbName, sql)
      yield* Console.log(output.trimEnd())
    }).pipe(
      Effect.catchAll((e) =>
        Console.error(`\n  ${red("Error:")} ${e.message}\n`)
      )
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
