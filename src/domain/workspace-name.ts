import type { WorktreeConfig } from "../schema/config.js"
import {
  type BranchName,
  DbName,
  type ProjectAlias,
  ProxyDomain,
} from "../schema/ids.js"

// ---------------------------------------------------------------------------
// workspace-name — single source of truth for slugging + pattern resolution.
//
// PURE: no Effect services, no IO. Kills the create.ts/index.ts duplication.
// Semantics sourced verbatim from the pre-refactor helpers:
//   branchSlug:     "/" → "-"                              (toBranchSlug)
//   branchSlugSafe: [^a-zA-Z0-9] → "_", then lowercased    (toBranchSlugSafe)
//   resolvePattern: replace every `{key}` (global) with the var's value.
// ---------------------------------------------------------------------------

export interface WorkspaceNames {
  /** feat/x → feat-x */
  branchSlug: string
  /** feat/x → feat_x (lowercased, [^a-zA-Z0-9] → _) */
  branchSlugSafe: string
  /** dirPattern resolved; caller resolves against RepoPath. */
  worktreeDirRelative: string
  dbName: DbName
  proxyDomain: ProxyDomain
}

/** "/" → "-". */
const toBranchSlug = (branch: string): string => branch.replace(/\//g, "-")

/** [^a-zA-Z0-9] → "_", then lowercased. */
const toBranchSlugSafe = (branch: string): string =>
  branch.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase()

/**
 * Replace every `{key}` occurrence (global) with its value. Unknown
 * placeholders are left untouched.
 */
export const resolvePattern = (
  pattern: string,
  vars: Record<string, string>,
): string => {
  let result = pattern
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, "g"), value)
  }
  return result
}

/**
 * Derive all workspace names from a worktree config + project + branch.
 * `worktreeDirRelative` is relative — the caller resolves it against the
 * project's `RepoPath`.
 */
export const deriveNames = (
  wt: WorktreeConfig,
  project: ProjectAlias,
  branch: BranchName,
): WorkspaceNames => {
  const branchSlug = toBranchSlug(branch)
  const branchSlugSafe = toBranchSlugSafe(branch)
  const vars = {
    branch_slug: branchSlug,
    branch_slug_safe: branchSlugSafe,
    project,
  }
  return {
    branchSlug,
    branchSlugSafe,
    worktreeDirRelative: resolvePattern(wt.dirPattern, vars),
    dbName: DbName.make(resolvePattern(wt.dbNamePattern, vars)),
    proxyDomain: ProxyDomain.make(resolvePattern(wt.proxyDomainPattern, vars)),
  }
}
