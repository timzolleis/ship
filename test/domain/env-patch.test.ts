import { describe, it } from "@effect/vitest"
import { assert } from "@effect/vitest"
import { Schema } from "effect"
import { EnvConfig, type EnvVarType } from "../../src/schema/config.js"
import { DbName, HostPort, ProxyDomain } from "../../src/schema/ids.js"
import { type EnvPatchContext, patchEnvContent } from "../../src/domain/env-patch.js"

const ctx: EnvPatchContext = {
  dbName: DbName.make("acme_feat_x"),
  proxyDomain: ProxyDomain.make("feat-x.acme.localhost"),
  port: HostPort.make(5180),
}

// Build EnvConfig through the same boundary schema production uses, so the
// `autoDetected` values are genuine EnvVarConfig instances.
const envOf = (
  autoDetected: Record<string, { type: EnvVarType; path?: string }>
): EnvConfig => Schema.decodeUnknownSync(EnvConfig)({ files: [], autoDetected })

describe("domain/env-patch — patchEnvContent", () => {
  it("database_url: swaps the trailing /<db> segment", () => {
    const env = envOf({ DATABASE_URL: { type: "database_url" } })
    const { content, changes } = patchEnvContent(
      "DATABASE_URL=postgres://u:p@localhost:5432/app_dev",
      env,
      ctx
    )
    assert.strictEqual(content, "DATABASE_URL=postgres://u:p@localhost:5432/acme_feat_x")
    assert.deepStrictEqual(changes, [
      {
        key: "DATABASE_URL",
        from: "postgres://u:p@localhost:5432/app_dev",
        to: "postgres://u:p@localhost:5432/acme_feat_x",
      },
    ])
  })

  it("proxy_url: swaps the origin to https://<domain>, preserving the path", () => {
    const env = envOf({ PROXY_URL: { type: "proxy_url" } })
    const { content, changes } = patchEnvContent("PROXY_URL=http://localhost:5173/callback", env, ctx)
    assert.strictEqual(content, "PROXY_URL=https://feat-x.acme.localhost/callback")
    assert.deepStrictEqual(changes, [
      {
        key: "PROXY_URL",
        from: "http://localhost:5173/callback",
        to: "https://feat-x.acme.localhost/callback",
      },
    ])
  })

  it("dev_url: rewrites to http://localhost:<port> with no configured path", () => {
    const env = envOf({ DEV_URL: { type: "dev_url" } })
    const { content, changes } = patchEnvContent("DEV_URL=http://localhost:3000", env, ctx)
    assert.strictEqual(content, "DEV_URL=http://localhost:5180")
    assert.deepStrictEqual(changes, [
      { key: "DEV_URL", from: "http://localhost:3000", to: "http://localhost:5180" },
    ])
  })

  it("dev_url: appends the configured path suffix", () => {
    const env = envOf({ DEV_URL: { type: "dev_url", path: "/oauth" } })
    const { content, changes } = patchEnvContent("DEV_URL=http://localhost:3000/old", env, ctx)
    assert.strictEqual(content, "DEV_URL=http://localhost:5180/oauth")
    assert.deepStrictEqual(changes, [
      { key: "DEV_URL", from: "http://localhost:3000/old", to: "http://localhost:5180/oauth" },
    ])
  })

  it("plain vars are left untouched and produce no change", () => {
    const env = envOf({ SECRET: { type: "plain" } })
    const { content, changes } = patchEnvContent("SECRET=keep-me", env, ctx)
    assert.strictEqual(content, "SECRET=keep-me")
    assert.deepStrictEqual(changes, [])
  })

  it("strips surrounding double quotes before rewriting", () => {
    const env = envOf({ DATABASE_URL: { type: "database_url" } })
    const { content, changes } = patchEnvContent(
      'DATABASE_URL="postgres://localhost/app_dev"',
      env,
      ctx
    )
    // quote stripping means the written value is unquoted
    assert.strictEqual(content, "DATABASE_URL=postgres://localhost/acme_feat_x")
    assert.deepStrictEqual(changes, [
      {
        key: "DATABASE_URL",
        from: "postgres://localhost/app_dev",
        to: "postgres://localhost/acme_feat_x",
      },
    ])
  })

  it("strips surrounding single quotes before rewriting", () => {
    const env = envOf({ PROXY_URL: { type: "proxy_url" } })
    const { content } = patchEnvContent("PROXY_URL='http://localhost:5173'", env, ctx)
    assert.strictEqual(content, "PROXY_URL=https://feat-x.acme.localhost")
  })

  it("preserves comments and blank lines verbatim", () => {
    const env = envOf({ DATABASE_URL: { type: "database_url" } })
    const input = "# a comment\n\nDATABASE_URL=postgres://localhost/app_dev\n# trailing"
    const { content, changes } = patchEnvContent(input, env, ctx)
    assert.strictEqual(
      content,
      "# a comment\n\nDATABASE_URL=postgres://localhost/acme_feat_x\n# trailing"
    )
    assert.strictEqual(changes.length, 1)
  })

  it("leaves unknown (non auto-detected) keys verbatim with no change", () => {
    const env = envOf({ DATABASE_URL: { type: "database_url" } })
    const input = "OTHER=untouched\nDATABASE_URL=postgres://localhost/app_dev"
    const { content, changes } = patchEnvContent(input, env, ctx)
    assert.strictEqual(content, "OTHER=untouched\nDATABASE_URL=postgres://localhost/acme_feat_x")
    assert.deepStrictEqual(changes, [
      {
        key: "DATABASE_URL",
        from: "postgres://localhost/app_dev",
        to: "postgres://localhost/acme_feat_x",
      },
    ])
  })

  it("non-matching lines (no KEY=VALUE) are preserved verbatim", () => {
    const env = envOf({})
    const input = "not a var line\n  indented text\nKEY without value"
    const { content, changes } = patchEnvContent(input, env, ctx)
    assert.strictEqual(content, input)
    assert.deepStrictEqual(changes, [])
  })

  it("records no change when the value is already correct", () => {
    const env = envOf({ DATABASE_URL: { type: "database_url" } })
    const { content, changes } = patchEnvContent(
      "DATABASE_URL=postgres://localhost/acme_feat_x",
      env,
      ctx
    )
    assert.strictEqual(content, "DATABASE_URL=postgres://localhost/acme_feat_x")
    assert.deepStrictEqual(changes, [])
  })

  it("handles multiple vars of different types in one file", () => {
    const env = envOf({
      DATABASE_URL: { type: "database_url" },
      PROXY_URL: { type: "proxy_url" },
      DEV_URL: { type: "dev_url" },
      SECRET: { type: "plain" },
    })
    const input = [
      "DATABASE_URL=postgres://localhost/app_dev",
      "PROXY_URL=http://localhost:5173",
      "DEV_URL=http://localhost:3000",
      "SECRET=keep-me",
    ].join("\n")
    const { content, changes } = patchEnvContent(input, env, ctx)
    assert.strictEqual(
      content,
      [
        "DATABASE_URL=postgres://localhost/acme_feat_x",
        "PROXY_URL=https://feat-x.acme.localhost",
        "DEV_URL=http://localhost:5180",
        "SECRET=keep-me",
      ].join("\n")
    )
    assert.deepStrictEqual(changes.map((c) => c.key), ["DATABASE_URL", "PROXY_URL", "DEV_URL"])
  })
})
