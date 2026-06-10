import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Ref, Schema } from "effect"
import {
  CommandsConfig,
  DatabaseConfig,
  EnvConfig,
  ExecutionRuntime,
  ProjectConfig,
  WorktreeConfig,
} from "../../src/schema/config.js"
import { DbName, RepoPath } from "../../src/schema/ids.js"
import { DatabaseService } from "../../src/services/database.js"
import { GitService, type MemoryRepoState } from "../../src/services/git.js"
import { ShellService, type ShellCall } from "../../src/services/shell.js"
import { SyncService } from "../../src/services/sync.js"

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const repo = Schema.decodeSync(RepoPath)("/repo")
const local: ExecutionRuntime = { _tag: "local" }

const makeConfig = (commands: {
  install?: string
  generate?: string
  migrate?: string
}): ProjectConfig =>
  new ProjectConfig({
    path: repo,
    database: new DatabaseConfig({
      runtime: local,
      user: "app",
      source: Schema.decodeSync(DbName)("app_dev"),
      host: "localhost",
      port: 5432,
    }),
    commands: new CommandsConfig(commands),
    env: new EnvConfig({ files: [], autoDetected: {} }),
    worktree: new WorktreeConfig({
      dirPattern: "x",
      proxyDomainPattern: "x",
      dbNamePattern: "x",
    }),
  })

// ---------------------------------------------------------------------------
// Sync is an orchestrator: D7 forbids it a layerMemory; we compose its REAL
// layer over in-memory leaves and assert the wiring. The git seam is driven
// through GitService.layerMemory — its MemoryRepoState models dirty-tree,
// non-ff pull, update failure, and HEAD movement (headAfterPull) so headMoved
// gating is exercised through the public memory adapter (never a hand-rolled
// GitService stub).
// ---------------------------------------------------------------------------

const run = <A, E>(
  repoState: Partial<MemoryRepoState>,
  body: (
    sync: SyncService["Type"],
    shellCalls: Ref.Ref<ReadonlyArray<ShellCall>>
  ) => Effect.Effect<A, E>,
  opts?: { ping?: boolean }
) =>
  Effect.gen(function* () {
    const shellCalls = yield* Ref.make<ReadonlyArray<ShellCall>>([])
    const program = Effect.gen(function* () {
      const sync = yield* SyncService
      return yield* body(sync, shellCalls)
    })
    const dbLayer =
      opts?.ping === false
        ? DatabaseService.layerMemory([], { reachable: false })
        : DatabaseService.layerMemory([])
    return yield* program.pipe(
      Effect.provide(
        SyncService.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              GitService.layerMemory(repoState),
              ShellService.layerMemory({ calls: shellCalls }),
              dbLayer
            )
          )
        )
      )
    )
  })

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SyncService.layer (real orchestrator over memory leaves)", () => {
  it.effect("dirty tree → skippedPull, no pull, no install", () =>
    run({ dirty: true }, (sync, shellCalls) =>
      Effect.gen(function* () {
        const r = yield* sync.sync(makeConfig({ install: "npm i" }))
        assert.strictEqual(r.fetched, true)
        assert.strictEqual(r.pulled, false)
        assert.strictEqual(r.headMoved, false)
        assert.strictEqual(r.installed, false)
        assert.isDefined(r.skippedPull)
        const calls = yield* Ref.get(shellCalls)
        assert.deepStrictEqual(calls, [])
      })
    )
  )

  it.effect("non-ff pull → skippedPull, no install", () =>
    run({ dirty: false, pullFailsNonFf: true }, (sync, shellCalls) =>
      Effect.gen(function* () {
        const r = yield* sync.sync(makeConfig({ install: "npm i" }))
        assert.strictEqual(r.pulled, false)
        assert.strictEqual(r.headMoved, false)
        assert.strictEqual(r.installed, false)
        assert.isDefined(r.skippedPull)
        const calls = yield* Ref.get(shellCalls)
        assert.deepStrictEqual(calls, [])
      })
    )
  )

  it.effect("headMoved false → pulled but no install/generate/migrate", () =>
    run(
      { dirty: false, head: "same", headAfterPull: "same" },
      (sync, shellCalls) =>
        Effect.gen(function* () {
          const r = yield* sync.sync(
            makeConfig({ install: "npm i", generate: "gen", migrate: "mig" })
          )
          assert.strictEqual(r.pulled, true)
          assert.strictEqual(r.headMoved, false)
          assert.strictEqual(r.installed, false)
          assert.strictEqual(r.migrated, false)
          const calls = yield* Ref.get(shellCalls)
          assert.deepStrictEqual(calls, [])
        })
    )
  )

  it.effect("headMoved true → install+generate run; migrate runs (ping true)", () =>
    run(
      { dirty: false, head: "old", headAfterPull: "new" },
      (sync, shellCalls) =>
        Effect.gen(function* () {
          const r = yield* sync.sync(
            makeConfig({ install: "npm i", generate: "gen", migrate: "mig" })
          )
          assert.strictEqual(r.headMoved, true)
          assert.strictEqual(r.installed, true)
          assert.strictEqual(r.migrated, true)
          const calls = yield* Ref.get(shellCalls)
          // install, generate, migrate each via execInDir(repo, cmd) → recorded
          // as a ShellCall with the command string and cwd = repo.
          assert.deepStrictEqual(
            calls.map((c) => ({ command: c.command, cwd: c.cwd })),
            [
              { command: "npm i", cwd: "/repo" },
              { command: "gen", cwd: "/repo" },
              { command: "mig", cwd: "/repo" },
            ]
          )
        })
    )
  )

  it.effect("headMoved true but ping false → install/generate run, migrate skipped", () =>
    run(
      { dirty: false, head: "old", headAfterPull: "new" },
      (sync, shellCalls) =>
        Effect.gen(function* () {
          const r = yield* sync.sync(
            makeConfig({ install: "npm i", generate: "gen", migrate: "mig" })
          )
          assert.strictEqual(r.headMoved, true)
          assert.strictEqual(r.installed, true)
          assert.strictEqual(r.migrated, false)
          const calls = yield* Ref.get(shellCalls)
          assert.deepStrictEqual(
            calls.map((c) => c.command),
            ["npm i", "gen"]
          )
        }),
      { ping: false }
    )
  )

  it.effect("custom baseBranch: updateBranch path, headMoved from before/after revParse", () =>
    run(
      { head: "b0", headAfterPull: "b1" },
      (sync, shellCalls) =>
        Effect.gen(function* () {
          const r = yield* sync.sync(makeConfig({ install: "npm i" }), "release/1")
          assert.strictEqual(r.pulled, true)
          assert.strictEqual(r.headMoved, true)
          // No install/generate/migrate on custom-base path.
          assert.strictEqual(r.installed, false)
          const sCalls = yield* Ref.get(shellCalls)
          assert.deepStrictEqual(sCalls, [])
        })
    )
  )

  it.effect("custom baseBranch: updateBranch fails → skippedPull", () =>
    run({ updateFails: true }, (sync) =>
      Effect.gen(function* () {
        const r = yield* sync.sync(makeConfig({}), "release/1")
        assert.strictEqual(r.pulled, false)
        assert.strictEqual(r.headMoved, false)
        assert.isDefined(r.skippedPull)
      })
    )
  )
})
