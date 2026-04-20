import { Args, Command, Options, Prompt } from "@effect/cli"
import { Path } from "@effect/platform"
import { Console, Effect, Option } from "effect"
import { ConfigService } from "../services/config.js"
import { ProxyService } from "../services/proxy.js"
import { GitService } from "../services/git.js"
import { DatabaseService } from "../services/database.js"
import { ShellService } from "../services/shell.js"
import { EditorService } from "../services/editor.js"
import { SyncService } from "../services/sync.js"
import { ShipConfig } from "../schema/config.js"
import { Workspace } from "../schema/workspace.js"
import { EnvService } from "../services/env.js"
import { bold, dim, green, yellow, red, blue } from "../fmt.js"

// ---------------------------------------------------------------------------
// Helpers
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

const abbreviateValue = (value: string): string => {
  try {
    const url = new URL(value)
    return url.hostname + (url.pathname !== "/" ? url.pathname : "")
  } catch {
    const dbMatch = value.match(/\/([^/]+)$/)
    if (dbMatch) return dbMatch[1]!
    return value.length > 40 ? value.substring(0, 37) + "..." : value
  }
}

// ---------------------------------------------------------------------------
// ship create <project> [branch]
// ---------------------------------------------------------------------------

const projectArg = Args.text({ name: "project" })
const branchArg = Args.text({ name: "branch" }).pipe(Args.optional)
const baseOption = Options.text("base").pipe(
  Options.withDescription("Base branch to create worktree from (defaults to HEAD)"),
  Options.optional
)

export const createCommand = Command.make(
  "create",
  { project: projectArg, branch: branchArg, base: baseOption },
  ({ project, branch: branchOpt, base: baseOpt }) =>
    Effect.gen(function* () {
      const config = yield* ConfigService
      const proxy = yield* ProxyService
      const git = yield* GitService
      const db = yield* DatabaseService
      const shell = yield* ShellService
      const editor = yield* EditorService
      const sync = yield* SyncService
      const env = yield* EnvService
      const pathSvc = yield* Path.Path

      // 1. Resolve project config
      const projectConfig = yield* config.getProject(project)

      // 2. Resolve branch
      const branch = Option.isSome(branchOpt)
        ? branchOpt.value
        : yield* Prompt.text({ message: "Branch name:" })

      // 3. Resolve base branch
      const baseBranch = Option.isSome(baseOpt) ? baseOpt.value : undefined

      // 4. Compute paths and names (deterministic from project + branch)
      const branchSlug = toBranchSlug(branch)
      const branchSlugSafe = toBranchSlugSafe(branch)
      const vars = { branch_slug: branchSlug, branch_slug_safe: branchSlugSafe, project }
      const worktreeDir = pathSvc.resolve(
        projectConfig.path,
        resolvePattern(projectConfig.worktree.dirPattern, vars)
      )
      const proxyDomain = resolvePattern(projectConfig.worktree.proxyDomainPattern, vars)
      const dbName = resolvePattern(projectConfig.worktree.dbNamePattern, vars)

      // 5. Probe current state of every resource
      const existingWs = yield* config.findWorkspace(project, branch)
      const worktrees = yield* git.worktreeList(projectConfig.path).pipe(
        Effect.orElseSucceed(() => [] as ReadonlyArray<{ path: string; branch: string }>)
      )
      const worktreeExists = worktrees.some((w) => w.path === worktreeDir)

      const containerRunning = yield* db.isContainerRunning(projectConfig.database.container)
      const dbAlreadyExists = containerRunning
        ? yield* db.dbExists(projectConfig.database.container, projectConfig.database.user, dbName).pipe(
            Effect.orElseSucceed(() => false)
          )
        : false

      const existingRoutes = yield* proxy.getRoutes().pipe(
        Effect.orElseSucceed(() => [] as ReadonlyArray<import("../services/proxy.js").Route>)
      )
      const existingRoute = existingRoutes.find((r) => r.domain === proxyDomain)

      // 6. Pick port: reuse from registered workspace or existing route, else allocate fresh
      const port = Option.isSome(existingWs)
        ? existingWs.value.port
        : existingRoute
          ? existingRoute.port
          : yield* proxy.nextPort()

      // 7. Fully-provisioned short-circuit → just open the editor
      const allPresent =
        Option.isSome(existingWs) && worktreeExists && dbAlreadyExists && !!existingRoute
      if (allPresent) {
        yield* Console.log("")
        yield* Console.log(`  Already exists: ${bold(branch)} in ${dim(existingWs.value.path)}`)
        yield* Console.log(`  Proxy: ${blue(`https://${existingWs.value.proxyDomain}`)} → :${existingWs.value.port}`)
        yield* Console.log("")
        const shouldOpen = yield* Prompt.confirm({ message: "Open in editor?", initial: true })
        if (shouldOpen) yield* editor.open(existingWs.value.path)
        return
      }

      // 8. Container must be running for db work
      if (!containerRunning) {
        yield* Console.log(`  ${red("✗")} Database container '${projectConfig.database.container}' is not running.`)
        yield* Console.log(`    Start it first, then run this command again.`)
        return
      }

      yield* Console.log("")
      yield* Effect.logDebug("create", { repoPath: projectConfig.path, worktreeDir, branch, branchSlug, dirPattern: projectConfig.worktree.dirPattern })

      const resuming =
        Option.isSome(existingWs) || worktreeExists || dbAlreadyExists || !!existingRoute
      if (resuming) {
        yield* Console.log(`  ${yellow("↻")} Resuming partial setup...`)
      }

      // 9. Register workspace up front — so `ship down` can clean partial state
      if (Option.isNone(existingWs)) {
        yield* config.addWorkspace(
          new Workspace({
            project,
            branch,
            path: worktreeDir,
            port,
            dbName,
            proxyDomain,
            created: new Date().toISOString().split("T")[0]!,
          })
        )
      }

      // 10. Sync base (skip if worktree already on disk — don't move refs behind it)
      if (!worktreeExists) {
        const syncResult = yield* sync.sync(projectConfig, baseBranch).pipe(
          Effect.catchAll((e) =>
            Effect.succeed({
              fetched: false, pulled: false, headMoved: false,
              installed: false, migrated: false, skippedPull: e.message
            } as import("../services/sync.js").SyncResult)
          )
        )
        const baseLabel = baseBranch ?? "main"
        if (syncResult.headMoved) {
          yield* Console.log(`  ${green("✓")} Base updated   ${dim(`${baseLabel} fast-forwarded`)}`)
          if (syncResult.migrated) {
            yield* Console.log(`  ${green("✓")} Base migrated  ${dim(projectConfig.database.source)}`)
          }
        } else if (syncResult.skippedPull) {
          yield* Console.log(`  ${yellow("⚠")} Base sync      ${dim(syncResult.skippedPull)}`)
        } else if (syncResult.fetched) {
          yield* Console.log(`  ${dim("  · Base           already up to date")}`)
        }
      }

      // 11. Git worktree
      if (worktreeExists) {
        yield* Console.log(`  ${dim("•")} Branch         ${bold(branch)} ${dim("(already present)")}`)
        yield* Console.log(`  ${dim("•")} Worktree       ${dim(worktreeDir)} ${dim("(already present)")}`)
      } else {
        yield* git.worktreeAdd(projectConfig.path, worktreeDir, branch, baseBranch)
        yield* Console.log(`  ${green("✓")} Branch         ${bold(branch)}`)
        yield* Console.log(`  ${green("✓")} Worktree       ${dim(worktreeDir)}`)
      }

      // 12. Database
      if (dbAlreadyExists) {
        yield* Console.log(`  ${dim("•")} Database       ${bold(dbName)} ${dim("(already present)")}`)
      } else {
        yield* db.cloneDb(
          projectConfig.database.container,
          projectConfig.database.user,
          projectConfig.database.source,
          dbName
        )
        yield* Console.log(`  ${green("✓")} Database       ${bold(dbName)} ${dim(`(cloned from ${projectConfig.database.source})`)}`)
      }

      // 13. Patch .env files (idempotent — rewrites from source template)
      yield* Console.log("")
      yield* Console.log(`  Configuring environment...`)
      const patchResults = yield* env.patchEnvFiles(
        projectConfig.path,
        worktreeDir,
        projectConfig.env,
        { dbName, proxyDomain, port }
      )
      for (const result of patchResults) {
        if (result.changes.length > 0) {
          yield* Console.log(`    ${blue(result.file)}:`)
          for (const change of result.changes) {
            yield* Console.log(
              `      ${dim(change.key.padEnd(25))} ${abbreviateValue(change.from)} → ${abbreviateValue(change.to)}`
            )
          }
        }
      }

      // 14. Install dependencies
      if (projectConfig.commands.install) {
        yield* Console.log("")
        yield* Console.log(`  Installing dependencies...`)
        yield* shell.execInDir(worktreeDir, projectConfig.commands.install)
        yield* Console.log(`  ${green("✓")} Dependencies   installed`)
      }

      // 15. Generate (e.g., Prisma client)
      if (projectConfig.commands.generate) {
        yield* shell.execInDir(worktreeDir, projectConfig.commands.generate)
      }

      // 16. Run migrations
      if (projectConfig.commands.migrate) {
        yield* Console.log(`  Running migrations...`)
        yield* shell.execInDir(worktreeDir, projectConfig.commands.migrate)
        yield* Console.log(`  ${green("✓")} Migrations     applied`)
      }

      // 17. Proxy route
      if (existingRoute) {
        yield* Console.log(`  ${dim("•")} Proxy          https://${bold(proxyDomain)} → :${blue(String(port))} ${dim("(already present)")}`)
      } else {
        yield* proxy.addRoute(proxyDomain, port).pipe(Effect.catchAll(() => Effect.void))
        yield* Console.log(`  ${green("✓")} Proxy          https://${bold(proxyDomain)} → :${blue(String(port))}`)
      }

      // 15. Auto-open editor
      yield* Console.log("")
      const shipConfig = yield* config.loadConfig()
      let shouldOpen = shipConfig.autoOpenEditor

      if (shouldOpen === undefined) {
        shouldOpen = yield* Prompt.confirm({
          message: "Open workspace in editor?",
          initial: true
        })
        yield* config.saveConfig(new ShipConfig({ ...shipConfig, autoOpenEditor: shouldOpen }))
      }

      if (shouldOpen) {
        yield* editor.open(worktreeDir)
      }

      yield* Console.log(`  ${green("Ready.")}`)
      yield* Console.log("")
    }).pipe(
      Effect.catchAll((e) =>
        Console.error(`\n  ${red("Error:")} ${e.message}\n`)
      )
    )
)
