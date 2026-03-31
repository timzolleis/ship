import { Args, Command, Prompt } from "@effect/cli"
import { CommandExecutor } from "@effect/platform"
import type { Terminal } from "@effect/platform/Terminal"
import { Console, Effect } from "effect"
import { ConfigService } from "../services/config.js"
import type { Workspace } from "../schema/workspace.js"
import * as Shell from "../services/shell.js"

// ---------------------------------------------------------------------------
// Editor detection
// ---------------------------------------------------------------------------

export const detectEditor = (
  executor: CommandExecutor.CommandExecutor
): Effect.Effect<string, never, never> => {
  const run = <A, E>(effect: Effect.Effect<A, E, CommandExecutor.CommandExecutor>) =>
    Effect.provideService(effect, CommandExecutor.CommandExecutor, executor)

  if (process.env.VISUAL) return Effect.succeed(process.env.VISUAL)
  if (process.env.EDITOR) return Effect.succeed(process.env.EDITOR)

  const candidates = ["zed", "cursor", "code", "subl", "nvim", "vim"]
  return Effect.gen(function* () {
    for (const cmd of candidates) {
      const found = yield* run(Shell.exec("which", [cmd])).pipe(
        Effect.map(() => true),
        Effect.catchAll(() => Effect.succeed(false))
      )
      if (found) return cmd
    }
    return "vi"
  })
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`
const red = (s: string) => `\x1b[31m${s}\x1b[0m`
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const blue = (s: string) => `\x1b[34m${s}\x1b[0m`

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
      const match = workspaces.find((w) =>
        w.branch === arg || w.branch.endsWith(`/${arg}`)
      )
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
//
// Examples:
//   ship open                  → picker (or current), open editor
//   ship open tim/ep-241       → find workspace, open editor
//   ship open url              → current workspace, open browser
//   ship open tim/ep-241 url   → find workspace, open browser
//   ship open db               → current workspace, open psql
// ---------------------------------------------------------------------------

const firstArg = Args.text({ name: "branch-or-target" }).pipe(Args.optional)
const secondArg = Args.text({ name: "target" }).pipe(Args.optional)

export const openCommand = Command.make(
  "open",
  { first: firstArg, second: secondArg },
  ({ first, second }) =>
    Effect.gen(function* () {
      const config = yield* ConfigService
      const executor = yield* CommandExecutor.CommandExecutor

      const run = <A, E>(effect: Effect.Effect<A, E, CommandExecutor.CommandExecutor>) =>
        Effect.provideService(effect, CommandExecutor.CommandExecutor, executor)

      const workspaces = yield* config.loadWorkspaces()

      // Figure out what's a branch and what's a target
      const firstVal = first._tag === "Some" ? first.value : undefined
      const secondVal = second._tag === "Some" ? second.value : undefined

      let branchArg: string | undefined
      let target: string = "editor"

      if (firstVal && TARGETS.includes(firstVal as any)) {
        // `ship open url`
        target = firstVal
      } else if (firstVal) {
        // `ship open tim/ep-241` or `ship open tim/ep-241 url`
        branchArg = firstVal
        if (secondVal) target = secondVal
      }

      const workspace = yield* resolveWorkspace(branchArg, workspaces)
      const projectConfig = yield* config.getProject(workspace.project)

      switch (target) {
        case "editor": {
          const shipConfig = yield* config.loadConfig()
          const editor = shipConfig.editor ?? (yield* detectEditor(executor))
          yield* Console.log(`  Opening ${bold(workspace.branch)} in ${bold(editor)}...`)
          yield* run(Shell.exec(editor, [workspace.path]))
          break
        }
        case "url": {
          const url = `https://${workspace.proxyDomain}`
          yield* Console.log(`  Opening ${bold(url)}...`)
          yield* run(Shell.exec("open", [url]))
          break
        }
        case "db": {
          const db = projectConfig.database
          yield* Console.log(`  Connecting to ${bold(workspace.dbName)}...`)
          yield* run(Shell.execInteractive("docker", [
            "exec", "-it", db.container,
            "psql", "-U", db.user, workspace.dbName
          ]))
          break
        }
        default:
          yield* Console.log(`  ${red("✗")} Unknown target '${target}'. Use: editor, url, db`)
      }
    }).pipe(
      Effect.catchAll((e) =>
        Console.error(`\n  ${red("Error:")} ${"message" in e ? e.message : String(e)}\n`)
      )
    )
)
