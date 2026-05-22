import { FileSystem, Path } from "@effect/platform"
import { Effect } from "effect"

// ---------------------------------------------------------------------------
// ClaudeService — manages Claude Code's per-project conversation transcripts
// ---------------------------------------------------------------------------
//
// Claude Code stores conversation transcripts under
//   ~/.claude/projects/<slug>/
// where <slug> is the absolute path with `/` replaced by `-`.
// e.g. /Users/tim/IdeaProjects/elternportal-tim-ep-241
//   →  -Users-tim-IdeaProjects-elternportal-tim-ep-241
//
// When a workspace is torn down, the worktree directory is removed but the
// transcripts for that directory remain orphaned. This service cleans them up.

export class ClaudeService extends Effect.Service<ClaudeService>()("ClaudeService", {
  effect: Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const pathSvc = yield* Path.Path

    const home = process.env.HOME ?? process.env.USERPROFILE ?? "~"
    const projectsDir = pathSvc.join(home, ".claude", "projects")

    const slugFor = (absPath: string): string => absPath.replaceAll("/", "-")

    /**
     * Remove the Claude Code conversation directory for the given absolute path.
     * Resolves to `true` if a directory was removed, `false` if none existed.
     * Errors are swallowed (best-effort cleanup) — callers don't need to handle them.
     */
    const removeProjectConvo = (absPath: string): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const convoDir = pathSvc.join(projectsDir, slugFor(absPath))
        const exists = yield* fs.exists(convoDir).pipe(Effect.catchAll(() => Effect.succeed(false)))
        if (!exists) return false
        const removed = yield* fs.remove(convoDir, { recursive: true }).pipe(
          Effect.as(true),
          Effect.catchAll(() => Effect.succeed(false))
        )
        return removed
      })

    return { removeProjectConvo } as const
  }),
  dependencies: []
}) {}
