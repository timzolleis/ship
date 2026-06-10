import { describe, it } from "@effect/vitest"
import { assert } from "@effect/vitest"
import { WorktreeConfig } from "../../src/schema/config.js"
import { BranchName, DbName, ProjectAlias, ProxyDomain } from "../../src/schema/ids.js"
import { deriveNames, resolvePattern } from "../../src/domain/workspace-name.js"

// ---------------------------------------------------------------------------
// resolvePattern — exact current semantics from create.ts/index.ts:
//   replace every `{key}` occurrence (global) with the var's value.
// ---------------------------------------------------------------------------

describe("resolvePattern", () => {
  it("substitutes a single variable", () => {
    assert.strictEqual(
      resolvePattern("{project}-app", { project: "shop" }),
      "shop-app",
    )
  })

  it("substitutes every occurrence of a variable (global)", () => {
    assert.strictEqual(
      resolvePattern("{branch_slug}.{branch_slug}", { branch_slug: "feat-x" }),
      "feat-x.feat-x",
    )
  })

  it("substitutes all three vars used by deriveNames", () => {
    assert.strictEqual(
      resolvePattern("{project}-{branch_slug}-{branch_slug_safe}", {
        project: "shop",
        branch_slug: "feat-x",
        branch_slug_safe: "feat_x",
      }),
      "shop-feat-x-feat_x",
    )
  })

  it("leaves unknown placeholders untouched", () => {
    assert.strictEqual(
      resolvePattern("{project}-{unknown}", { project: "shop" }),
      "shop-{unknown}",
    )
  })

  it("returns the pattern unchanged when no vars match", () => {
    assert.strictEqual(resolvePattern("static-name", { project: "shop" }), "static-name")
  })
})

// ---------------------------------------------------------------------------
// deriveNames — slugging edge cases + pattern-driven derivation.
//   branchSlug:     "/" → "-"
//   branchSlugSafe: [^a-zA-Z0-9] → "_", then lowercased
// ---------------------------------------------------------------------------

const wt = (over?: Partial<WorktreeConfig>): WorktreeConfig =>
  new WorktreeConfig({
    dirPattern: "worktrees/{branch_slug}",
    proxyDomainPattern: "{branch_slug}.{project}.test",
    dbNamePattern: "{project}_{branch_slug_safe}",
    ...over,
  })

const project = ProjectAlias.make("shop")

describe("deriveNames — slugging", () => {
  it("converts a single slash to a dash in branchSlug", () => {
    const names = deriveNames(wt(), project, BranchName.make("feat/x"))
    assert.strictEqual(names.branchSlug, "feat-x")
  })

  it("converts nested slashes (multiple) to dashes in branchSlug", () => {
    const names = deriveNames(wt(), project, BranchName.make("feat/sub/deep"))
    assert.strictEqual(names.branchSlug, "feat-sub-deep")
  })

  it("safe-slug replaces every non-alphanumeric char with underscore and lowercases", () => {
    const names = deriveNames(wt(), project, BranchName.make("Feat/X.Y-Z"))
    assert.strictEqual(names.branchSlugSafe, "feat_x_y_z")
  })

  it("safe-slug lowercases uppercase letters", () => {
    const names = deriveNames(wt(), project, BranchName.make("HOTFIX"))
    assert.strictEqual(names.branchSlugSafe, "hotfix")
  })

  it("branchSlug keeps dots and uppercase (only slashes change)", () => {
    const names = deriveNames(wt(), project, BranchName.make("Feat.X/Y"))
    assert.strictEqual(names.branchSlug, "Feat.X-Y")
  })

  it("safe-slug collapses dots, dashes and slashes uniformly to underscores", () => {
    const names = deriveNames(wt(), project, BranchName.make("a.b-c/d"))
    assert.strictEqual(names.branchSlugSafe, "a_b_c_d")
  })
})

describe("deriveNames — derivation from WorktreeConfig patterns", () => {
  it("resolves worktreeDirRelative from dirPattern", () => {
    const names = deriveNames(wt(), project, BranchName.make("feat/x"))
    assert.strictEqual(names.worktreeDirRelative, "worktrees/feat-x")
  })

  it("derives dbName from dbNamePattern using project + safe slug", () => {
    const names = deriveNames(wt(), project, BranchName.make("Feat/X"))
    assert.strictEqual(names.dbName, DbName.make("shop_feat_x"))
  })

  it("derives proxyDomain from proxyDomainPattern using project + slug", () => {
    const names = deriveNames(wt(), project, BranchName.make("feat/x"))
    assert.strictEqual(names.proxyDomain, ProxyDomain.make("feat-x.shop.test"))
  })

  it("worktreeDirRelative is relative (caller resolves against RepoPath)", () => {
    const names = deriveNames(
      wt({ dirPattern: "../sibling/{branch_slug}" }),
      project,
      BranchName.make("feat/x"),
    )
    assert.strictEqual(names.worktreeDirRelative, "../sibling/feat-x")
  })

  it("supports project var inside the dir pattern", () => {
    const names = deriveNames(
      wt({ dirPattern: "{project}/wt/{branch_slug}" }),
      project,
      BranchName.make("a/b"),
    )
    assert.strictEqual(names.worktreeDirRelative, "shop/wt/a-b")
  })

  it("returns brands assignable to DbName / ProxyDomain", () => {
    const names = deriveNames(wt(), project, BranchName.make("feat/x"))
    const dbName: DbName = names.dbName
    const proxyDomain: ProxyDomain = names.proxyDomain
    assert.strictEqual(dbName, "shop_feat_x")
    assert.strictEqual(proxyDomain, "feat-x.shop.test")
  })
})
