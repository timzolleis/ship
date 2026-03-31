import { Args, Command, Options, Prompt } from "@effect/cli"
import { CommandExecutor } from "@effect/platform"
import { Console, Effect, Option } from "effect"
import { ConfigService } from "../services/config.js"
import { ProxyService } from "../services/proxy.js"
import * as Git from "../services/git.js"
import * as Database from "../services/database.js"

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const red = (s: string) => `\x1b[31m${s}\x1b[0m`
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`

// ---------------------------------------------------------------------------
// ship down [project] [branch] [--force] [--db-only]
// ---------------------------------------------------------------------------

const projectArg = Args.text({ name: "project" }).pipe(Args.optional)
const branchArg = Args.text({ name: "branch" }).pipe(Args.optional)
const forceOpt = Options.boolean("force").pipe(Options.withAlias("f"))
const dbOnlyOpt = Options.boolean("db-only")

export const downCommand = Command.make(
  "down",
  { project: projectArg, branch: branchArg, force: forceOpt, dbOnly: dbOnlyOpt },
  ({ project: projectOpt, branch: branchOpt, force, dbOnly }) =>
    Effect.gen(function* () {
      const config = yield* ConfigService
      const proxy = yield* ProxyService
      const executor = yield* CommandExecutor.CommandExecutor

      const run = <A, E>(effect: Effect.Effect<A, E, CommandExecutor.CommandExecutor>) =>
        Effect.provideService(effect, CommandExecutor.CommandExecutor, executor)

      // Resolve project and branch
      let project: string
      let branch: string

      if (Option.isSome(projectOpt) && Option.isSome(branchOpt)) {
        project = projectOpt.value
        branch = branchOpt.value
      } else {
        // Try to detect from current worktree
        const workspaces = yield* config.loadWorkspaces()
        const cwd = process.cwd()
        const current = workspaces.find((w) => cwd.startsWith(w.path))

        if (current) {
          project = current.project
          branch = current.branch
        } else if (Option.isSome(projectOpt)) {
          project = projectOpt.value
          branch = yield* Prompt.text({ message: "Branch to tear down:" })
        } else {
          yield* Console.log(`  ${red("✗")} Not inside a workspace. Specify project and branch.`)
          yield* Console.log(`  Usage: ship down <project> <branch>`)
          return
        }
      }

      // Find workspace
      const ws = yield* config.findWorkspace(project, branch)
      if (Option.isNone(ws)) {
        yield* Console.log(`  ${red("✗")} No workspace found for ${bold(project)} / ${bold(branch)}`)
        return
      }
      const workspace = ws.value

      // Confirm unless --force
      if (!force) {
        const confirmed = yield* Prompt.confirm({
          message: `Tear down workspace ${bold(branch)}?`
        })
        if (!confirmed) {
          yield* Console.log(`  Cancelled.`)
          return
        }
      }

      yield* Console.log("")

      // 1. Remove proxy route
      yield* proxy.removeRoute(workspace.proxyDomain).pipe(
        Effect.tap(() => Console.log(`  ${green("✓")} Proxy route     ${workspace.proxyDomain} removed`)),
        Effect.catchAll(() =>
          Console.log(`  ${yellow("⚠")} Proxy route     ${workspace.proxyDomain} not found`)
        )
      )

      // 2. Drop database
      const projectConfig = yield* config.getProject(project)
      yield* run(
        Database.dropDb(projectConfig.database.container, projectConfig.database.user, workspace.dbName)
      ).pipe(
        Effect.tap(() => Console.log(`  ${green("✓")} Database        ${workspace.dbName} dropped`)),
        Effect.catchAll(() =>
          Console.log(`  ${yellow("⚠")} Database        ${workspace.dbName} could not be dropped`)
        )
      )

      if (!dbOnly) {
        // 3. Remove worktree
        yield* run(Git.worktreeRemove(workspace.path, force)).pipe(
          Effect.tap(() => Console.log(`  ${green("✓")} Worktree        ${workspace.path} removed`)),
          Effect.catchAll(() =>
            Console.log(`  ${yellow("⚠")} Worktree        ${workspace.path} not found`)
          )
        )

        // 4. Delete branch
        yield* run(Git.deleteBranch(branch)).pipe(
          Effect.tap(() => Console.log(`  ${green("✓")} Branch          ${branch} deleted`)),
          Effect.catchAll(() =>
            Console.log(`  ${yellow("⚠")} Branch          ${branch} not found`)
          )
        )
      }

      // 5. Remove from workspace registry
      yield* config.removeWorkspace(project, branch)

      yield* Console.log("")
      yield* Console.log(`  ${green("Teardown complete.")}`)
      yield* Console.log("")
    }).pipe(
      Effect.catchAll((e) =>
        Console.error(`\n  ${red("Error:")} ${"message" in e ? e.message : String(e)}\n`)
      )
    )
)
