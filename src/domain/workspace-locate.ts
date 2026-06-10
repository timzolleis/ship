import { Array as Arr, Option } from "effect"
import type { Workspace } from "../schema/workspace.js"

// ---------------------------------------------------------------------------
// workspace-locate — pure resolution of cwd / branch-query → Option<Workspace>
//
// Replaces the 5 copies of process.cwd() matching scattered across commands.
// No services, no IO.
// ---------------------------------------------------------------------------

/**
 * Locate a workspace by an optional branch query, otherwise by current
 * working directory.
 *
 * - Branch query precedence: exact → endsWith(`/${q}`) → includes(q).
 * - cwd matching: `cwd === path || cwd.startsWith(path + "/")` (path-prefix
 *   safe — `/a/bc` does not match a workspace rooted at `/a/b`).
 * - A branch query takes precedence over cwd: when provided, cwd is not
 *   consulted even if the branch query matches nothing.
 */
export const locateWorkspace = (
  workspaces: ReadonlyArray<Workspace>,
  query: { cwd: string; branch?: string }
): Option.Option<Workspace> => {
  if (query.branch !== undefined) {
    return locateByBranch(workspaces, query.branch)
  }
  return locateByCwd(workspaces, query.cwd)
}

const locateByBranch = (
  workspaces: ReadonlyArray<Workspace>,
  q: string
): Option.Option<Workspace> =>
  Arr.findFirst(workspaces, (w) => w.branch === q).pipe(
    Option.orElse(() => Arr.findFirst(workspaces, (w) => w.branch.endsWith(`/${q}`))),
    Option.orElse(() => Arr.findFirst(workspaces, (w) => w.branch.includes(q)))
  )

const locateByCwd = (
  workspaces: ReadonlyArray<Workspace>,
  cwd: string
): Option.Option<Workspace> =>
  Arr.findFirst(workspaces, (w) => cwd === w.path || cwd.startsWith(`${w.path}/`))
