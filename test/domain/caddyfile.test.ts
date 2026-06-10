import { describe, it } from "@effect/vitest"
import { assert } from "@effect/vitest"
import { Schema } from "effect"
import { HostPort, ProxyDomain } from "../../src/schema/ids.js"
import {
  addRoute,
  nextPort,
  parseRoutes,
  removeRoute,
  type Route,
} from "../../src/domain/caddyfile.js"

const domain = (s: string) => Schema.decodeSync(ProxyDomain)(s)
const port = (n: number) => Schema.decodeSync(HostPort)(n)
const route = (d: string, p: number): Route => ({ domain: domain(d), port: port(p) })

describe("domain/caddyfile parseRoutes", () => {
  it("empty content returns no routes", () => {
    assert.deepStrictEqual(parseRoutes(""), [])
  })

  it("whitespace-only content returns no routes", () => {
    assert.deepStrictEqual(parseRoutes("   \n\n  \n"), [])
  })

  it("parses a single block", () => {
    const content = "\na.localhost {\n    reverse_proxy host.docker.internal:5174\n}\n"
    assert.deepStrictEqual(parseRoutes(content), [route("a.localhost", 5174)])
  })

  it("parses multiple blocks in order", () => {
    const content =
      "\na.localhost {\n    reverse_proxy host.docker.internal:5174\n}\n" +
      "\nb.localhost {\n    reverse_proxy host.docker.internal:5175\n}\n" +
      "\nc.localhost {\n    reverse_proxy host.docker.internal:5176\n}\n"
    assert.deepStrictEqual(parseRoutes(content), [
      route("a.localhost", 5174),
      route("b.localhost", 5175),
      route("c.localhost", 5176),
    ])
  })

  it("ignores domain blocks without a matching reverse_proxy line", () => {
    const content =
      "a.localhost {\n    tls internal\n}\n" +
      "b.localhost {\n    reverse_proxy host.docker.internal:5180\n}\n"
    assert.deepStrictEqual(parseRoutes(content), [route("b.localhost", 5180)])
  })
})

describe("domain/caddyfile addRoute", () => {
  it("appends a block that round-trips through parseRoutes", () => {
    const content = addRoute("", route("a.localhost", 5174))
    assert.deepStrictEqual(parseRoutes(content), [route("a.localhost", 5174)])
  })

  it("appends to existing content preserving prior routes", () => {
    let content = addRoute("", route("a.localhost", 5174))
    content = addRoute(content, route("b.localhost", 5175))
    assert.deepStrictEqual(parseRoutes(content), [
      route("a.localhost", 5174),
      route("b.localhost", 5175),
    ])
  })
})

describe("domain/caddyfile removeRoute", () => {
  it("removes the middle block, preserving the others", () => {
    let content = addRoute("", route("a.localhost", 5174))
    content = addRoute(content, route("b.localhost", 5175))
    content = addRoute(content, route("c.localhost", 5176))
    const removed = removeRoute(content, "b.localhost")
    assert.deepStrictEqual(parseRoutes(removed), [
      route("a.localhost", 5174),
      route("c.localhost", 5176),
    ])
  })

  it("collapses blank-line runs and ends with a single trailing newline", () => {
    let content = addRoute("", route("a.localhost", 5174))
    content = addRoute(content, route("b.localhost", 5175))
    const removed = removeRoute(content, "a.localhost")
    assert.ok(!/\n{3,}/.test(removed))
    assert.ok(removed.endsWith("\n"))
    assert.ok(!removed.endsWith("\n\n"))
    assert.deepStrictEqual(parseRoutes(removed), [route("b.localhost", 5175)])
  })

  it("removing the only block leaves no routes", () => {
    const content = addRoute("", route("a.localhost", 5174))
    const removed = removeRoute(content, "a.localhost")
    assert.deepStrictEqual(parseRoutes(removed), [])
  })
})

describe("domain/caddyfile nextPort", () => {
  it("returns BASE_PORT + 1 when no routes exist", () => {
    assert.strictEqual(nextPort([]), port(5174))
  })

  it("returns the lowest free port above base", () => {
    const routes = [route("a", 5174), route("b", 5175)]
    assert.strictEqual(nextPort(routes), port(5176))
  })

  it("fills a freed hole rather than appending past the max", () => {
    // 5175 freed; lowest free port above base is 5175, not 5177
    const routes = [route("a", 5174), route("c", 5176)]
    assert.strictEqual(nextPort(routes), port(5175))
  })

  it("respects a custom base", () => {
    assert.strictEqual(nextPort([], 6000), port(6001))
  })
})
