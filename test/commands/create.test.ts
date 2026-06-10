import { assert, describe, it } from "@effect/vitest"
import { Schema } from "effect"
import {
  abbreviateValue,
  renderEvent,
  renderEnvChanges,
} from "../../src/commands/create.js"
import type { PatchResult } from "../../src/services/env.js"
import type { ProvisionEvent } from "../../src/services/workspace.js"
import { BranchName, DbName, HostPort, ProxyDomain, WorktreePath } from "../../src/schema/ids.js"

// Strip ANSI so assertions read on content, not escape codes.
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "")
const plainAll = (xs: ReadonlyArray<string>) => xs.map(plain)

const ctx = {
  branch: Schema.decodeSync(BranchName)("feat/x"),
  worktreeDir: Schema.decodeSync(WorktreePath)("/repo/wt/feat-x"),
  dbName: Schema.decodeSync(DbName)("app_feat_x"),
  source: Schema.decodeSync(DbName)("app_dev"),
  proxyDomain: Schema.decodeSync(ProxyDomain)("feat-x.test"),
  port: Schema.decodeSync(HostPort)(5174),
}

describe("abbreviateValue", () => {
  it("abbreviates a URL to host + path", () => {
    assert.strictEqual(abbreviateValue("https://feat-x.test/oauth"), "feat-x.test/oauth")
  })
  it("drops a root path", () => {
    assert.strictEqual(abbreviateValue("https://feat-x.test/"), "feat-x.test")
  })
  it("abbreviates a non-url path-like value to its trailing segment", () => {
    assert.strictEqual(abbreviateValue("/var/lib/app_feat_x"), "app_feat_x")
  })
})

describe("renderEvent", () => {
  it("renders a resuming probe", () => {
    const lines = plainAll(
      renderEvent({ _tag: "step", step: "probe", status: "done", detail: "resuming partial setup" }, ctx)
    )
    assert.deepStrictEqual(lines, ["  ↻ Resuming partial setup..."])
  })

  it("renders register and env steps as silent (no lines)", () => {
    assert.deepStrictEqual(
      renderEvent({ _tag: "step", step: "register", status: "done" }, ctx),
      []
    )
  })

  it("renders a done worktree as branch + worktree lines", () => {
    const lines = plainAll(
      renderEvent({ _tag: "step", step: "worktree", status: "done" }, ctx)
    )
    assert.deepStrictEqual(lines, [
      "  ✓ Branch         feat/x",
      "  ✓ Worktree       /repo/wt/feat-x",
    ])
  })

  it("renders a skipped worktree as already-present lines", () => {
    const lines = plainAll(
      renderEvent({ _tag: "step", step: "worktree", status: "skipped-existing" }, ctx)
    )
    assert.deepStrictEqual(lines, [
      "  • Branch         feat/x (already present)",
      "  • Worktree       /repo/wt/feat-x (already present)",
    ])
  })

  it("renders a done database clone with the source", () => {
    const lines = plainAll(
      renderEvent({ _tag: "step", step: "database", status: "done" }, ctx)
    )
    assert.deepStrictEqual(lines, [
      "  ✓ Database       app_feat_x (cloned from app_dev)",
    ])
  })

  it("renders a skipped database as already present", () => {
    const lines = plainAll(
      renderEvent({ _tag: "step", step: "database", status: "skipped-existing" }, ctx)
    )
    assert.deepStrictEqual(lines, ["  • Database       app_feat_x (already present)"])
  })

  it("renders install / generate / migrate done lines", () => {
    assert.deepStrictEqual(
      plainAll(renderEvent({ _tag: "step", step: "install", status: "done" }, ctx)),
      ["  ✓ Dependencies   installed"]
    )
    assert.deepStrictEqual(
      renderEvent({ _tag: "step", step: "generate", status: "done" }, ctx),
      []
    )
    assert.deepStrictEqual(
      plainAll(renderEvent({ _tag: "step", step: "migrate", status: "done" }, ctx)),
      ["  ✓ Migrations     applied"]
    )
  })

  it("renders a warning sync-base from detail", () => {
    const lines = plainAll(
      renderEvent({ _tag: "step", step: "sync-base", status: "warning", detail: "tree dirty" }, ctx)
    )
    assert.deepStrictEqual(lines, ["  ⚠ Base sync      tree dirty"])
  })

  it("renders a done sync-base (head fast-forwarded) as Base updated", () => {
    const lines = plainAll(
      renderEvent(
        { _tag: "step", step: "sync-base", status: "done", detail: "main fast-forwarded" },
        ctx
      )
    )
    assert.deepStrictEqual(lines, ["  ✓ Base updated   main fast-forwarded"])
  })

  it("renders a done sync-base with migration as updated + migrated lines", () => {
    const lines = plainAll(
      renderEvent(
        {
          _tag: "step",
          step: "sync-base",
          status: "done",
          detail: "main fast-forwarded; migrated app_dev",
        },
        ctx
      )
    )
    assert.deepStrictEqual(lines, [
      "  ✓ Base updated   main fast-forwarded",
      "  ✓ Base migrated  app_dev",
    ])
  })

  it("renders a done sync-base (already up to date)", () => {
    const lines = plainAll(
      renderEvent(
        { _tag: "step", step: "sync-base", status: "done", detail: "already up to date" },
        ctx
      )
    )
    assert.deepStrictEqual(lines, ["  · Base           already up to date"])
  })

  it("renders nothing for a done sync-base with no detail", () => {
    assert.deepStrictEqual(
      renderEvent({ _tag: "step", step: "sync-base", status: "done" }, ctx),
      []
    )
  })

  it("renders a done proxy-route with domain and port", () => {
    const lines = plainAll(
      renderEvent({ _tag: "step", step: "proxy-route", status: "done" }, ctx)
    )
    assert.deepStrictEqual(lines, ["  ✓ Proxy          https://feat-x.test → :5174"])
  })

  it("renders a skipped proxy-route as already present", () => {
    const lines = plainAll(
      renderEvent({ _tag: "step", step: "proxy-route", status: "skipped-existing" }, ctx)
    )
    assert.deepStrictEqual(lines, [
      "  • Proxy          https://feat-x.test → :5174 (already present)",
    ])
  })

  it("renders nothing for the completed event itself", () => {
    const ev: ProvisionEvent = {
      _tag: "completed",
      result: {
        workspace: {
          project: Schema.decodeSync(BranchName)("x") as never,
        } as never,
        alreadyComplete: false,
        envChanges: [],
      },
    }
    assert.deepStrictEqual(renderEvent(ev, ctx), [])
  })
})

describe("renderEnvChanges", () => {
  it("renders each changed key abbreviated", () => {
    const results: ReadonlyArray<PatchResult> = [
      {
        file: ".env",
        changes: [
          { key: "DATABASE_URL", from: "/db/app_dev", to: "/db/app_feat_x" },
        ],
      },
    ]
    const lines = plainAll(renderEnvChanges(results))
    assert.deepStrictEqual(lines, [
      "    .env:",
      "      DATABASE_URL              app_dev → app_feat_x",
    ])
  })

  it("omits files with no changes", () => {
    const results: ReadonlyArray<PatchResult> = [{ file: ".env", changes: [] }]
    assert.deepStrictEqual(renderEnvChanges(results), [])
  })
})
