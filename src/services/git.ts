import { CommandExecutor } from "@effect/platform"
import type { PlatformError } from "@effect/platform/Error"
import { Effect } from "effect"
import * as Shell from "./shell.js"

// ---------------------------------------------------------------------------
// Git operations — thin wrappers, require CommandExecutor
// ---------------------------------------------------------------------------

export type GitError = PlatformError

const run = (args: ReadonlyArray<string>) => Shell.exec("git", args)

export const worktreeAdd = (
  path: string,
  branch: string,
  baseBranch?: string
): Effect.Effect<void, GitError, CommandExecutor.CommandExecutor> =>
  Effect.gen(function* () {
    // Check if branch exists locally
    const branchExists = yield* run(["branch", "--list", branch]).pipe(
      Effect.map((r) => r.stdout.trim().length > 0)
    )
    if (branchExists) {
      yield* run(["worktree", "add", path, branch])
    } else {
      yield* run(["worktree", "add", "-b", branch, path, baseBranch ?? "HEAD"])
    }
  }).pipe(Effect.asVoid)

export const worktreeRemove = (
  path: string,
  force: boolean
): Effect.Effect<void, GitError, CommandExecutor.CommandExecutor> =>
  run(["worktree", "remove", ...(force ? ["--force"] : []), path]).pipe(Effect.asVoid)

export const worktreeList = (): Effect.Effect<
  ReadonlyArray<{ path: string; branch: string }>,
  GitError,
  CommandExecutor.CommandExecutor
> =>
  run(["worktree", "list", "--porcelain"]).pipe(
    Effect.map((r) => {
      const entries: { path: string; branch: string }[] = []
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
  )

export const deleteBranch = (
  branch: string
): Effect.Effect<void, GitError, CommandExecutor.CommandExecutor> =>
  run(["branch", "-D", branch]).pipe(Effect.asVoid)

export const repoRoot = (): Effect.Effect<string, GitError, CommandExecutor.CommandExecutor> =>
  run(["rev-parse", "--show-toplevel"]).pipe(
    Effect.map((r) => r.stdout.trim())
  )

export const currentBranch = (): Effect.Effect<string, GitError, CommandExecutor.CommandExecutor> =>
  run(["branch", "--show-current"]).pipe(
    Effect.map((r) => r.stdout.trim())
  )
