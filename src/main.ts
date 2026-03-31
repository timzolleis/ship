import { Command } from "@effect/cli"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Console, Effect, Layer } from "effect"
import { createCommand } from "./commands/create.js"
import { downCommand } from "./commands/down.js"
import { initCommand } from "./commands/init.js"
import { listCommand } from "./commands/list.js"
import { proxyCommand } from "./commands/proxy/proxy.js"
import { ConfigServiceLive } from "./services/config.js"
import { ProxyServiceLive } from "./services/proxy.js"

// ship — the root command
const ship = Command.make("ship", {}, () =>
  Console.log("ship — project-aware worktree + proxy manager\n\nRun 'ship --help' for available commands.")
)

const command = ship.pipe(
  Command.withSubcommands([createCommand, downCommand, initCommand, listCommand, proxyCommand])
)

const cli = Command.run(command, {
  name: "ship",
  version: "0.1.0"
})

const MainLayer = Layer.mergeAll(
  NodeContext.layer,
  ProxyServiceLive.pipe(Layer.provide(NodeContext.layer)),
  ConfigServiceLive.pipe(Layer.provide(NodeContext.layer))
)

Effect.suspend(() => cli(process.argv)).pipe(
  Effect.provide(MainLayer),
  NodeRuntime.runMain
)
