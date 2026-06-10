import { Context, Effect, Layer, Ref } from "effect"
import { ShellExecError } from "../errors.js"
import type { BranchName, RepoPath, WorktreePath } from "../schema/ids.js"
import { ShellService } from "./shell.js"
import type { ExecResult } from "./shell.js"

// ---------------------------------------------------------------------------
// GitService — worktree/branch ops over ShellService. Branded params at the
// seam (D11); internals pass brands through as plain strings to git.
// ---------------------------------------------------------------------------

export interface GitShape {
  readonly worktreeAdd: (
    repo: RepoPath,
    path: WorktreePath,
    branch: BranchName,
    base?: string
  ) => Effect.Effect<void, ShellExecError>
  readonly worktreeRemove: (
    repo: RepoPath,
    path: WorktreePath,
    force: boolean
  ) => Effect.Effect<void, ShellExecError>
  readonly worktreeList: (
    repo: RepoPath
  ) => Effect.Effect<ReadonlyArray<{ path: string; branch: string }>, ShellExecError>
  readonly deleteBranch: (repo: RepoPath, branch: BranchName) => Effect.Effect<void, ShellExecError>
  readonly deleteRemoteBranch: (
    repo: RepoPath,
    branch: BranchName
  ) => Effect.Effect<void, ShellExecError>
  readonly repoRoot: (repo: string) => Effect.Effect<string, ShellExecError>
  readonly currentBranch: (repo: RepoPath) => Effect.Effect<string, ShellExecError>
  readonly fetch: (repo: RepoPath) => Effect.Effect<void, ShellExecError>
  readonly pullFfOnly: (repo: RepoPath) => Effect.Effect<void, ShellExecError>
  readonly isDirty: (repo: RepoPath) => Effect.Effect<boolean, ShellExecError>
  readonly revParseHead: (repo: RepoPath) => Effect.Effect<string, ShellExecError>
  readonly revParse: (repo: RepoPath, ref: string) => Effect.Effect<string, ShellExecError>
  readonly updateBranch: (repo: RepoPath, branch: string) => Effect.Effect<void, ShellExecError>
}

export interface MemoryRepoState {
  branches: Set<string>
  remoteBranches: Set<string>
  worktrees: Map<string /* path */, string /* branch */>
  dirty: boolean
  /** Current HEAD/ref revision, read by revParseHead and revParse. */
  head: string
  /**
   * Revision HEAD/the base ref advances to on a successful pullFfOnly /
   * updateBranch. When set and different from `head`, a successful pull/update
   * makes the before/after rev-parse pair diverge (headMoved). Defaults to no
   * movement.
   */
  headAfterPull: string
  /** pullFfOnly fails (non-ff) when true. */
  pullFailsNonFf: boolean
  /** updateBranch fails when true. */
  updateFails: boolean
  /**
   * worktreeRemove fails even when the worktree is registered and `force` is
   * false — models `git worktree remove` refusing a dirty worktree, so callers
   * exercise their filesystem force-remove fallback. A forced remove still
   * succeeds.
   */
  worktreeRemoveFails: boolean
}

export class GitService extends Context.Tag("ship/GitService")<GitService, GitShape>() {
  static layer: Layer.Layer<GitService, never, ShellService> = Layer.effect(
    GitService,
    Effect.gen(function* () {
      const shell = yield* ShellService

      const run = (
        repoPath: string,
        args: ReadonlyArray<string>
      ): Effect.Effect<ExecResult, ShellExecError> =>
        shell.exec("git", ["-C", repoPath, ...args]).pipe(
          Effect.tap((r) => Effect.logDebug("git", { args, stdout: r.stdout.trim() })),
          Effect.tapError((e) => Effect.logDebug("git failed", { args, error: e }))
        )

      const worktreeAdd: GitShape["worktreeAdd"] = Effect.fn("GitService.worktreeAdd")(
        function* (repoPath, path, branch, baseBranch) {
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
        }
      )

      const worktreeRemove: GitShape["worktreeRemove"] = Effect.fn("GitService.worktreeRemove")(
        function* (repoPath, path, force) {
          yield* run(repoPath, ["worktree", "remove", ...(force ? ["--force"] : []), path])
        }
      )

      const worktreeList: GitShape["worktreeList"] = Effect.fn("GitService.worktreeList")(
        function* (repoPath) {
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
        }
      )

      const deleteBranch: GitShape["deleteBranch"] = Effect.fn("GitService.deleteBranch")(
        function* (repoPath, branch) {
          yield* run(repoPath, ["branch", "-D", branch])
        }
      )

      const repoRoot: GitShape["repoRoot"] = Effect.fn("GitService.repoRoot")(function* (repoPath) {
        const r = yield* run(repoPath, ["rev-parse", "--show-toplevel"])
        return r.stdout.trim()
      })

      const currentBranch: GitShape["currentBranch"] = Effect.fn("GitService.currentBranch")(
        function* (repoPath) {
          const r = yield* run(repoPath, ["branch", "--show-current"])
          return r.stdout.trim()
        }
      )

      const fetch: GitShape["fetch"] = Effect.fn("GitService.fetch")(function* (repoPath) {
        yield* run(repoPath, ["fetch", "origin"])
      })

      const pullFfOnly: GitShape["pullFfOnly"] = Effect.fn("GitService.pullFfOnly")(
        function* (repoPath) {
          yield* run(repoPath, ["pull", "--ff-only"])
        }
      )

      const isDirty: GitShape["isDirty"] = Effect.fn("GitService.isDirty")(function* (repoPath) {
        const r = yield* run(repoPath, ["status", "--porcelain"])
        return r.stdout.trim().length > 0
      })

      const revParseHead: GitShape["revParseHead"] = Effect.fn("GitService.revParseHead")(
        function* (repoPath) {
          const r = yield* run(repoPath, ["rev-parse", "HEAD"])
          return r.stdout.trim()
        }
      )

      const revParse: GitShape["revParse"] = Effect.fn("GitService.revParse")(
        function* (repoPath, ref) {
          const r = yield* run(repoPath, ["rev-parse", ref])
          return r.stdout.trim()
        }
      )

      /** Fast-forward a local branch ref to match origin (works for non-checked-out branches). */
      const updateBranch: GitShape["updateBranch"] = Effect.fn("GitService.updateBranch")(
        function* (repoPath, branch) {
          yield* run(repoPath, ["fetch", "origin", `${branch}:${branch}`])
        }
      )

      const deleteRemoteBranch: GitShape["deleteRemoteBranch"] = Effect.fn(
        "GitService.deleteRemoteBranch"
      )(function* (repoPath, branch) {
        yield* run(repoPath, ["push", "origin", "--delete", branch])
      })

      return {
        worktreeAdd,
        worktreeRemove,
        worktreeList,
        deleteBranch,
        deleteRemoteBranch,
        repoRoot,
        currentBranch,
        fetch,
        pullFfOnly,
        isDirty,
        revParseHead,
        revParse,
        updateBranch,
      }
    })
  )

  static layerMemory: (state?: Partial<MemoryRepoState>) => Layer.Layer<GitService> = (state) =>
    Layer.effect(
      GitService,
      Effect.gen(function* () {
        const branches = yield* Ref.make(new Set<string>(state?.branches ?? []))
        const remoteBranches = yield* Ref.make(new Set<string>(state?.remoteBranches ?? []))
        const worktrees = yield* Ref.make(
          new Map<string, string>(state?.worktrees ?? [])
        )
        const dirty = state?.dirty ?? false
        const head = yield* Ref.make(state?.head ?? "")
        const headAfterPull = state?.headAfterPull ?? state?.head ?? ""
        const pullFailsNonFf = state?.pullFailsNonFf ?? false
        const updateFails = state?.updateFails ?? false
        const worktreeRemoveFails = state?.worktreeRemoveFails ?? false

        const fail = (op: string): Effect.Effect<never, ShellExecError> =>
          Effect.fail(new ShellExecError({ command: `git ${op}`, stderr: `git ${op} failed` }))

        const worktreeAdd: GitShape["worktreeAdd"] = (_repo, path, branch) =>
          Effect.gen(function* () {
            yield* Ref.update(branches, (s) =>
              s.has(branch) ? s : new Set([...s, branch as string])
            )
            yield* Ref.update(worktrees, (m) => new Map(m).set(path as string, branch as string))
          })

        const worktreeRemove: GitShape["worktreeRemove"] = (_repo, path, force) =>
          Ref.get(worktrees).pipe(
            Effect.flatMap((m) => {
              if (!m.has(path) && !force) return fail(`worktree remove ${path}`)
              if (worktreeRemoveFails && !force) return fail(`worktree remove ${path}`)
              return Ref.update(worktrees, (cur) => {
                const next = new Map(cur)
                next.delete(path as string)
                return next
              })
            })
          )

        const worktreeList: GitShape["worktreeList"] = () =>
          Ref.get(worktrees).pipe(
            Effect.map((m) => [...m.entries()].map(([path, branch]) => ({ path, branch })))
          )

        const deleteBranch: GitShape["deleteBranch"] = (_repo, branch) =>
          Ref.get(branches).pipe(
            Effect.flatMap((s) =>
              s.has(branch)
                ? Ref.update(branches, (cur) => {
                    const next = new Set(cur)
                    next.delete(branch as string)
                    return next
                  })
                : fail(`branch -D ${branch}`)
            )
          )

        const deleteRemoteBranch: GitShape["deleteRemoteBranch"] = (_repo, branch) =>
          Ref.get(remoteBranches).pipe(
            Effect.flatMap((s) =>
              s.has(branch)
                ? Ref.update(remoteBranches, (cur) => {
                    const next = new Set(cur)
                    next.delete(branch as string)
                    return next
                  })
                : fail(`push origin --delete ${branch}`)
            )
          )

        const repoRoot: GitShape["repoRoot"] = (repo) => Effect.succeed(repo)
        const currentBranch: GitShape["currentBranch"] = () => Effect.succeed("")
        const fetch: GitShape["fetch"] = () => Effect.void
        const pullFfOnly: GitShape["pullFfOnly"] = () =>
          pullFailsNonFf
            ? fail("pull --ff-only")
            : Ref.set(head, headAfterPull)
        const isDirty: GitShape["isDirty"] = () => Effect.succeed(dirty)
        const revParseHead: GitShape["revParseHead"] = () => Ref.get(head)
        const revParse: GitShape["revParse"] = () => Ref.get(head)
        const updateBranch: GitShape["updateBranch"] = () =>
          updateFails ? fail("fetch origin") : Ref.set(head, headAfterPull)

        return {
          worktreeAdd,
          worktreeRemove,
          worktreeList,
          deleteBranch,
          deleteRemoteBranch,
          repoRoot,
          currentBranch,
          fetch,
          pullFfOnly,
          isDirty,
          revParseHead,
          revParse,
          updateBranch,
        }
      })
    )
}
