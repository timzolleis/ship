import { Command, Options, Prompt } from "@effect/cli"
import { Console, Effect } from "effect"
import { ConfigService } from "../services/config.js"
import type { ProjectConfig } from "../schema/config.js"
import { ProxyService } from "../services/proxy.js"
import { ShellService } from "../services/shell.js"
import { GitService } from "../services/git.js"
import { DatabaseService } from "../services/database.js"
import { SyncService } from "../services/sync.js"
import { bold, dim, green, red, yellow, blue } from "../fmt.js"
import type { Workspace } from "../schema/workspace.js"

// ---------------------------------------------------------------------------
// ship gc [--force] [--dry-run]
// ---------------------------------------------------------------------------

const forceOpt = Options.boolean("force").pipe(Options.withAlias("f"))
const dryRunOpt = Options.boolean("dry-run")
const syncOpt = Options.boolean("sync").pipe(Options.withAlias("s"))

interface PrStatus {
  state: "MERGED" | "OPEN" | "CLOSED"
  number: number
  mergedAt?: string
}

interface CheckedWorkspace {
  ws: Workspace
  projectConfig: ProjectConfig | null
  prStatus: PrStatus | null
  prLabel: string
}

export const gcCommand = Command.make(
  "gc",
  { force: forceOpt, dryRun: dryRunOpt, sync: syncOpt },
  ({ force, dryRun, sync: shouldSync }) =>
    Effect.gen(function* () {
      const config = yield* ConfigService
      const proxy = yield* ProxyService
      const shell = yield* ShellService
      const git = yield* GitService
      const db = yield* DatabaseService
      const syncSvc = yield* SyncService

      const workspaces = yield* config.loadWorkspaces()

      if (workspaces.length === 0) {
        yield* Console.log(`  ${dim("No active workspaces.")}`)
        return
      }

      yield* Console.log("")
      yield* Console.log(`  Checking ${workspaces.length} workspace${workspaces.length === 1 ? "" : "s"}...`)

      // Phase 1: Check all PR statuses in parallel
      const checked: CheckedWorkspace[] = yield* Effect.all(
        workspaces.map((ws) =>
          Effect.gen(function* () {
            const projectConfig = yield* config.getProject(ws.project).pipe(
              Effect.catchAll(() => Effect.succeed(null))
            )
            const projectShell = projectConfig ? shell.inDir(projectConfig.path) : null

            const prStatus = projectShell
              ? yield* projectShell.exec("gh", ["pr", "view", ws.branch, "--json", "state,number,mergedAt"]).pipe(
                  Effect.map((r) => {
                    try { return JSON.parse(r.stdout) as PrStatus } catch { return null }
                  }),
                  Effect.catchAll(() => Effect.succeed(null))
                )
              : null

            const prLabel = prStatus
              ? prStatus.state === "MERGED"
                ? `PR #${prStatus.number} ${green("merged")}${prStatus.mergedAt ? ` ${dim(timeAgo(prStatus.mergedAt))}` : ""}`
                : prStatus.state === "OPEN"
                  ? `PR #${prStatus.number} ${blue("open")}`
                  : `PR #${prStatus.number} ${yellow("closed")}`
              : dim("no PR")

            return { ws, projectConfig, prStatus, prLabel } as CheckedWorkspace
          })
        ),
        { concurrency: "unbounded" }
      )

      yield* Console.log("")

      // Phase 2: Display results and prompt for cleanup
      const merged = checked.filter((c) => c.prStatus?.state === "MERGED")
      const kept = checked.filter((c) => c.prStatus?.state !== "MERGED")

      for (const { ws, prLabel } of kept) {
        yield* Console.log(`  ${ws.project}  ${bold(ws.branch.padEnd(22))} ${prLabel}  → ${dim("keep")}`)
      }

      let cleaned = 0

      if (merged.length === 0) {
        yield* Console.log("")
        yield* Console.log(`  ${dim("Nothing to clean up.")}`)
        yield* Console.log("")
        return
      }

      if (dryRun) {
        for (const { ws, prLabel } of merged) {
          yield* Console.log(`  ${ws.project}  ${bold(ws.branch.padEnd(22))} ${prLabel}  → ${yellow("would tear down")}`)
        }
        cleaned = merged.length
      } else {
        for (const { ws, projectConfig, prLabel } of merged) {
          const shouldClean = force || (yield* Prompt.confirm({
            message: `${ws.project}/${ws.branch} — ${prLabel}. Tear down?`
          }))

          if (shouldClean) {
            yield* proxy.removeRoute(ws.proxyDomain).pipe(Effect.catchAll(() => Effect.void))
            if (projectConfig) {
              yield* db.dropDb(
                projectConfig.database.container, projectConfig.database.user, ws.dbName
              ).pipe(Effect.catchAll(() => Effect.void))
              yield* git.worktreeRemove(projectConfig.path, ws.path, true).pipe(Effect.catchAll(() => Effect.void))
              yield* git.deleteBranch(projectConfig.path, ws.branch).pipe(Effect.catchAll(() => Effect.void))
            }
            yield* config.removeWorkspace(ws.project, ws.branch)

            yield* Console.log(`  ${ws.project}  ${bold(ws.branch.padEnd(22))} ${prLabel}  → ${green("cleaned up")}`)
            cleaned++
          } else {
            yield* Console.log(`  ${ws.project}  ${bold(ws.branch.padEnd(22))} ${prLabel}  → ${dim("skipped")}`)
          }
        }
      }

      yield* Console.log("")
      if (cleaned > 0) {
        const verb = dryRun ? "would clean up" : "cleaned up"
        yield* Console.log(`  ${green("✓")} ${verb} ${cleaned} workspace${cleaned === 1 ? "" : "s"}.`)
      } else {
        yield* Console.log(`  ${dim("Nothing to clean up.")}`)
      }

      // Sync unique projects after cleanup
      if (shouldSync && !dryRun && cleaned > 0) {
        const projects = [...new Set(merged.filter((c) => c.projectConfig).map((c) => c.ws.project))]
        for (const project of projects) {
          const projectConfig = yield* config.getProject(project)
          yield* Console.log(`  Syncing ${bold(project)}...`)
          const result = yield* syncSvc.sync(projectConfig).pipe(
            Effect.catchAll((e) => {
              return Console.log(`  ${yellow("⚠")} Sync failed    ${dim(e.message)}`).pipe(
                Effect.as(null)
              )
            })
          )
          if (result) {
            if (result.headMoved) {
              yield* Console.log(`  ${green("✓")} Base updated   ${dim("main fast-forwarded")}`)
              if (result.migrated) {
                yield* Console.log(`  ${green("✓")} Base migrated  ${dim(projectConfig.database.source)}`)
              }
            } else if (result.skippedPull) {
              yield* Console.log(`  ${yellow("⚠")} Skipped pull   ${dim(result.skippedPull)}`)
            } else {
              yield* Console.log(`  ${dim("  · Base           already up to date")}`)
            }
          }
        }
      }

      yield* Console.log("")
    }).pipe(
      Effect.catchAll((e) =>
        Console.error(`\n  ${red("Error:")} ${e.message}\n`)
      )
    )
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const timeAgo = (iso: string): string => {
  const diff = Date.now() - new Date(iso).getTime()
  const hours = Math.floor(diff / (1000 * 60 * 60))
  if (hours < 1) return "just now"
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}
