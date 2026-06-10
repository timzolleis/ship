import { Context, Effect, Layer } from "effect"
import type { ShellExecError } from "../errors.js"
import type { ProjectConfig } from "../schema/config.js"
import { DatabaseService } from "./database.js"
import { GitService } from "./git.js"
import { ShellService } from "./shell.js"

// ---------------------------------------------------------------------------
// SyncService — Tier 3 orchestrator (D7: real `layer` only, no layerMemory).
// Fast-forwards the project's base checkout, then (only when HEAD moved) runs
// install/generate and — when the database is reachable (ping) — migrate.
// ---------------------------------------------------------------------------

export interface SyncResult {
  readonly fetched: boolean
  readonly pulled: boolean
  readonly headMoved: boolean
  readonly installed: boolean
  readonly migrated: boolean
  readonly skippedPull?: string
}

export interface SyncShape {
  readonly sync: (
    config: ProjectConfig,
    base?: string
  ) => Effect.Effect<SyncResult, ShellExecError>
}

export class SyncService extends Context.Tag("ship/SyncService")<
  SyncService,
  SyncShape
>() {
  static layer: Layer.Layer<
    SyncService,
    never,
    GitService | ShellService | DatabaseService
  > = Layer.effect(
    SyncService,
    Effect.gen(function* () {
      const git = yield* GitService
      const shell = yield* ShellService
      const db = yield* DatabaseService

      const sync: SyncShape["sync"] = Effect.fn("SyncService.sync")(
        function* (config, baseBranch) {
          const repoPath = config.path

          // 1. Fetch origin.
          yield* git.fetch(repoPath)

          // 2a. Custom base: fast-forward that branch ref directly (no checkout).
          if (baseBranch) {
            const before = yield* git.revParse(repoPath, baseBranch).pipe(
              Effect.catchTag("ShellExecError", () => Effect.succeed(""))
            )
            const updateOk = yield* git.updateBranch(repoPath, baseBranch).pipe(
              Effect.as(true),
              Effect.catchTag("ShellExecError", () => Effect.succeed(false))
            )
            if (!updateOk) {
              return {
                fetched: true,
                pulled: false,
                headMoved: false,
                installed: false,
                migrated: false,
                skippedPull: `could not fast-forward ${baseBranch}`,
              }
            }
            const after = yield* git.revParse(repoPath, baseBranch).pipe(
              Effect.catchTag("ShellExecError", () => Effect.succeed(""))
            )
            return {
              fetched: true,
              pulled: true,
              headMoved: before !== after,
              installed: false,
              migrated: false,
            }
          }

          // 2b. Default: fast-forward main (skip if dirty or non-ff).
          const dirty = yield* git.isDirty(repoPath)
          if (dirty) {
            return {
              fetched: true,
              pulled: false,
              headMoved: false,
              installed: false,
              migrated: false,
              skippedPull: "working tree has uncommitted changes",
            }
          }

          const before = yield* git.revParseHead(repoPath)
          const pullOk = yield* git.pullFfOnly(repoPath).pipe(
            Effect.as(true),
            Effect.catchTag("ShellExecError", () => Effect.succeed(false))
          )
          if (!pullOk) {
            return {
              fetched: true,
              pulled: false,
              headMoved: false,
              installed: false,
              migrated: false,
              skippedPull: "cannot fast-forward (main has diverged)",
            }
          }

          const after = yield* git.revParseHead(repoPath)
          const headMoved = before !== after

          // 3. Only install/generate/migrate when HEAD moved.
          let installed = false
          let migrated = false

          if (headMoved) {
            if (config.commands.install) {
              yield* shell.execInDir(repoPath, config.commands.install)
              installed = true
            }
            if (config.commands.generate) {
              yield* shell.execInDir(repoPath, config.commands.generate)
            }
            if (config.commands.migrate) {
              const running = yield* db.ping({
                runtime: config.database.runtime,
                user: config.database.user,
              })
              if (running) {
                yield* shell.execInDir(repoPath, config.commands.migrate)
                migrated = true
              }
            }
          }

          return { fetched: true, pulled: true, headMoved, installed, migrated }
        }
      )

      return { sync }
    })
  )
}
