import type { PlatformError } from "@effect/platform/Error"
import { Context, Effect, Layer } from "effect"
import { ShellService } from "./shell.js"

// ---------------------------------------------------------------------------
// GitService
// ---------------------------------------------------------------------------

export class GitService extends Context.Tag("GitService")<
  GitService,
  {
    readonly worktreeAdd: (path: string, branch: string, baseBranch?: string) => Effect.Effect<void, PlatformError>
    readonly worktreeRemove: (path: string, force: boolean) => Effect.Effect<void, PlatformError>
    readonly worktreeList: () => Effect.Effect<ReadonlyArray<{ path: string; branch: string }>, PlatformError>
    readonly deleteBranch: (branch: string) => Effect.Effect<void, PlatformError>
    readonly repoRoot: () => Effect.Effect<string, PlatformError>
    readonly currentBranch: () => Effect.Effect<string, PlatformError>
  }
>() {}

export const GitServiceLive = Layer.effect(
  GitService,
  Effect.gen(function* () {
    const shell = yield* ShellService

    const run = (args: ReadonlyArray<string>) => shell.exec("git", args)

    return GitService.of({
      worktreeAdd: (path, branch, baseBranch) =>
        Effect.gen(function* () {
          const branchExists = yield* run(["branch", "--list", branch]).pipe(
            Effect.map((r) => r.stdout.trim().length > 0)
          )
          if (branchExists) {
            yield* run(["worktree", "add", path, branch])
          } else {
            yield* run(["worktree", "add", "-b", branch, path, baseBranch ?? "HEAD"])
          }
        }).pipe(Effect.asVoid),

      worktreeRemove: (path, force) =>
        run(["worktree", "remove", ...(force ? ["--force"] : []), path]).pipe(Effect.asVoid),

      worktreeList: () =>
        run(["worktree", "list", "--porcelain"]).pipe(
          Effect.map((r) => {
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
        ),

      deleteBranch: (branch) =>
        run(["branch", "-D", branch]).pipe(Effect.asVoid),

      repoRoot: () =>
        run(["rev-parse", "--show-toplevel"]).pipe(Effect.map((r) => r.stdout.trim())),

      currentBranch: () =>
        run(["branch", "--show-current"]).pipe(Effect.map((r) => r.stdout.trim()))
    })
  })
)
