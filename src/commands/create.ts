import { Args, Command, Prompt } from "@effect/cli"
import { Path } from "@effect/platform"
import { Console, Effect, Option } from "effect"
import { ConfigService } from "../services/config.js"
import { ProxyService } from "../services/proxy.js"
import { GitService } from "../services/git.js"
import { DatabaseService } from "../services/database.js"
import { ShellService } from "../services/shell.js"
import { EditorService } from "../services/editor.js"
import { ShipConfig } from "../schema/config.js"
import { Workspace } from "../schema/workspace.js"
import { EnvService } from "../services/env.js"
import { bold, dim, green, red, blue } from "../fmt.js"

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

export const createCommand = Command.make(
  "create",
  { project: projectArg, branch: branchArg },
  ({ project, branch: branchOpt }) =>
    Effect.gen(function* () {
      const config = yield* ConfigService
      const proxy = yield* ProxyService
      const git = yield* GitService
      const db = yield* DatabaseService
      const shell = yield* ShellService
      const editor = yield* EditorService
      const env = yield* EnvService
      const pathSvc = yield* Path.Path

      // 1. Resolve project config
      const projectConfig = yield* config.getProject(project)

      // 2. Resolve branch
      const branch = Option.isSome(branchOpt)
        ? branchOpt.value
        : yield* Prompt.text({ message: "Branch name:" })

      // 3. Check if workspace already exists
      const existing = yield* config.findWorkspace(project, branch)
      if (Option.isSome(existing)) {
        yield* Console.log("")
        yield* Console.log(`  Already exists: ${bold(branch)} in ${dim(existing.value.path)}`)
        yield* Console.log(`  Proxy: ${blue(`https://${existing.value.proxyDomain}`)} → :${existing.value.port}`)
        yield* Console.log("")

        const shouldOpen = yield* Prompt.confirm({
          message: "Open in editor?",
          initial: true
        })
        if (shouldOpen) {
          yield* editor.open(existing.value.path)
        }
        return
      }

      // 4. Compute paths and names
      const branchSlug = toBranchSlug(branch)
      const branchSlugSafe = toBranchSlugSafe(branch)
      const vars = { branch_slug: branchSlug, branch_slug_safe: branchSlugSafe, project }
      const worktreeDir = pathSvc.resolve(
        projectConfig.path,
        resolvePattern(projectConfig.worktree.dirPattern, vars)
      )
      const proxyDomain = resolvePattern(projectConfig.worktree.proxyDomainPattern, vars)
      const dbName = resolvePattern(projectConfig.worktree.dbNamePattern, vars)

      yield* Console.log("")
      yield* Effect.logDebug("create", { repoPath: projectConfig.path, worktreeDir, branch, branchSlug, dirPattern: projectConfig.worktree.dirPattern })

      // 5. Create git worktree
      yield* git.worktreeAdd(projectConfig.path, worktreeDir, branch)
      yield* Console.log(`  ${green("✓")} Branch         ${bold(branch)}`)
      yield* Console.log(`  ${green("✓")} Worktree       ${dim(worktreeDir)}`)

      // 6. Clone database
      const containerRunning = yield* db.isContainerRunning(projectConfig.database.container)
      if (!containerRunning) {
        yield* Console.log(`  ${red("✗")} Database container '${projectConfig.database.container}' is not running.`)
        yield* Console.log(`    Start it first, then run this command again.`)
        return
      }
      yield* db.cloneDb(
        projectConfig.database.container,
        projectConfig.database.user,
        projectConfig.database.source,
        dbName
      )
      yield* Console.log(`  ${green("✓")} Database       ${bold(dbName)} ${dim(`(cloned from ${projectConfig.database.source})`)}`)

      // 7. Patch .env files
      yield* Console.log("")
      yield* Console.log(`  Configuring environment...`)
      const port = yield* proxy.nextPort()
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

      // 8. Install dependencies
      if (projectConfig.commands.install) {
        yield* Console.log("")
        yield* Console.log(`  Installing dependencies...`)
        yield* shell.execInDir(worktreeDir, projectConfig.commands.install)
        yield* Console.log(`  ${green("✓")} Dependencies   installed`)
      }

      // 9. Generate (e.g., Prisma client)
      if (projectConfig.commands.generate) {
        yield* shell.execInDir(worktreeDir, projectConfig.commands.generate)
      }

      // 10. Run migrations
      if (projectConfig.commands.migrate) {
        yield* Console.log(`  Running migrations...`)
        yield* shell.execInDir(worktreeDir, projectConfig.commands.migrate)
        yield* Console.log(`  ${green("✓")} Migrations     applied`)
      }

      // 11. Add proxy route
      yield* proxy.addRoute(proxyDomain, port).pipe(
        Effect.catchAll(() => Effect.void)
      )
      yield* Console.log(`  ${green("✓")} Proxy          https://${bold(proxyDomain)} → :${blue(String(port))}`)

      // 12. Register workspace
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

      // 13. Auto-open editor
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
