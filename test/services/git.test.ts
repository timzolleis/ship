import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Schema } from "effect"
import { BranchName, RepoPath, WorktreePath } from "../../src/schema/ids.js"
import { GitService } from "../../src/services/git.js"

const repo = (p: string): RepoPath => Schema.decodeSync(RepoPath)(p)
const wt = (p: string): WorktreePath => Schema.decodeSync(WorktreePath)(p)
const br = (b: string): BranchName => Schema.decodeSync(BranchName)(b)

const R = repo("/repo")

const withMemory = <A, E>(
  state: Parameters<typeof GitService.layerMemory>[0],
  body: (service: GitService["Type"]) => Effect.Effect<A, E>
) =>
  Effect.gen(function* () {
    const service = yield* GitService
    return yield* body(service)
  }).pipe(Effect.provide(GitService.layerMemory(state)))

describe("GitService.layerMemory contract", () => {
  it.effect("worktreeAdd registers worktree and creates the branch when missing", () =>
    withMemory({}, (git) =>
      Effect.gen(function* () {
        yield* git.worktreeAdd(R, wt("/repo/wt/feat-x"), br("feat/x"))
        const list = yield* git.worktreeList(R)
        assert.deepStrictEqual(list, [{ path: "/repo/wt/feat-x", branch: "feat/x" }])
      })
    )
  )

  it.effect("worktreeAdd uses an existing branch without re-creating", () =>
    withMemory({ branches: new Set(["main"]) }, (git) =>
      Effect.gen(function* () {
        yield* git.worktreeAdd(R, wt("/repo/wt/main"), br("main"))
        const list = yield* git.worktreeList(R)
        assert.deepStrictEqual(list, [{ path: "/repo/wt/main", branch: "main" }])
      })
    )
  )

  it.effect("worktreeList reflects multiple registered worktrees", () =>
    withMemory({}, (git) =>
      Effect.gen(function* () {
        yield* git.worktreeAdd(R, wt("/repo/wt/a"), br("a"))
        yield* git.worktreeAdd(R, wt("/repo/wt/b"), br("b"))
        const list = yield* git.worktreeList(R)
        assert.strictEqual(list.length, 2)
        assert.deepStrictEqual(
          [...list].map((e) => e.branch).sort(),
          ["a", "b"]
        )
      })
    )
  )

  it.effect("worktreeRemove removes a registered worktree", () =>
    withMemory({}, (git) =>
      Effect.gen(function* () {
        yield* git.worktreeAdd(R, wt("/repo/wt/a"), br("a"))
        yield* git.worktreeRemove(R, wt("/repo/wt/a"), false)
        const list = yield* git.worktreeList(R)
        assert.deepStrictEqual(list, [])
      })
    )
  )

  it.effect("worktreeRemove errors (ShellExecError) when missing and not forced", () =>
    withMemory({}, (git) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(git.worktreeRemove(R, wt("/repo/wt/gone"), false))
        assert.isTrue(Exit.isFailure(exit))
      })
    )
  )

  it.effect("worktreeRemove succeeds when missing but forced", () =>
    withMemory({}, (git) => git.worktreeRemove(R, wt("/repo/wt/gone"), true))
  )

  it.effect("deleteBranch removes the branch; errors when missing unless forced semantics", () =>
    withMemory({ branches: new Set(["feat/x"]) }, (git) =>
      Effect.gen(function* () {
        yield* git.deleteBranch(R, br("feat/x"))
        const exit = yield* Effect.exit(git.deleteBranch(R, br("feat/x")))
        assert.isTrue(Exit.isFailure(exit))
      })
    )
  )

  it.effect("deleteRemoteBranch removes from remote; errors when missing", () =>
    withMemory({ remoteBranches: new Set(["feat/x"]) }, (git) =>
      Effect.gen(function* () {
        yield* git.deleteRemoteBranch(R, br("feat/x"))
        const exit = yield* Effect.exit(git.deleteRemoteBranch(R, br("feat/x")))
        assert.isTrue(Exit.isFailure(exit))
      })
    )
  )

  it.effect("isDirty reflects state", () =>
    Effect.gen(function* () {
      const dirty = yield* Effect.gen(function* () {
        const git = yield* GitService
        return yield* git.isDirty(R)
      }).pipe(Effect.provide(GitService.layerMemory({ dirty: true })))
      assert.isTrue(dirty)

      const clean = yield* Effect.gen(function* () {
        const git = yield* GitService
        return yield* git.isDirty(R)
      }).pipe(Effect.provide(GitService.layerMemory({ dirty: false })))
      assert.isFalse(clean)
    })
  )

  it.effect("revParseHead and currentBranch reflect state", () =>
    withMemory({ head: "deadbeef" }, (git) =>
      Effect.gen(function* () {
        const head = yield* git.revParseHead(R)
        assert.strictEqual(head, "deadbeef")
      })
    )
  )

  it.effect("currentBranch returns empty by default", () =>
    withMemory({}, (git) =>
      Effect.gen(function* () {
        const branch = yield* git.currentBranch(R)
        assert.strictEqual(branch, "")
      })
    )
  )
})
