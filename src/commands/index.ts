import { Args, Command, Options, Prompt } from "@effect/cli"
import { Console, Effect, Option } from "effect"
import { ConfigService } from "../services/config.js"
import { GitService } from "../services/git.js"
import { DatabaseService } from "../services/database.js"
import { ProxyService } from "../services/proxy.js"
import { Workspace } from "../schema/workspace.js"
import { BranchName, HostPort, ProjectAlias, WorktreePath } from "../schema/ids.js"
import { deriveNames } from "../domain/workspace-name.js"
import { bold, dim, green, yellow, red, blue } from "../fmt.js"

// ---------------------------------------------------------------------------
// ship index [project] [--all] [--dry-run]
// ---------------------------------------------------------------------------

const projectArg = Args.text({ name: "project" }).pipe(Args.optional)
const allOpt = Options.boolean("all").pipe(Options.withAlias("a"))
const dryRunOpt = Options.boolean("dry-run")

export const indexCommand = Command.make(
  "index",
  { project: projectArg, all: allOpt, dryRun: dryRunOpt },
  ({ project: projectOpt, all, dryRun }) =>
    Effect.gen(function* () {
      const config = yield* ConfigService
      const git = yield* GitService
      const db = yield* DatabaseService
      const proxy = yield* ProxyService

      const shipConfig = yield* config.loadConfig()
      const allProjects = Object.entries(shipConfig.projects)
      const projectEntries = Option.isSome(projectOpt)
        ? allProjects.filter(([alias]) => alias === projectOpt.value)
        : allProjects

      if (projectEntries.length === 0) {
        yield* Console.log("")
        yield* Console.log(
          Option.isSome(projectOpt)
            ? `  ${red("Project not found:")} ${projectOpt.value}`
            : `  ${dim("No projects registered. Run 'ship init' first.")}`
        )
        yield* Console.log("")
        return
      }

      const existingWorkspaces = yield* config.loadWorkspaces()
      const existingRoutes = yield* proxy.getRoutes().pipe(Effect.orElseSucceed(() => []))

      let totalIndexed = 0
      let totalSkipped = 0
      let totalCandidates = 0
      const usedPorts = new Set(existingRoutes.map((r) => r.port))

      yield* Console.log("")

      for (const [alias, projectConfig] of projectEntries) {
        yield* Console.log(`  ${bold(alias)}  ${dim(projectConfig.path)}`)

        const worktrees = yield* git.worktreeList(projectConfig.path).pipe(
          Effect.orElseSucceed(() => [] as ReadonlyArray<{ path: string; branch: string }>)
        )

        const registeredPaths = new Set<string>(
          existingWorkspaces.filter((w) => w.project === alias).map((w) => w.path)
        )
        const registeredBranches = new Set<string>(
          existingWorkspaces.filter((w) => w.project === alias).map((w) => w.branch)
        )
        const candidates = worktrees.filter(
          (wt) =>
            wt.path !== projectConfig.path &&
            !registeredPaths.has(wt.path) &&
            !registeredBranches.has(wt.branch)
        )

        if (candidates.length === 0) {
          yield* Console.log(`  ${dim("  Nothing to index.")}`)
          yield* Console.log("")
          continue
        }

        totalCandidates += candidates.length

        const dbTarget = {
          runtime: projectConfig.database.runtime,
          user: projectConfig.database.user,
        }
        const containerRunning = yield* db.ping(dbTarget)
        if (!containerRunning) {
          yield* Console.log(
            `  ${yellow("⚠")} Database not reachable — DB existence not verified.`
          )
        }

        for (const wt of candidates) {
          // `wt.branch` is a plain string off git.worktreeList — construct the
          // BranchName brand at this edge before deriving names.
          const branch = BranchName.make(wt.branch)
          const names = deriveNames(projectConfig.worktree, ProjectAlias.make(alias), branch)
          const expectedDbName = names.dbName
          const expectedProxyDomain = names.proxyDomain

          const dbFound = containerRunning
            ? yield* db.exists(dbTarget, expectedDbName)
            : false

          const route = existingRoutes.find((r) => r.domain === expectedProxyDomain)
          let port: HostPort
          if (route) {
            port = route.port
          } else {
            port = yield* proxy.nextPort()
            while (usedPorts.has(port)) port = HostPort.make(port + 1)
            usedPorts.add(port)
          }

          yield* Console.log("")
          yield* Console.log(`  ${blue("•")} ${bold(wt.branch)}  ${dim(wt.path)}`)
          yield* Console.log(
            `      DB     ${expectedDbName} ${
              containerRunning ? (dbFound ? green("(found)") : dim("(not found)")) : dim("(unknown)")
            }`
          )
          yield* Console.log(
            `      Proxy  https://${expectedProxyDomain} → :${port} ${
              route ? green("(route exists)") : dim("(no route)")
            }`
          )

          if (dryRun) {
            yield* Console.log(`      ${yellow("would index")}`)
            totalIndexed++
            continue
          }

          const shouldIndex =
            all ||
            (yield* Prompt.confirm({
              message: `Index ${alias}/${wt.branch}?`,
              initial: true,
            }))

          if (!shouldIndex) {
            yield* Console.log(`      ${dim("skipped")}`)
            totalSkipped++
            continue
          }

          yield* config.addWorkspace(
            new Workspace({
              project: ProjectAlias.make(alias),
              branch,
              path: WorktreePath.make(wt.path),
              port,
              dbName: expectedDbName,
              proxyDomain: expectedProxyDomain,
              created: new Date().toISOString().split("T")[0]!,
            })
          )
          yield* Console.log(`      ${green("✓")} indexed`)
          totalIndexed++
        }

        yield* Console.log("")
      }

      if (totalCandidates === 0) {
        yield* Console.log(`  ${dim("Nothing to index.")}`)
        yield* Console.log("")
        return
      }

      if (dryRun) {
        yield* Console.log(
          `  ${dim(`Would index ${totalIndexed} workspace${totalIndexed === 1 ? "" : "s"}.`)}`
        )
      } else {
        const skippedLabel = totalSkipped > 0 ? ` ${dim(`(${totalSkipped} skipped)`)}` : ""
        yield* Console.log(
          `  ${green("✓")} Indexed ${totalIndexed} workspace${totalIndexed === 1 ? "" : "s"}.${skippedLabel}`
        )
        if (totalIndexed > 0) {
          yield* Console.log(`  ${dim("Run 'ship gc' to clean up merged PRs.")}`)
        }
      }
      yield* Console.log("")
    }).pipe(
      Effect.catchAll((e) =>
        Console.error(`\n  ${red("Error:")} ${e.message}\n`)
      )
    )
)
