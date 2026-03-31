import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { ProxyService, type ProxyError } from "../../services/proxy.js"

const errorMessage = (e: ProxyError): string =>
  "message" in e ? e.message : String(e)

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const red = (s: string) => `\x1b[31m${s}\x1b[0m`
const blue = (s: string) => `\x1b[34m${s}\x1b[0m`
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`

// ---------------------------------------------------------------------------
// ship proxy (root)
// ---------------------------------------------------------------------------

const proxyRoot = Command.make("proxy", {}, () =>
  Console.log("Manage the local HTTPS reverse proxy.\n\nRun 'ship proxy --help' for available commands.")
)

// ---------------------------------------------------------------------------
// ship proxy start
// ---------------------------------------------------------------------------

const proxyStart = Command.make("start", {}, () =>
  Effect.gen(function* () {
    const proxy = yield* ProxyService
    const alreadyRunning = yield* proxy.isRunning()
    if (alreadyRunning) {
      yield* Console.log(`  ${yellow("●")} Already running.`)
      return
    }
    yield* proxy.start()
    yield* Console.log(`  ${green("●")} Proxy started.`)
    yield* Console.log(`  ${dim("Run 'ship proxy trust' once to trust the CA.")}`)
  })
)

// ---------------------------------------------------------------------------
// ship proxy stop
// ---------------------------------------------------------------------------

const proxyStop = Command.make("stop", {}, () =>
  Effect.gen(function* () {
    const proxy = yield* ProxyService
    yield* proxy.stop()
    yield* Console.log(`  ${dim("○")} Proxy stopped.`)
  })
)

// ---------------------------------------------------------------------------
// ship proxy status
// ---------------------------------------------------------------------------

const proxyStatus = Command.make("status", {}, () =>
  Effect.gen(function* () {
    const proxy = yield* ProxyService
    const { running, routes } = yield* proxy.status()
    yield* Console.log("")
    if (running) {
      yield* Console.log(`  ${green("●")} ${bold("ship-proxy")} running`)
    } else {
      yield* Console.log(`  ${dim("○")} ${bold("ship-proxy")} stopped`)
      yield* Console.log("")
      return
    }
    yield* Console.log("")
    if (routes.length > 0) {
      yield* Console.log(`  ${bold("Routes")}`)
      yield* printRoutes(routes)
    } else {
      yield* Console.log(`  ${dim("No routes configured.")}`)
    }
    yield* Console.log("")
  })
)

// ---------------------------------------------------------------------------
// ship proxy ls
// ---------------------------------------------------------------------------

const proxyLs = Command.make("ls", {}, () =>
  Effect.gen(function* () {
    const proxy = yield* ProxyService
    yield* proxy.ensureSetup()
    const routes = yield* proxy.getRoutes()
    yield* Console.log("")
    yield* Console.log(`  ${bold("Routes")}`)
    if (routes.length === 0) {
      yield* Console.log(`  ${dim("No routes configured.")}`)
    } else {
      yield* printRoutes(routes)
    }
    yield* Console.log("")
  })
)

// ---------------------------------------------------------------------------
// ship proxy add <domain> <port>
// ---------------------------------------------------------------------------

const addDomain = Args.text({ name: "domain" })
const addPort = Args.integer({ name: "port" })

const proxyAdd = Command.make("add", { domain: addDomain, port: addPort }, ({ domain, port }) =>
  Effect.gen(function* () {
    const proxy = yield* ProxyService
    yield* proxy.addRoute(domain, port)
    yield* Console.log(`  ${green("✓")} ${bold(domain)} ${dim("→")} localhost:${blue(String(port))}`)
  }).pipe(
    Effect.catchAll((e) => Console.log(`  ${red("✗")} ${errorMessage(e)}`))
  )
)

// ---------------------------------------------------------------------------
// ship proxy rm <domain>
// ---------------------------------------------------------------------------

const rmDomain = Args.text({ name: "domain" })

const proxyRm = Command.make("rm", { domain: rmDomain }, ({ domain }) =>
  Effect.gen(function* () {
    const proxy = yield* ProxyService
    yield* proxy.removeRoute(domain)
    yield* Console.log(`  ${green("✓")} Removed ${bold(domain)}`)
  }).pipe(
    Effect.catchAll((e) => Console.log(`  ${red("✗")} ${errorMessage(e)}`))
  )
)

// ---------------------------------------------------------------------------
// ship proxy trust
// ---------------------------------------------------------------------------

const proxyTrust = Command.make("trust", {}, () =>
  Effect.gen(function* () {
    const proxy = yield* ProxyService
    yield* proxy.trust()
    yield* Console.log(`  ${green("✓")} CA trusted. HTTPS will work in all browsers.`)
  }).pipe(
    Effect.catchAll((e) => Console.log(`  ${red("✗")} ${errorMessage(e)}`))
  )
)

// ---------------------------------------------------------------------------
// ship proxy edit
// ---------------------------------------------------------------------------

const proxyEdit = Command.make("edit", {}, () =>
  Effect.gen(function* () {
    const proxy = yield* ProxyService
    yield* proxy.editCaddyfile()
  })
)

// ---------------------------------------------------------------------------
// ship proxy next-port
// ---------------------------------------------------------------------------

const proxyNextPort = Command.make("next-port", {}, () =>
  Effect.gen(function* () {
    const proxy = yield* ProxyService
    const port = yield* proxy.nextPort()
    yield* Console.log(String(port))
  })
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const printRoutes = (routes: ReadonlyArray<{ domain: string; port: number }>) =>
  Effect.gen(function* () {
    for (let i = 0; i < routes.length; i++) {
      const route = routes[i]!
      const isLast = i === routes.length - 1
      const prefix = isLast ? "└──" : "├──"
      yield* Console.log(
        `  ${prefix} ${bold(route.domain)} ${dim("→")} localhost:${blue(String(route.port))}`
      )
    }
  })

// ---------------------------------------------------------------------------
// Compose
// ---------------------------------------------------------------------------

export const proxyCommand = proxyRoot.pipe(
  Command.withSubcommands([
    proxyStart,
    proxyStop,
    proxyStatus,
    proxyLs,
    proxyAdd,
    proxyRm,
    proxyTrust,
    proxyEdit,
    proxyNextPort
  ])
)
