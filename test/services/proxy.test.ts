import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { RouteExistsError, RouteNotFoundError } from "../../src/errors.js"
import { type Route } from "../../src/domain/caddyfile.js"
import { HostPort, ProxyDomain } from "../../src/schema/ids.js"
import { ProxyService } from "../../src/services/proxy.js"

const domain = (s: string) => Schema.decodeSync(ProxyDomain)(s)
const port = (n: number) => Schema.decodeSync(HostPort)(n)
const route = (d: string, p: number): Route => ({ domain: domain(d), port: port(p) })

describe("ProxyService.layerMemory routes", () => {
  it.effect("getRoutes returns the initial routes", () =>
    Effect.gen(function* () {
      const proxy = yield* ProxyService
      const routes = yield* proxy.getRoutes()
      assert.deepStrictEqual(routes, [route("a.localhost", 5174)])
    }).pipe(
      Effect.provide(ProxyService.layerMemory({ routes: [route("a.localhost", 5174)] }))
    )
  )

  it.effect("getRoutes defaults to empty", () =>
    Effect.gen(function* () {
      const proxy = yield* ProxyService
      assert.deepStrictEqual(yield* proxy.getRoutes(), [])
    }).pipe(Effect.provide(ProxyService.layerMemory()))
  )

  it.effect("addRoute appends a new route", () =>
    Effect.gen(function* () {
      const proxy = yield* ProxyService
      yield* proxy.addRoute(domain("b.localhost"), port(5175))
      const routes = yield* proxy.getRoutes()
      assert.deepStrictEqual(routes, [
        route("a.localhost", 5174),
        route("b.localhost", 5175),
      ])
    }).pipe(
      Effect.provide(ProxyService.layerMemory({ routes: [route("a.localhost", 5174)] }))
    )
  )

  it.effect("addRoute fails with RouteExistsError on duplicate domain", () =>
    Effect.gen(function* () {
      const proxy = yield* ProxyService
      const err = yield* proxy.addRoute(domain("a.localhost"), port(9999)).pipe(Effect.flip)
      assert.instanceOf(err, RouteExistsError)
      assert.strictEqual(err.domain, "a.localhost")
      // state unchanged
      assert.deepStrictEqual(yield* proxy.getRoutes(), [route("a.localhost", 5174)])
    }).pipe(
      Effect.provide(ProxyService.layerMemory({ routes: [route("a.localhost", 5174)] }))
    )
  )

  it.effect("removeRoute removes an existing route", () =>
    Effect.gen(function* () {
      const proxy = yield* ProxyService
      yield* proxy.removeRoute("a.localhost")
      assert.deepStrictEqual(yield* proxy.getRoutes(), [route("b.localhost", 5175)])
    }).pipe(
      Effect.provide(
        ProxyService.layerMemory({
          routes: [route("a.localhost", 5174), route("b.localhost", 5175)],
        })
      )
    )
  )

  it.effect("removeRoute fails with RouteNotFoundError when absent", () =>
    Effect.gen(function* () {
      const proxy = yield* ProxyService
      const err = yield* proxy.removeRoute("missing.localhost").pipe(Effect.flip)
      assert.instanceOf(err, RouteNotFoundError)
      assert.strictEqual(err.domain, "missing.localhost")
    }).pipe(Effect.provide(ProxyService.layerMemory({ routes: [route("a.localhost", 5174)] })))
  )

  it.effect("nextPort returns BASE_PORT+1 when no routes", () =>
    Effect.gen(function* () {
      const proxy = yield* ProxyService
      assert.strictEqual(yield* proxy.nextPort(), 5174)
    }).pipe(Effect.provide(ProxyService.layerMemory()))
  )

  it.effect("nextPort fills the lowest free hole above BASE_PORT", () =>
    Effect.gen(function* () {
      const proxy = yield* ProxyService
      // 5174 and 5176 used; 5175 is the hole
      assert.strictEqual(yield* proxy.nextPort(), 5175)
    }).pipe(
      Effect.provide(
        ProxyService.layerMemory({
          routes: [route("a.localhost", 5174), route("c.localhost", 5176)],
        })
      )
    )
  )

  it.effect("nextPort skips contiguous used ports", () =>
    Effect.gen(function* () {
      const proxy = yield* ProxyService
      assert.strictEqual(yield* proxy.nextPort(), 5176)
    }).pipe(
      Effect.provide(
        ProxyService.layerMemory({
          routes: [route("a.localhost", 5174), route("b.localhost", 5175)],
        })
      )
    )
  )

  it.effect("status reflects routes and running flag", () =>
    Effect.gen(function* () {
      const proxy = yield* ProxyService
      const status = yield* proxy.status()
      assert.strictEqual(status.running, true)
      assert.deepStrictEqual(status.routes, [route("a.localhost", 5174)])
    }).pipe(
      Effect.provide(
        ProxyService.layerMemory({ routes: [route("a.localhost", 5174)], running: true })
      )
    )
  )
})

describe("ProxyService.layerMemory running flag", () => {
  it.effect("isRunning defaults to false", () =>
    Effect.gen(function* () {
      const proxy = yield* ProxyService
      assert.strictEqual(yield* proxy.isRunning(), false)
    }).pipe(Effect.provide(ProxyService.layerMemory()))
  )

  it.effect("start flips running to true", () =>
    Effect.gen(function* () {
      const proxy = yield* ProxyService
      assert.strictEqual(yield* proxy.isRunning(), false)
      yield* proxy.start()
      assert.strictEqual(yield* proxy.isRunning(), true)
    }).pipe(Effect.provide(ProxyService.layerMemory()))
  )

  it.effect("stop flips running to false", () =>
    Effect.gen(function* () {
      const proxy = yield* ProxyService
      assert.strictEqual(yield* proxy.isRunning(), true)
      yield* proxy.stop()
      assert.strictEqual(yield* proxy.isRunning(), false)
    }).pipe(Effect.provide(ProxyService.layerMemory({ running: true })))
  )

  it.effect("trust, ensureSetup, reload, editCaddyfile are no-ops", () =>
    Effect.gen(function* () {
      const proxy = yield* ProxyService
      yield* proxy.trust()
      yield* proxy.ensureSetup()
      yield* proxy.reload()
      yield* proxy.editCaddyfile()
      // still consistent
      assert.strictEqual(yield* proxy.isRunning(), false)
    }).pipe(Effect.provide(ProxyService.layerMemory()))
  )
})
