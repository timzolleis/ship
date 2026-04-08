import { Command } from "@effect/cli"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Console, Effect, Layer, Logger, LogLevel } from "effect"
import { createCommand } from "./commands/create.js"
import { dbCommand } from "./commands/db.js"
import { downCommand } from "./commands/down.js"
import { gcCommand } from "./commands/gc.js"
import { initCommand } from "./commands/init.js"
import { listCommand } from "./commands/list.js"
import { openCommand } from "./commands/open.js"
import { resetCommand } from "./commands/reset.js"
import { syncCommand } from "./commands/sync.js"
import { upCommand } from "./commands/up.js"
import { proxyCommand } from "./commands/proxy/proxy.js"
import { ShellService } from "./services/shell.js"
import { GitService } from "./services/git.js"
import { DatabaseService } from "./services/database.js"
import { ConfigService } from "./services/config.js"
import { ProxyService } from "./services/proxy.js"
import { EditorService } from "./services/editor.js"
import { EnvService } from "./services/env.js"
import { SyncService } from "./services/sync.js"
import { bold, dim, blue } from "./fmt.js"

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

const HELP = `
  ${bold("ship")} — project-aware worktree + proxy manager

  ${bold("Usage")}
    ship ${blue("<command>")} [options]

  ${bold("Project Setup")}
    ${blue("init")}                          Register current directory as a project
    ${blue("init")} --alias ep ...           Non-interactive with flags

  ${bold("Workspace Lifecycle")}
    ${blue("create")} <project> [branch]     Create or resume a workspace
    ${blue("down")}   [project] [branch]     Tear down a workspace
    ${blue("ls")}     [project]              List active workspaces

  ${bold("Dev Server")}
    ${blue("up")}     [--open]               Start dev server + proxy

  ${bold("Proxy")} ${dim("(HTTPS reverse proxy via Caddy)")}
    ${blue("proxy start")}                   Start proxy container
    ${blue("proxy stop")}                    Stop proxy container
    ${blue("proxy status")}                  Show status and routes
    ${blue("proxy add")} <domain> <port>     Add a route
    ${blue("proxy rm")}  <domain>            Remove a route
    ${blue("proxy ls")}                      List all routes
    ${blue("proxy trust")}                   Trust CA in macOS keychain
    ${blue("proxy edit")}                    Open Caddyfile in $EDITOR
    ${blue("proxy next-port")}               Print next available port

  ${bold("Database")}
    ${blue("db exec")} <sql>                  Run SQL against workspace database

  ${bold("Utilities")}
    ${blue("sync")}   <project>              Fetch, pull main, migrate source db
    ${blue("reset")}  [--fresh]              Reset workspace database
    ${blue("open")}   [editor|url|db]        Open editor, browser, or psql
    ${blue("gc")}     [--force] [--dry-run] [--sync]  Clean up merged-PR workspaces

  ${bold("Options")}
    --help, -h                    Show help for any command
    --version                     Show version

  ${bold("Examples")}
    ${dim("$")} ship init                        ${dim("# register project (interactive)")}
    ${dim("$")} ship create ep tim/ep-241         ${dim("# create workspace")}
    ${dim("$")} ship ls                           ${dim("# list workspaces")}
    ${dim("$")} ship down ep tim/ep-241           ${dim("# tear down")}
    ${dim("$")} ship proxy start                  ${dim("# start HTTPS proxy")}
`

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const ship = Command.make("ship", {}, () => Console.log(HELP))

const command = ship.pipe(
  Command.withSubcommands([
    createCommand, dbCommand, downCommand, gcCommand, initCommand,
    listCommand, openCommand, resetCommand, syncCommand, upCommand, proxyCommand
  ])
)

const cli = Command.run(command, {
  name: "ship",
  version: "0.1.0"
})

// ---------------------------------------------------------------------------
// Layer composition
// ---------------------------------------------------------------------------

const LogLevelLive = Logger.minimumLogLevel(
  process.env.SHIP_DEBUG ? LogLevel.Debug : LogLevel.Info
)

const MainLayer = Layer.mergeAll(
  ShellService.Default,
  GitService.Default,
  DatabaseService.Default,
  ConfigService.Default,
  ProxyService.Default,
  EditorService.Default,
  EnvService.Default,
  SyncService.Default,
  LogLevelLive
).pipe(Layer.provideMerge(NodeContext.layer))

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

Effect.suspend(() => cli(process.argv)).pipe(
  Effect.provide(MainLayer),
  NodeRuntime.runMain
)
