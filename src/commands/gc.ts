import { Command, Options, Prompt } from "@effect/cli"
import { Console, Effect, Stream } from "effect"
import { ConfigService } from "../services/config.js"
import type { ProjectConfig } from "../schema/config.js"
import type {
  CreateDirectoryError,
  EncodeConfigError,
  ParseConfigError,
  ReadFileError,
  WriteFileError,
} from "../errors.js"
import { ShellService } from "../services/shell.js"
import { SyncService } from "../services/sync.js"
import { WorkspaceService } from "../services/workspace.js"
import { bold, dim, green, red, yellow, blue } from "../fmt.js"
import type { Workspace } from "../schema/workspace.js"

// ---------------------------------------------------------------------------
// ship gc [--force] [--dry-run]
// ---------------------------------------------------------------------------

const forceOpt = Options.boolean("force").pipe(Options.withAlias("f"))
const dryRunOpt = Options.boolean("dry-run")
const syncOpt = Options.boolean("sync").pipe(Options.withAlias("s"))

type ConfigError =
  | ParseConfigError
  | ReadFileError
  | CreateDirectoryError
  | EncodeConfigError
  | WriteFileError

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

// Tear down each cleaned workspace (worktree + branch + remote branch, forced),
// then write the workspace registry exactly once to avoid read-modify-write
// races. Returns the number of workspaces removed from the registry.
export const gcCleanup = (
  toClean: ReadonlyArray<{ ws: Workspace; projectConfig: ProjectConfig | null }>
): Effect.Effect<number, ConfigError, WorkspaceService | ConfigService> =>
  Effect.gen(function* () {
    const wsSvc = yield* WorkspaceService
    const config = yield* ConfigService

    yield* Effect.forEach(
      toClean,
      ({ ws, projectConfig }) =>
        projectConfig
          ? wsSvc
              .teardown(ws, projectConfig, {
                removeWorktree: true,
                force: true,
                deleteRemoteBranch: true,
              })
              .pipe(Stream.runDrain)
          : Effect.void,
      { concurrency: "unbounded" }
    )

    if (toClean.length === 0) return 0

    const removed = new Set(toClean.map((c) => `${c.ws.project}\0${c.ws.branch}`))
    const current = yield* config.loadWorkspaces()
    yield* config.saveWorkspaces(
      current.filter((w) => !removed.has(`${w.project}\0${w.branch}`))
    )
    return toClean.length
  })

export const gcCommand = Command.make(
  "gc",
  { force: forceOpt, dryRun: dryRunOpt, sync: syncOpt },
  ({ force, dryRun, sync: shouldSync }) =>
    Effect.gen(function* () {
      const config = yield* ConfigService
      const shell = yield* ShellService
      const syncSvc = yield* SyncService

      const workspaces = yield* config.loadWorkspaces()

      if (workspaces.length === 0) {
        yield* Console.log(`  ${dim("No active workspaces.")}`)
        return
      }

      yield* Console.log("")
      yield* Console.log(`  Checking ${workspaces.length} workspace${workspaces.length === 1 ? "" : "s"}...`)

      // Phase 1: Check all PR statuses in parallel (gh pr view stays inline — D12).
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
        yield* Effect.forEach(merged, ({ ws, prLabel }) =>
          Console.log(`  ${ws.project}  ${bold(ws.branch.padEnd(22))} ${prLabel}  → ${yellow("would tear down")}`)
        )
        cleaned = merged.length
      } else {
        // Collect approvals serially (prompts must be sequential) before any teardown.
        const toClean = force
          ? merged
          : yield* Effect.filter(merged, (cw) =>
              Prompt.confirm({
                message: `${cw.ws.project}/${cw.ws.branch} — ${cw.prLabel}. Tear down?`
              }).pipe(
                Effect.tap((ok) =>
                  ok ? Effect.void : Console.log(
                    `  ${cw.ws.project}  ${bold(cw.ws.branch.padEnd(22))} ${cw.prLabel}  → ${dim("skipped")}`
                  )
                )
              )
            )

        cleaned = yield* gcCleanup(
          toClean.map((c) => ({ ws: c.ws, projectConfig: c.projectConfig }))
        )

        yield* Effect.forEach(toClean, ({ ws, prLabel }) =>
          Console.log(`  ${ws.project}  ${bold(ws.branch.padEnd(22))} ${prLabel}  → ${green("cleaned up")}`)
        )
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
