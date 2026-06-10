import { assert, describe, it } from "@effect/vitest"
import { WorktreeConfig } from "../../src/schema/config.js"
import { BranchName, DbName, ProjectAlias, ProxyDomain } from "../../src/schema/ids.js"
import { deriveNames } from "../../src/domain/workspace-name.js"

// ---------------------------------------------------------------------------
// Regression contract for `ship index` (Slice 5b).
//
// `index.ts` previously derived a worktree's expected db name and proxy domain
// with its own copies of toBranchSlug/toBranchSlugSafe/resolvePattern. Those
// copies are deleted in favour of domain/workspace-name `deriveNames`. These
// tests pin the exact strings index relied on so the swap is behavior-identical.
//
// index feeds a worktree's *plain-string* branch (from git.worktreeList) into
// the derivation; deriveNames takes a branded BranchName, constructed at that
// edge. Assert the brand round-trips and the names match the old inline output.
// ---------------------------------------------------------------------------

const wt = new WorktreeConfig({
  dirPattern: "worktrees/{branch_slug}",
  proxyDomainPattern: "{branch_slug}.{project}.test",
  dbNamePattern: "{project}_{branch_slug_safe}",
})

// The pre-refactor inline helpers index.ts used (kept here as the oracle).
const oldToBranchSlug = (branch: string) => branch.replace(/\//g, "-")
const oldToBranchSlugSafe = (branch: string) =>
  branch.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase()
const oldResolve = (pattern: string, vars: Record<string, string>): string => {
  let result = pattern
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, "g"), value)
  }
  return result
}

const oldNames = (alias: string, branch: string) => {
  const vars = {
    branch_slug: oldToBranchSlug(branch),
    branch_slug_safe: oldToBranchSlugSafe(branch),
    project: alias,
  }
  return {
    dbName: oldResolve(wt.dbNamePattern, vars),
    proxyDomain: oldResolve(wt.proxyDomainPattern, vars),
  }
}

describe("index derivation parity with deriveNames", () => {
  const cases: ReadonlyArray<{ alias: string; branch: string }> = [
    { alias: "shop", branch: "feat/x" },
    { alias: "shop", branch: "Feat/X.Y-Z" },
    { alias: "api", branch: "hotfix/PROD-123" },
    { alias: "api", branch: "main" },
    { alias: "web", branch: "release/2026.06" },
  ]

  for (const { alias, branch } of cases) {
    it(`matches old inline output for ${alias}/${branch}`, () => {
      const expected = oldNames(alias, branch)
      const names = deriveNames(
        wt,
        ProjectAlias.make(alias),
        BranchName.make(branch),
      )
      assert.strictEqual(names.dbName, DbName.make(expected.dbName))
      assert.strictEqual(names.proxyDomain, ProxyDomain.make(expected.proxyDomain))
    })
  }

  it("constructs a BranchName brand at the worktree-branch edge", () => {
    // index reads wt.branch as a plain string off git.worktreeList; the brand
    // must be constructed here, not assumed.
    const plainBranch: string = "feat/x"
    const branch = BranchName.make(plainBranch)
    const names = deriveNames(wt, ProjectAlias.make("shop"), branch)
    assert.strictEqual(names.dbName, DbName.make("shop_feat_x"))
    assert.strictEqual(names.proxyDomain, ProxyDomain.make("feat-x.shop.test"))
  })
})
