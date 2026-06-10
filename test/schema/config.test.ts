import { describe, it } from "@effect/vitest"
import { assert } from "@effect/vitest"
import { Schema } from "effect"
import {
  DatabaseConfig,
  DatabaseConfigFromStored,
  ExecutionRuntime,
  ProjectConfig,
  ShipConfig,
} from "../../src/schema/config.js"
import {
  BranchName,
  ContainerName,
  DbName,
  HostPort,
  ProjectAlias,
  ProxyDomain,
  RepoPath,
  WorktreePath,
} from "../../src/schema/ids.js"

// Expected runtime built through the brand constructors so equality assertions
// compare against a genuinely-typed ExecutionRuntime rather than a widened literal.
const dockerPg17: ExecutionRuntime = {
  _tag: "docker",
  container: ContainerName.make("pg17"),
}

describe("branded scalars (schema/ids)", () => {
  it("decode plain strings into brands", () => {
    assert.strictEqual(Schema.decodeSync(ProjectAlias)("acme"), "acme")
    assert.strictEqual(Schema.decodeSync(BranchName)("feat/x"), "feat/x")
    assert.strictEqual(Schema.decodeSync(RepoPath)("/repo"), "/repo")
    assert.strictEqual(Schema.decodeSync(WorktreePath)("/wt"), "/wt")
    assert.strictEqual(Schema.decodeSync(DbName)("app_dev"), "app_dev")
    assert.strictEqual(Schema.decodeSync(ProxyDomain)("x.localhost"), "x.localhost")
    assert.strictEqual(Schema.decodeSync(ContainerName)("pg17"), "pg17")
  })

  it("HostPort decodes integers", () => {
    assert.strictEqual(Schema.decodeSync(HostPort)(5173), 5173)
  })

  it("brands are usable where the branded type is required (compile-time)", () => {
    // These assignments only typecheck because the values were decoded into brands.
    const alias: ProjectAlias = Schema.decodeSync(ProjectAlias)("acme")
    const branch: BranchName = Schema.decodeSync(BranchName)("main")
    const repo: RepoPath = Schema.decodeSync(RepoPath)("/repo")
    const wt: WorktreePath = Schema.decodeSync(WorktreePath)("/wt")
    const db: DbName = Schema.decodeSync(DbName)("app_dev")
    const dom: ProxyDomain = Schema.decodeSync(ProxyDomain)("x.localhost")
    const container: ContainerName = Schema.decodeSync(ContainerName)("pg17")
    const port: HostPort = Schema.decodeSync(HostPort)(5173)
    assert.deepStrictEqual(
      [alias, branch, repo, wt, db, dom, container, port],
      ["acme", "main", "/repo", "/wt", "app_dev", "x.localhost", "pg17", 5173]
    )
  })
})

describe("DatabaseConfig — legacy migration (D10) + canonical round-trip", () => {
  it("decodes the LEGACY { container } shape into runtime docker", () => {
    const decoded = Schema.decodeUnknownSync(DatabaseConfigFromStored)({
      container: "pg17",
      user: "u",
      source: "app_dev",
    })
    assert.deepStrictEqual(decoded.runtime, dockerPg17)
    assert.strictEqual(decoded.user, "u")
    assert.strictEqual(decoded.source, "app_dev")
    // optional defaults still apply
    assert.strictEqual(decoded.host, "localhost")
    assert.strictEqual(decoded.port, 5432)
  })

  it("encode ALWAYS writes canonical runtime (never legacy container)", () => {
    const decoded = Schema.decodeUnknownSync(DatabaseConfigFromStored)({
      container: "pg17",
      user: "u",
      source: "app_dev",
    })
    const encoded = Schema.encodeSync(DatabaseConfigFromStored)(decoded) as Record<string, unknown>
    assert.deepStrictEqual(encoded.runtime, { _tag: "docker", container: "pg17" })
    assert.strictEqual("container" in encoded, false)
  })

  it("round-trips the new canonical docker shape", () => {
    const canonical = {
      runtime: dockerPg17,
      user: "u",
      source: DbName.make("app_dev"),
      host: "localhost",
      port: 5432,
    }
    const decoded = Schema.decodeUnknownSync(DatabaseConfigFromStored)(canonical)
    assert.deepStrictEqual(decoded.runtime, dockerPg17)
    const encoded = Schema.encodeSync(DatabaseConfigFromStored)(decoded)
    assert.deepStrictEqual(encoded, canonical)
    // the canonical class also constructs/round-trips directly
    const viaClass = Schema.encodeSync(DatabaseConfig)(new DatabaseConfig(canonical))
    assert.deepStrictEqual(viaClass, canonical)
  })

  it("decodes a local runtime", () => {
    const decoded = Schema.decodeUnknownSync(DatabaseConfigFromStored)({
      runtime: { _tag: "local" },
      user: "u",
      source: "app_dev",
    })
    assert.deepStrictEqual(decoded.runtime, { _tag: "local" })
  })
})

describe("ProjectConfig / ShipConfig — branded fields", () => {
  const baseProject = {
    path: "/repo",
    domain: "acme.localhost",
    port: 5173,
    database: {
      runtime: { _tag: "docker", container: "pg17" },
      user: "u",
      source: "app_dev",
      host: "localhost",
      port: 5432,
    },
    commands: {},
    env: { files: [], autoDetected: {} },
    worktree: {
      dirPattern: "../x-{branch_slug}/",
      proxyDomainPattern: "{branch_slug}.acme.localhost",
      dbNamePattern: "acme_{branch_slug_safe}",
    },
  }

  it("decodes ProjectConfig with branded path/domain/port/db source", () => {
    const decoded = Schema.decodeUnknownSync(ProjectConfig)(baseProject)
    assert.strictEqual(decoded.path, "/repo")
    assert.strictEqual(decoded.domain, "acme.localhost")
    assert.strictEqual(decoded.port, 5173)
    assert.strictEqual(decoded.database.source, "app_dev")
  })

  it("ShipConfig.projects is a record keyed by ProjectAlias", () => {
    const decoded = Schema.decodeUnknownSync(ShipConfig)({
      projects: { acme: baseProject },
    })
    const project = decoded.projects["acme" as keyof typeof decoded.projects]
    assert.strictEqual(project?.path, "/repo")
  })
})
