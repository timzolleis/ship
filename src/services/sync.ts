import { Effect } from "effect"
import type { ShellExecError } from "../errors.js"
import type { ProjectConfig } from "../schema/config.js"
import { GitService } from "./git.js"
import { ShellService } from "./shell.js"
import { DatabaseService } from "./database.js"

// ---------------------------------------------------------------------------
// SyncService
// ---------------------------------------------------------------------------

export interface SyncResult {
  readonly fetched: boolean
  readonly pulled: boolean
  readonly headMoved: boolean
  readonly installed: boolean
  readonly migrated: boolean
  readonly skippedPull?: string
}

export class SyncService extends Effect.Service<SyncService>()("SyncService", {
  effect: Effect.gen(function* () {
    const git = yield* GitService
    const shell = yield* ShellService
    const db = yield* DatabaseService

    const sync: (config: ProjectConfig) => Effect.Effect<SyncResult, ShellExecError> =
      Effect.fn("SyncService.sync")(function* (config) {
        const repoPath = config.path

        // 1. Fetch origin
        yield* git.fetch(repoPath)

        // 2. Fast-forward main (skip if dirty or non-ff)
        const dirty = yield* git.isDirty(repoPath)
        if (dirty) {
          return {
            fetched: true, pulled: false, headMoved: false,
            installed: false, migrated: false,
            skippedPull: "working tree has uncommitted changes"
          }
        }

        const before = yield* git.revParseHead(repoPath)
        const pullOk = yield* git.pullFfOnly(repoPath).pipe(
          Effect.as(true),
          Effect.catchTag("ShellExecError", () => Effect.succeed(false))
        )
        if (!pullOk) {
          return {
            fetched: true, pulled: false, headMoved: false,
            installed: false, migrated: false,
            skippedPull: "cannot fast-forward (main has diverged)"
          }
        }

        const after = yield* git.revParseHead(repoPath)
        const headMoved = before !== after

        // 3. Only install/generate/migrate if HEAD moved
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
            const running = yield* db.isContainerRunning(config.database.container)
            if (running) {
              yield* shell.execInDir(repoPath, config.commands.migrate)
              migrated = true
            }
          }
        }

        return { fetched: true, pulled: true, headMoved, installed, migrated }
      })

    return { sync }
  }),
  dependencies: [GitService.Default, ShellService.Default, DatabaseService.Default]
}) {}
