import { assert, describe, it } from "@effect/vitest"
import { Option, Schema } from "effect"
import { locateWorkspace } from "../../src/domain/workspace-locate.js"
import { Workspace } from "../../src/schema/workspace.js"

const makeWorkspace = (over: {
  project: string
  branch: string
  path: string
}): Workspace =>
  Schema.decodeUnknownSync(Workspace)({
    project: over.project,
    branch: over.branch,
    path: over.path,
    port: 5173,
    dbName: "app_dev",
    proxyDomain: "x.localhost",
    created: "2026-06-10",
  })

const wsAlpha = makeWorkspace({ project: "acme", branch: "feat/alpha", path: "/a/alpha" })
const wsBeta = makeWorkspace({ project: "acme", branch: "feat/beta", path: "/a/beta" })
const wsB = makeWorkspace({ project: "acme", branch: "b", path: "/a/b" })
const wsBc = makeWorkspace({ project: "acme", branch: "bc", path: "/a/bc" })

describe("locateWorkspace — branch query precedence", () => {
  it("matches an exact branch first", () => {
    const result = locateWorkspace([wsAlpha, wsBeta], { cwd: "/elsewhere", branch: "feat/beta" })
    assert.deepStrictEqual(result, Option.some(wsBeta))
  })

  it("prefers exact over endsWith and includes", () => {
    // "beta" is endsWith("/beta") of wsBeta but also includes(...) — and exact "b" exists.
    const exact = locateWorkspace([wsB, wsBeta], { cwd: "/elsewhere", branch: "b" })
    assert.deepStrictEqual(exact, Option.some(wsB))
  })

  it("falls back to endsWith(`/${q}`) when no exact match", () => {
    const result = locateWorkspace([wsAlpha, wsBeta], { cwd: "/elsewhere", branch: "alpha" })
    assert.deepStrictEqual(result, Option.some(wsAlpha))
  })

  it("falls back to includes(q) when no exact or endsWith match", () => {
    // "lph" is neither exact nor a trailing segment, but is a substring of "feat/alpha".
    const result = locateWorkspace([wsAlpha, wsBeta], { cwd: "/elsewhere", branch: "lph" })
    assert.deepStrictEqual(result, Option.some(wsAlpha))
  })

  it("returns none when the branch query matches nothing", () => {
    const result = locateWorkspace([wsAlpha, wsBeta], { cwd: "/elsewhere", branch: "zzz" })
    assert.deepStrictEqual(result, Option.none())
  })
})

describe("locateWorkspace — cwd matching", () => {
  it("matches when cwd equals the workspace path exactly", () => {
    const result = locateWorkspace([wsAlpha, wsBeta], { cwd: "/a/beta" })
    assert.deepStrictEqual(result, Option.some(wsBeta))
  })

  it("matches when cwd is nested under the workspace path", () => {
    const result = locateWorkspace([wsAlpha, wsBeta], { cwd: "/a/beta/src/inner" })
    assert.deepStrictEqual(result, Option.some(wsBeta))
  })

  it("does NOT match on a path-prefix false positive (/a/b vs /a/bc)", () => {
    // cwd /a/bc must NOT match the workspace rooted at /a/b.
    const result = locateWorkspace([wsB], { cwd: "/a/bc" })
    assert.deepStrictEqual(result, Option.none())
  })

  it("returns none when cwd is outside any workspace path", () => {
    const result = locateWorkspace([wsAlpha, wsBeta], { cwd: "/elsewhere" })
    assert.deepStrictEqual(result, Option.none())
  })
})

describe("locateWorkspace — branch query precedence over cwd", () => {
  it("uses the branch query even when cwd would also match", () => {
    // cwd points at wsAlpha, but the branch query selects wsBeta.
    const result = locateWorkspace([wsAlpha, wsBeta], { cwd: "/a/alpha", branch: "feat/beta" })
    assert.deepStrictEqual(result, Option.some(wsBeta))
  })

  it("returns none when a branch query is given but matches nothing (does not fall back to cwd)", () => {
    const result = locateWorkspace([wsAlpha, wsBeta], { cwd: "/a/alpha", branch: "zzz" })
    assert.deepStrictEqual(result, Option.none())
  })
})

describe("locateWorkspace — edge cases", () => {
  it("returns none for an empty workspace list (branch query)", () => {
    const result = locateWorkspace([], { cwd: "/a/beta", branch: "feat/beta" })
    assert.deepStrictEqual(result, Option.none())
  })

  it("returns none for an empty workspace list (cwd only)", () => {
    const result = locateWorkspace([], { cwd: "/a/beta" })
    assert.deepStrictEqual(result, Option.none())
  })

  it("distinguishes /a/b from /a/bc via branch includes too", () => {
    // sanity: branch substring matching also respects the candidates present.
    const result = locateWorkspace([wsB, wsBc], { cwd: "/elsewhere", branch: "bc" })
    assert.deepStrictEqual(result, Option.some(wsBc))
  })
})
