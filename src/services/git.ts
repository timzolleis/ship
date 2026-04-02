import { Effect } from "effect"
import type { ShellExecError } from "../errors.js"
import { ShellService } from "./shell.js"
import type { ExecResult } from "./shell.js"

// ---------------------------------------------------------------------------
// GitService
// ---------------------------------------------------------------------------

export class GitService extends Effect.Service<GitService>()("GitService", {
  effect: Effect.gen(function* () {
    const shell = yield* ShellService

    const run = (repoPath: string, args: ReadonlyArray<string>): Effect.Effect<ExecResult, ShellExecError> =>
      shell.exec("git", ["-C", repoPath, ...args]).pipe(
        Effect.tap((r) => Effect.logDebug("git", { args, stdout: r.stdout.trim() })),
        Effect.tapError((e) => Effect.logDebug("git failed", { args, error: e }))
      )

    const worktreeAdd: (repoPath: string, path: string, branch: string, baseBranch?: string) => Effect.Effect<void, ShellExecError> =
      Effect.fn("GitService.worktreeAdd")(function* (repoPath, path, branch, baseBranch) {
        yield* run(repoPath, ["worktree", "prune"]).pipe(Effect.catchAll(() => Effect.void))
        const localExists = yield* run(repoPath, ["branch", "--list", branch]).pipe(
          Effect.map((r) => r.stdout.trim().length > 0)
        )
        if (localExists) {
          yield* run(repoPath, ["worktree", "add", path, branch])
        } else {
          const remoteExists = yield* run(repoPath, ["branch", "--list", "-r", `*/${branch}`]).pipe(
            Effect.map((r) => r.stdout.trim().length > 0)
          )
          if (remoteExists) {
            yield* run(repoPath, ["worktree", "add", path, branch])
          } else {
            yield* run(repoPath, ["worktree", "add", "-b", branch, path, baseBranch ?? "HEAD"])
          }
        }
      })

    const worktreeRemove: (repoPath: string, path: string, force: boolean) => Effect.Effect<void, ShellExecError> =
      Effect.fn("GitService.worktreeRemove")(function* (repoPath, path, force) {
        yield* run(repoPath, ["worktree", "remove", ...(force ? ["--force"] : []), path])
      })

    const worktreeList: (repoPath: string) => Effect.Effect<ReadonlyArray<{ path: string; branch: string }>, ShellExecError> =
      Effect.fn("GitService.worktreeList")(function* (repoPath) {
        const r = yield* run(repoPath, ["worktree", "list", "--porcelain"])
        const entries: Array<{ path: string; branch: string }> = []
        let currentPath = ""
        for (const line of r.stdout.split("\n")) {
          if (line.startsWith("worktree ")) {
            currentPath = line.slice("worktree ".length)
          }
          if (line.startsWith("branch refs/heads/")) {
            entries.push({ path: currentPath, branch: line.slice("branch refs/heads/".length) })
          }
        }
        return entries
      })

    const deleteBranch: (repoPath: string, branch: string) => Effect.Effect<void, ShellExecError> =
      Effect.fn("GitService.deleteBranch")(function* (repoPath, branch) {
        yield* run(repoPath, ["branch", "-D", branch])
      })

    const repoRoot: (repoPath: string) => Effect.Effect<string, ShellExecError> =
      Effect.fn("GitService.repoRoot")(function* (repoPath) {
        const r = yield* run(repoPath, ["rev-parse", "--show-toplevel"])
        return r.stdout.trim()
      })

    const currentBranch: (repoPath: string) => Effect.Effect<string, ShellExecError> =
      Effect.fn("GitService.currentBranch")(function* (repoPath) {
        const r = yield* run(repoPath, ["branch", "--show-current"])
        return r.stdout.trim()
      })

    const fetch: (repoPath: string) => Effect.Effect<void, ShellExecError> =
      Effect.fn("GitService.fetch")(function* (repoPath) {
        yield* run(repoPath, ["fetch", "origin"])
      })

    const pullFfOnly: (repoPath: string) => Effect.Effect<void, ShellExecError> =
      Effect.fn("GitService.pullFfOnly")(function* (repoPath) {
        yield* run(repoPath, ["pull", "--ff-only"])
      })

    const isDirty: (repoPath: string) => Effect.Effect<boolean, ShellExecError> =
      Effect.fn("GitService.isDirty")(function* (repoPath) {
        const r = yield* run(repoPath, ["status", "--porcelain"])
        return r.stdout.trim().length > 0
      })

    const revParseHead: (repoPath: string) => Effect.Effect<string, ShellExecError> =
      Effect.fn("GitService.revParseHead")(function* (repoPath) {
        const r = yield* run(repoPath, ["rev-parse", "HEAD"])
        return r.stdout.trim()
      })

    const revParse: (repoPath: string, ref: string) => Effect.Effect<string, ShellExecError> =
      Effect.fn("GitService.revParse")(function* (repoPath, ref) {
        const r = yield* run(repoPath, ["rev-parse", ref])
        return r.stdout.trim()
      })

    /** Fast-forward a local branch ref to match origin (works for non-checked-out branches). */
    const updateBranch: (repoPath: string, branch: string) => Effect.Effect<void, ShellExecError> =
      Effect.fn("GitService.updateBranch")(function* (repoPath, branch) {
        yield* run(repoPath, ["fetch", "origin", `${branch}:${branch}`])
      })

    return {
      worktreeAdd, worktreeRemove, worktreeList, deleteBranch, repoRoot, currentBranch,
      fetch, pullFfOnly, isDirty, revParseHead, revParse, updateBranch
    }
  }),
  dependencies: [ShellService.Default]
}) {}
