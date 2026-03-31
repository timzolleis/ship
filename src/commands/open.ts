import { Args, Command, Prompt } from "@effect/cli"
import type { Terminal } from "@effect/platform/Terminal"
import { Console, Effect } from "effect"
import { ConfigService } from "../services/config.js"
import { EditorService } from "../services/editor.js"
import { ShellService } from "../services/shell.js"
import type { Workspace } from "../schema/workspace.js"
import { bold, red, dim } from "../fmt.js"

// ---------------------------------------------------------------------------
// Resolve workspace: from cwd, branch arg, or interactive picker
// ---------------------------------------------------------------------------

const TARGETS = ["editor", "url", "db"] as const

const resolveWorkspace = (
  arg: string | undefined,
  workspaces: ReadonlyArray<Workspace>
): Effect.Effect<Workspace, Error, Terminal> =>
  Effect.gen(function* () {
    const cwd = process.cwd()

    // 1. If arg looks like a branch name (not a target keyword), find by branch
    if (arg && !TARGETS.includes(arg as any)) {
      // Exact match, then suffix match, then substring match
      const match =
        workspaces.find((w) => w.branch === arg) ??
        workspaces.find((w) => w.branch.endsWith(`/${arg}`)) ??
        workspaces.find((w) => w.branch.includes(arg))
      if (match) return match
      return yield* Effect.fail(
        new Error(`No workspace found for branch '${arg}'. Run 'ship ls' to see active workspaces.`)
      )
    }

    // 2. Try to detect from cwd
    const fromCwd = workspaces.find((w) => cwd.startsWith(w.path))
    if (fromCwd) return fromCwd

    // 3. Interactive picker
    if (workspaces.length === 0) {
      return yield* Effect.fail(
        new Error("No active workspaces. Create one with 'ship create <project> <branch>'.")
      )
    }

    const selected = yield* Prompt.select({
      message: "Select a workspace",
      choices: workspaces.map((w) => ({
        title: `${w.project}  ${w.branch}`,
        value: w,
        description: w.proxyDomain
      }))
    })
    return selected
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
      const editor = yield* EditorService
      const shell = yield* ShellService

      const workspaces = yield* config.loadWorkspaces()

      // Figure out what's a branch and what's a target
      const firstVal = first._tag === "Some" ? first.value : undefined
      const secondVal = second._tag === "Some" ? second.value : undefined

      let branchArg: string | undefined
      let target: string = "editor"

      if (firstVal && TARGETS.includes(firstVal as any)) {
        target = firstVal
      } else if (firstVal) {
        branchArg = firstVal
        if (secondVal) target = secondVal
      }

      const workspace = yield* resolveWorkspace(branchArg, workspaces)
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
          yield* shell.execInteractive("docker", [
            "exec", "-it", dbConfig.container,
            "psql", "-U", dbConfig.user, workspace.dbName
          ])
          break
        }
        default:
          yield* Console.log(`  ${red("✗")} Unknown target '${target}'. Use: editor, url, db`)
      }
    }).pipe(
      Effect.catchAll((e) =>
        Console.error(`\n  ${red("Error:")} ${e.message}\n`)
      )
    )
)
