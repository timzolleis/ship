import { Args, Command, Options, Prompt } from "@effect/cli"
import { FileSystem } from "@effect/platform"
import { Console, Effect, Option } from "effect"
import { ConfigService } from "../services/config.js"
import { ProxyService } from "../services/proxy.js"
import { GitService } from "../services/git.js"
import { DatabaseService } from "../services/database.js"
import { bold, green, red, yellow } from "../fmt.js"

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
      const git = yield* GitService
      const db = yield* DatabaseService

      // Resolve project and branch
      let project: string
      let branch: string

      if (Option.isSome(projectOpt) && Option.isSome(branchOpt)) {
        project = projectOpt.value
        branch = branchOpt.value
      } else {
        const workspaces = yield* config.loadWorkspaces()
        const cwd = process.cwd()
        const current = workspaces.find((w) => cwd.startsWith(w.path))

        if (current) {
          project = current.project
          branch = current.branch
        } else if (workspaces.length > 0) {
          const filtered = Option.isSome(projectOpt)
            ? workspaces.filter((w) => w.project === projectOpt.value)
            : workspaces

          if (filtered.length === 0) {
            yield* Console.log(`  ${red("✗")} No workspaces found for project ${bold(Option.getOrElse(projectOpt, () => "?"))}`)
            return
          }

          const selected = yield* Prompt.select({
            message: "Select workspace to tear down",
            choices: filtered.map((w) => ({
              title: `${w.project}  ${w.branch}`,
              value: w,
              description: w.proxyDomain
            }))
          })
          project = selected.project
          branch = selected.branch
        } else {
          yield* Console.log(`  ${red("✗")} No workspaces found.`)
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
        Effect.tapError(() => Console.log(`  ${yellow("⚠")} Proxy route     ${workspace.proxyDomain} not found`)),
        Effect.catchAll(() => Effect.void)
      )

      // 2. Drop database
      const projectConfig = yield* config.getProject(project)
      yield* db.dropDb(projectConfig.database.container, projectConfig.database.user, workspace.dbName).pipe(
        Effect.tap(() => Console.log(`  ${green("✓")} Database        ${workspace.dbName} dropped`)),
        Effect.tapError(() => Console.log(`  ${yellow("⚠")} Database        ${workspace.dbName} could not be dropped`)),
        Effect.catchAll(() => Effect.void)
      )

      if (!dbOnly) {
        yield* Effect.logDebug("down", { repoPath: projectConfig.path, worktree: workspace.path, branch })

        // 3. Remove worktree
        const fs = yield* FileSystem.FileSystem
        yield* git.worktreeRemove(projectConfig.path, workspace.path, force).pipe(
          Effect.tap(() => Console.log(`  ${green("✓")} Worktree        ${workspace.path} removed`)),
          Effect.orElse(() =>
            fs.remove(workspace.path, { recursive: true }).pipe(
              Effect.tap(() => Console.log(`  ${green("✓")} Worktree        ${workspace.path} removed (force)`))
            )
          ),
          Effect.tapError(() => Console.log(`  ${yellow("⚠")} Worktree        ${workspace.path} not found`)),
          Effect.catchAll(() => Effect.void)
        )

        // 4. Delete branch
        yield* git.deleteBranch(projectConfig.path, branch).pipe(
          Effect.tap(() => Console.log(`  ${green("✓")} Branch          ${branch} deleted`)),
          Effect.tapError(() => Console.log(`  ${yellow("⚠")} Branch          ${branch} not found`)),
          Effect.catchAll(() => Effect.void)
        )
      }

      // 5. Remove from workspace registry
      yield* config.removeWorkspace(project, branch)

      yield* Console.log("")
      yield* Console.log(`  ${green("Teardown complete.")}`)
      yield* Console.log("")
    }).pipe(
      Effect.catchAll((e) =>
        Console.error(`\n  ${red("Error:")} ${e.message}\n`)
      )
    )
)
