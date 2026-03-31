import { Command, Options, Prompt } from "@effect/cli"
import { CommandExecutor } from "@effect/platform"
import { Console, Effect } from "effect"
import { ConfigService } from "../services/config.js"
import { ProxyService } from "../services/proxy.js"
import * as Shell from "../services/shell.js"
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
const blue = (s: string) => `\x1b[34m${s}\x1b[0m`

// ---------------------------------------------------------------------------
// ship gc [--force] [--dry-run]
// ---------------------------------------------------------------------------

const forceOpt = Options.boolean("force").pipe(Options.withAlias("f"))
const dryRunOpt = Options.boolean("dry-run")

interface PrStatus {
  state: "MERGED" | "OPEN" | "CLOSED"
  number: number
  mergedAt?: string
}

const getPrStatus = (
  branch: string,
  repoPath: string
): Effect.Effect<PrStatus | null, never, CommandExecutor.CommandExecutor> =>
  Shell.exec("gh", [
    "pr", "view", branch,
    "--repo", getOriginRepo(repoPath),
    "--json", "state,number,mergedAt"
  ]).pipe(
    Effect.map((r) => {
      try {
        return JSON.parse(r.stdout) as PrStatus
      } catch {
        return null
      }
    }),
    Effect.catchAll(() => Effect.succeed(null))
  )

/** Extract owner/repo from git remote origin */
const getOriginRepo = (repoPath: string): string => {
  // This is a sync fallback — gh will figure it out from cwd anyway
  return ""
}

export const gcCommand = Command.make(
  "gc",
  { force: forceOpt, dryRun: dryRunOpt },
  ({ force, dryRun }) =>
    Effect.gen(function* () {
      const config = yield* ConfigService
      const proxy = yield* ProxyService
      const executor = yield* CommandExecutor.CommandExecutor

      const run = <A, E>(effect: Effect.Effect<A, E, CommandExecutor.CommandExecutor>) =>
        Effect.provideService(effect, CommandExecutor.CommandExecutor, executor)

      const workspaces = yield* config.loadWorkspaces()

      if (workspaces.length === 0) {
        yield* Console.log(`  ${dim("No active workspaces.")}`)
        return
      }

      yield* Console.log("")
      yield* Console.log(`  Checking ${workspaces.length} workspace${workspaces.length === 1 ? "" : "s"}...`)
      yield* Console.log("")

      let cleaned = 0

      for (const ws of workspaces) {
        const projectConfig = yield* config.getProject(ws.project).pipe(
          Effect.catchAll(() => Effect.succeed(null))
        )

        // Check PR status via gh CLI (run from project dir)
        const cwd = projectConfig?.path ?? ws.path
        const prStatus = yield* run(
          Shell.exec("gh", ["pr", "view", ws.branch, "--json", "state,number,mergedAt"]).pipe(
            Effect.map((r) => {
              try { return JSON.parse(r.stdout) as PrStatus } catch { return null }
            }),
            Effect.catchAll(() => Effect.succeed(null))
          )
        )

        const prLabel = prStatus
          ? prStatus.state === "MERGED"
            ? `PR #${prStatus.number} ${green("merged")}${prStatus.mergedAt ? ` ${dim(timeAgo(prStatus.mergedAt))}` : ""}`
            : prStatus.state === "OPEN"
              ? `PR #${prStatus.number} ${blue("open")}`
              : `PR #${prStatus.number} ${yellow("closed")}`
          : dim("no PR")

        if (prStatus?.state === "MERGED") {
          if (dryRun) {
            yield* Console.log(`  ${ws.project}  ${bold(ws.branch.padEnd(22))} ${prLabel}  → ${yellow("would tear down")}`)
            cleaned++
          } else {
            const shouldClean = force || (yield* Prompt.confirm({
              message: `${ws.project}/${ws.branch} — ${prLabel}. Tear down?`
            }))

            if (shouldClean) {
              // Teardown
              yield* proxy.removeRoute(ws.proxyDomain).pipe(Effect.catchAll(() => Effect.void))
              if (projectConfig) {
                yield* run(Database.dropDb(
                  projectConfig.database.container, projectConfig.database.user, ws.dbName
                )).pipe(Effect.catchAll(() => Effect.void))
              }
              yield* run(Git.worktreeRemove(ws.path, true)).pipe(Effect.catchAll(() => Effect.void))
              yield* run(Git.deleteBranch(ws.branch)).pipe(Effect.catchAll(() => Effect.void))
              yield* config.removeWorkspace(ws.project, ws.branch)

              yield* Console.log(`  ${ws.project}  ${bold(ws.branch.padEnd(22))} ${prLabel}  → ${green("cleaned up")}`)
              cleaned++
            } else {
              yield* Console.log(`  ${ws.project}  ${bold(ws.branch.padEnd(22))} ${prLabel}  → ${dim("skipped")}`)
            }
          }
        } else {
          yield* Console.log(`  ${ws.project}  ${bold(ws.branch.padEnd(22))} ${prLabel}  → ${dim("keep")}`)
        }
      }

      yield* Console.log("")
      if (cleaned > 0) {
        const verb = dryRun ? "would clean up" : "cleaned up"
        yield* Console.log(`  ${green("✓")} ${verb} ${cleaned} workspace${cleaned === 1 ? "" : "s"}.`)
      } else {
        yield* Console.log(`  ${dim("Nothing to clean up.")}`)
      }
      yield* Console.log("")
    }).pipe(
      Effect.catchAll((e) =>
        Console.error(`\n  ${red("Error:")} ${"message" in e ? e.message : String(e)}\n`)
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
