import { Args, Command, Options, Prompt } from "@effect/cli"
import { Console, Effect, Option } from "effect"
import { ConfigService } from "../services/config.js"
import { GitService } from "../services/git.js"
import { DatabaseService } from "../services/database.js"
import { ProxyService } from "../services/proxy.js"
import { Workspace } from "../schema/workspace.js"
import { bold, dim, green, yellow, red, blue } from "../fmt.js"

// ---------------------------------------------------------------------------
// Helpers — mirror create.ts pattern resolution so indexed entries line up
// with what `ship create` would have produced.
// ---------------------------------------------------------------------------

const toBranchSlug = (branch: string) => branch.replace(/\//g, "-")
const toBranchSlugSafe = (branch: string) =>
  branch.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase()

const resolvePattern = (pattern: string, vars: Record<string, string>): string => {
  let result = pattern
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, "g"), value)
  }
  return result
}

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
      let nextPortCursor: number | null = null

      yield* Console.log("")

      for (const [alias, projectConfig] of projectEntries) {
        yield* Console.log(`  ${bold(alias)}  ${dim(projectConfig.path)}`)

        const worktrees = yield* git.worktreeList(projectConfig.path).pipe(
          Effect.orElseSucceed(() => [] as ReadonlyArray<{ path: string; branch: string }>)
        )

        const registeredPaths = new Set(
          existingWorkspaces.filter((w) => w.project === alias).map((w) => w.path)
        )
        const registeredBranches = new Set(
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

        const containerRunning = yield* db.isContainerRunning(projectConfig.database.container)
        if (!containerRunning) {
          yield* Console.log(
            `  ${yellow("⚠")} Container '${projectConfig.database.container}' not running — DB existence not verified.`
          )
        }

        for (const wt of candidates) {
          const branchSlug = toBranchSlug(wt.branch)
          const branchSlugSafe = toBranchSlugSafe(wt.branch)
          const vars = { branch_slug: branchSlug, branch_slug_safe: branchSlugSafe, project: alias }
          const expectedDbName = resolvePattern(projectConfig.worktree.dbNamePattern, vars)
          const expectedProxyDomain = resolvePattern(projectConfig.worktree.proxyDomainPattern, vars)

          const dbFound = containerRunning
            ? yield* db.dbExists(
                projectConfig.database.container,
                projectConfig.database.user,
                expectedDbName
              )
            : false

          const route = existingRoutes.find((r) => r.domain === expectedProxyDomain)
          let port: number
          if (route) {
            port = route.port
          } else {
            if (nextPortCursor === null) {
              nextPortCursor = yield* proxy.nextPort()
            }
            port = nextPortCursor
            nextPortCursor++
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
              project: alias,
              branch: wt.branch,
              path: wt.path,
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
