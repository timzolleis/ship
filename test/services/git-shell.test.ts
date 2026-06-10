import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Ref, Schema } from "effect"
import { BranchName, RepoPath, WorktreePath } from "../../src/schema/ids.js"
import { GitService } from "../../src/services/git.js"
import { ShellService, type ExecResult, type ShellCall } from "../../src/services/shell.js"

// ---------------------------------------------------------------------------
// GitService prod `layer` over ShellService.layerMemory — asserts the EXACT
// git argv each method constructs, the way database-postgres.test.ts asserts
// the postgres adapter and runner.test.ts asserts CommandRunner. A regression
// in any of these argv strings (worktree precedence, porcelain parsing flags,
// branch/push/fetch refspecs) would otherwise pass the suite undetected.
// ---------------------------------------------------------------------------

const R = Schema.decodeSync(RepoPath)("/repo")
const wt = (p: string): WorktreePath => Schema.decodeSync(WorktreePath)(p)
const br = (b: string): BranchName => Schema.decodeSync(BranchName)(b)

const ok = (stdout = ""): ExecResult => ({ stdout, stderr: "", exitCode: 0 })

// Run GitService.layer over a recording memory shell with a stub keyed on argv.
const withGit = <A, E>(
  stub: (call: ShellCall) => ExecResult,
  body: (git: GitService["Type"], calls: Ref.Ref<ReadonlyArray<ShellCall>>) => Effect.Effect<A, E>
) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<ShellCall>>([])
    return yield* Effect.gen(function* () {
      const git = yield* GitService
      return yield* body(git, calls)
    }).pipe(
      Effect.provide(
        GitService.layer.pipe(
          Layer.provide(ShellService.layerMemory({ calls, stub }))
        )
      )
    )
  })

// Argv after the leading ["-C", "/repo", ...].
const gitArgs = (calls: ReadonlyArray<ShellCall>) =>
  calls
    .filter((c) => c.command === "git")
    .map((c) => c.args.slice(2))

describe("GitService.layer argv mapping (over memory shell)", () => {
  it.effect("worktreeList passes --porcelain and parses worktree/branch pairs", () =>
    withGit(
      () =>
        ok(
          [
            "worktree /repo",
            "HEAD abc",
            "branch refs/heads/main",
            "",
            "worktree /repo/wt/feat-x",
            "HEAD def",
            "branch refs/heads/feat/x",
          ].join("\n")
        ),
      (git, calls) =>
        Effect.gen(function* () {
          const list = yield* git.worktreeList(R)
          assert.deepStrictEqual(list, [
            { path: "/repo", branch: "main" },
            { path: "/repo/wt/feat-x", branch: "feat/x" },
          ])
          assert.deepStrictEqual(gitArgs(yield* Ref.get(calls)), [
            ["worktree", "list", "--porcelain"],
          ])
        })
    )
  )

  it.effect("worktreeAdd (local branch exists) → worktree add <path> <branch>", () =>
    withGit(
      (c) => {
        // `branch --list <branch>` (no -r) reports the local branch exists.
        if (c.args.includes("--list") && !c.args.includes("-r")) return ok("  feat/x\n")
        return ok()
      },
      (git, calls) =>
        Effect.gen(function* () {
          yield* git.worktreeAdd(R, wt("/repo/wt/feat-x"), br("feat/x"))
          const args = gitArgs(yield* Ref.get(calls))
          assert.deepStrictEqual(args, [
            ["worktree", "prune"],
            ["branch", "--list", "feat/x"],
            ["worktree", "add", "/repo/wt/feat-x", "feat/x"],
          ])
        })
    )
  )

  it.effect("worktreeAdd (remote branch exists) → checks -r then worktree add <path> <branch>", () =>
    withGit(
      (c) => {
        // local absent, remote present.
        if (c.args.includes("--list") && c.args.includes("-r")) return ok("  origin/feat/x\n")
        return ok()
      },
      (git, calls) =>
        Effect.gen(function* () {
          yield* git.worktreeAdd(R, wt("/repo/wt/feat-x"), br("feat/x"))
          const args = gitArgs(yield* Ref.get(calls))
          assert.deepStrictEqual(args, [
            ["worktree", "prune"],
            ["branch", "--list", "feat/x"],
            ["branch", "--list", "-r", "*/feat/x"],
            ["worktree", "add", "/repo/wt/feat-x", "feat/x"],
          ])
        })
    )
  )

  it.effect("worktreeAdd (no branch) → worktree add -b <branch> <path> <base>", () =>
    withGit(
      () => ok(), // every branch --list empty → create branch
      (git, calls) =>
        Effect.gen(function* () {
          yield* git.worktreeAdd(R, wt("/repo/wt/feat-x"), br("feat/x"), "develop")
          const args = gitArgs(yield* Ref.get(calls))
          assert.deepStrictEqual(args, [
            ["worktree", "prune"],
            ["branch", "--list", "feat/x"],
            ["branch", "--list", "-r", "*/feat/x"],
            ["worktree", "add", "-b", "feat/x", "/repo/wt/feat-x", "develop"],
          ])
        })
    )
  )

  it.effect("worktreeAdd without base defaults to HEAD", () =>
    withGit(
      () => ok(),
      (git, calls) =>
        Effect.gen(function* () {
          yield* git.worktreeAdd(R, wt("/repo/wt/feat-x"), br("feat/x"))
          const args = gitArgs(yield* Ref.get(calls))
          assert.deepStrictEqual(args[args.length - 1], [
            "worktree",
            "add",
            "-b",
            "feat/x",
            "/repo/wt/feat-x",
            "HEAD",
          ])
        })
    )
  )

  it.effect("worktreeRemove forced adds --force before the path", () =>
    withGit(
      () => ok(),
      (git, calls) =>
        Effect.gen(function* () {
          yield* git.worktreeRemove(R, wt("/repo/wt/feat-x"), true)
          assert.deepStrictEqual(gitArgs(yield* Ref.get(calls)), [
            ["worktree", "remove", "--force", "/repo/wt/feat-x"],
          ])
        })
    )
  )

  it.effect("worktreeRemove unforced omits --force", () =>
    withGit(
      () => ok(),
      (git, calls) =>
        Effect.gen(function* () {
          yield* git.worktreeRemove(R, wt("/repo/wt/feat-x"), false)
          assert.deepStrictEqual(gitArgs(yield* Ref.get(calls)), [
            ["worktree", "remove", "/repo/wt/feat-x"],
          ])
        })
    )
  )

  it.effect("deleteBranch → branch -D <branch>", () =>
    withGit(
      () => ok(),
      (git, calls) =>
        Effect.gen(function* () {
          yield* git.deleteBranch(R, br("feat/x"))
          assert.deepStrictEqual(gitArgs(yield* Ref.get(calls)), [["branch", "-D", "feat/x"]])
        })
    )
  )

  it.effect("deleteRemoteBranch → push origin --delete <branch>", () =>
    withGit(
      () => ok(),
      (git, calls) =>
        Effect.gen(function* () {
          yield* git.deleteRemoteBranch(R, br("feat/x"))
          assert.deepStrictEqual(gitArgs(yield* Ref.get(calls)), [
            ["push", "origin", "--delete", "feat/x"],
          ])
        })
    )
  )

  it.effect("fetch → fetch origin", () =>
    withGit(
      () => ok(),
      (git, calls) =>
        Effect.gen(function* () {
          yield* git.fetch(R)
          assert.deepStrictEqual(gitArgs(yield* Ref.get(calls)), [["fetch", "origin"]])
        })
    )
  )

  it.effect("pullFfOnly → pull --ff-only", () =>
    withGit(
      () => ok(),
      (git, calls) =>
        Effect.gen(function* () {
          yield* git.pullFfOnly(R)
          assert.deepStrictEqual(gitArgs(yield* Ref.get(calls)), [["pull", "--ff-only"]])
        })
    )
  )

  it.effect("updateBranch → fetch origin <branch>:<branch>", () =>
    withGit(
      () => ok(),
      (git, calls) =>
        Effect.gen(function* () {
          yield* git.updateBranch(R, "release/1")
          assert.deepStrictEqual(gitArgs(yield* Ref.get(calls)), [
            ["fetch", "origin", "release/1:release/1"],
          ])
        })
    )
  )

  it.effect("isDirty → status --porcelain, trims to boolean", () =>
    withGit(
      () => ok(" M file.ts\n"),
      (git, calls) =>
        Effect.gen(function* () {
          const dirty = yield* git.isDirty(R)
          assert.isTrue(dirty)
          assert.deepStrictEqual(gitArgs(yield* Ref.get(calls)), [["status", "--porcelain"]])
        })
    )
  )

  it.effect("revParseHead and revParse pass the right refs and trim", () =>
    withGit(
      () => ok("abc123\n"),
      (git, calls) =>
        Effect.gen(function* () {
          assert.strictEqual(yield* git.revParseHead(R), "abc123")
          assert.strictEqual(yield* git.revParse(R, "origin/main"), "abc123")
          assert.deepStrictEqual(gitArgs(yield* Ref.get(calls)), [
            ["rev-parse", "HEAD"],
            ["rev-parse", "origin/main"],
          ])
        })
    )
  )

  it.effect("repoRoot and currentBranch pass the right argv and trim", () =>
    withGit(
      (c) =>
        c.args.includes("--show-toplevel") ? ok("/repo\n") : ok("main\n"),
      (git, calls) =>
        Effect.gen(function* () {
          assert.strictEqual(yield* git.repoRoot("/repo"), "/repo")
          assert.strictEqual(yield* git.currentBranch(R), "main")
          assert.deepStrictEqual(gitArgs(yield* Ref.get(calls)), [
            ["rev-parse", "--show-toplevel"],
            ["branch", "--show-current"],
          ])
        })
    )
  )
})
