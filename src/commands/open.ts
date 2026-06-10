import { Args, Command, Prompt } from "@effect/cli"
import { Terminal } from "@effect/platform"
import { Console, Effect, Option } from "effect"
import { ConfigService } from "../services/config.js"
import { DatabaseService } from "../services/database.js"
import { EditorService } from "../services/editor.js"
import { ShellService } from "../services/shell.js"
import { locateWorkspace } from "../domain/workspace-locate.js"
import type { Workspace } from "../schema/workspace.js"
import { NoActiveWorkspacesError, WorkspaceNotFoundError } from "../errors.js"
import { bold, red } from "../fmt.js"

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

const TARGETS = ["editor", "url", "db"] as const

/**
 * Split the two positional args into a branch query and a target. The first
 * arg is a target keyword when it is one of TARGETS; otherwise it is a branch
 * query and the second arg (if any) is the target. Defaults to "editor".
 */
export const splitArgs = (
  first: string | undefined,
  second: string | undefined
): { branchArg: string | undefined; target: string } => {
  if (first && TARGETS.includes(first as (typeof TARGETS)[number])) {
    return { branchArg: undefined, target: first }
  }
  if (first) {
    return { branchArg: first, target: second ?? "editor" }
  }
  return { branchArg: undefined, target: "editor" }
}

// ---------------------------------------------------------------------------
// Resolve workspace: domain locate (cwd / branch) with interactive picker
// fallback. The picker only fires when no branch query was given and cwd did
// not match — a branch query that matches nothing is an error.
// ---------------------------------------------------------------------------

export const resolveWorkspace = (
  branchArg: string | undefined,
  workspaces: ReadonlyArray<Workspace>,
  cwd: string
): Effect.Effect<
  Workspace,
  WorkspaceNotFoundError | NoActiveWorkspacesError | Terminal.QuitException,
  Terminal.Terminal
> =>
  Effect.gen(function* () {
    const located = locateWorkspace(workspaces, { cwd, branch: branchArg })
    if (Option.isSome(located)) return located.value

    if (branchArg !== undefined) {
      return yield* new WorkspaceNotFoundError({ branch: branchArg })
    }

    if (workspaces.length === 0) {
      return yield* new NoActiveWorkspacesError()
    }

    return yield* Prompt.select({
      message: "Select a workspace",
      choices: workspaces.map((w) => ({
        title: `${w.project}  ${w.branch}`,
        value: w,
        description: w.proxyDomain,
      })),
    })
  })

// ---------------------------------------------------------------------------
// ship open [branch-or-target] [target]
// ---------------------------------------------------------------------------

const firstArg = Args.text({ name: "branch-or-target" }).pipe(Args.optional)
const secondArg = Args.text({ name: "target" }).pipe(Args.optional)

export const openCommand = Command.make(
  "open",
  { first: firstArg, second: secondArg },
  ({ first, second }) =>
    Effect.gen(function* () {
      const config = yield* ConfigService
      const db = yield* DatabaseService
      const editor = yield* EditorService
      const shell = yield* ShellService

      const workspaces = yield* config.loadWorkspaces()

      const firstVal = Option.getOrUndefined(first)
      const secondVal = Option.getOrUndefined(second)
      const { branchArg, target } = splitArgs(firstVal, secondVal)

      const workspace = yield* resolveWorkspace(branchArg, workspaces, process.cwd())
      const projectConfig = yield* config.getProject(workspace.project)

      switch (target) {
        case "editor": {
          yield* Console.log(`  Opening ${bold(workspace.branch)}...`)
          yield* editor.open(workspace.path)
          break
        }
        case "url": {
          const url = `https://${workspace.proxyDomain}`
          yield* Console.log(`  Opening ${bold(url)}...`)
          yield* shell.exec("open", [url])
          break
        }
        case "db": {
          const dbConfig = projectConfig.database
          yield* Console.log(`  Connecting to ${bold(workspace.dbName)}...`)
          yield* db.session(
            { runtime: dbConfig.runtime, user: dbConfig.user },
            workspace.dbName
          )
          break
        }
        default:
          yield* Console.log(`  ${red("✗")} Unknown target '${target}'. Use: editor, url, db`)
      }
    }).pipe(
      Effect.catchAll((e) => Console.error(`\n  ${red("Error:")} ${e.message}\n`))
    )
)
