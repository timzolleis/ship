import { Args, Command, Options, Prompt } from "@effect/cli"
import { Path } from "@effect/platform"
import { Console, Effect, Option, Schema, Stream } from "effect"
import { deriveNames } from "../domain/workspace-name.js"
import { bold, blue, dim, green, red, yellow } from "../fmt.js"
import { ShipConfig } from "../schema/config.js"
import { BranchName, type DbName, ProjectAlias, type ProxyDomain, type HostPort, WorktreePath } from "../schema/ids.js"
import { ConfigService } from "../services/config.js"
import { EditorService } from "../services/editor.js"
import type { PatchResult } from "../services/env.js"
import type { ProvisionEvent } from "../services/workspace.js"
import { WorkspaceService } from "../services/workspace.js"

// ---------------------------------------------------------------------------
// Pure rendering — turns a ProvisionEvent (and env changes) into console lines.
// ---------------------------------------------------------------------------

export interface RenderContext {
  readonly branch: BranchName
  readonly worktreeDir: WorktreePath
  readonly dbName: DbName
  readonly source: DbName
  readonly proxyDomain: ProxyDomain
  readonly port: HostPort
}

/** Shorten a URL/db value for the env-change diff column. */
export const abbreviateValue = (value: string): string => {
  try {
    const url = new URL(value)
    return url.hostname + (url.pathname !== "/" ? url.pathname : "")
  } catch {
    const dbMatch = value.match(/\/([^/]+)$/)
    if (dbMatch) return dbMatch[1]!
    return value.length > 40 ? value.substring(0, 37) + "..." : value
  }
}

const okLine = (label: string, detail: string) => `  ${green("✓")} ${label.padEnd(14)} ${detail}`
const skipLine = (label: string, detail: string) =>
  `  ${dim("•")} ${label.padEnd(14)} ${detail} ${dim("(already present)")}`
const warnLine = (label: string, detail: string) => `  ${yellow("⚠")} ${label.padEnd(14)} ${dim(detail)}`

/** Map a single provision event to zero or more console lines. */
export const renderEvent = (event: ProvisionEvent, ctx: RenderContext): ReadonlyArray<string> => {
  if (event._tag === "completed") return []
  const { step, status, detail } = event
  switch (step) {
    case "probe":
      return [`  ${yellow("↻")} Resuming partial setup...`]
    case "sync-base": {
      if (status === "warning") return [warnLine("Base sync", detail ?? "")]
      if (status !== "done" || !detail) return []
      if (detail === "already up to date")
        return [dim("  · Base           already up to date")]
      // detail = "<label> fast-forwarded" optionally "; migrated <source>"
      const [updated, migrated] = detail.split("; migrated ")
      const lines = [okLine("Base updated", updated!)]
      if (migrated) lines.push(okLine("Base migrated", migrated))
      return lines
    }
    case "worktree":
      return status === "skipped-existing"
        ? [skipLine("Branch", ctx.branch), skipLine("Worktree", dim(ctx.worktreeDir))]
        : [okLine("Branch", bold(ctx.branch)), okLine("Worktree", dim(ctx.worktreeDir))]
    case "database":
      return status === "skipped-existing"
        ? [skipLine("Database", bold(ctx.dbName))]
        : [okLine("Database", `${bold(ctx.dbName)} ${dim(`(cloned from ${ctx.source})`)}`)]
    case "install":
      return [okLine("Dependencies", "installed")]
    case "migrate":
      return [okLine("Migrations", "applied")]
    case "proxy-route": {
      const route = `https://${bold(ctx.proxyDomain)} → :${blue(String(ctx.port))}`
      if (status === "warning") return [warnLine("Proxy", detail ?? "")]
      return status === "skipped-existing"
        ? [`  ${dim("•")} ${"Proxy".padEnd(14)} ${route} ${dim("(already present)")}`]
        : [`  ${green("✓")} ${"Proxy".padEnd(14)} ${route}`]
    }
    default:
      return []
  }
}

/** Render the env-change diff block from the completed result. */
export const renderEnvChanges = (results: ReadonlyArray<PatchResult>): ReadonlyArray<string> => {
  const lines: string[] = []
  for (const result of results) {
    if (result.changes.length === 0) continue
    lines.push(`    ${blue(result.file)}:`)
    for (const change of result.changes) {
      lines.push(
        `      ${dim(change.key.padEnd(25))} ${abbreviateValue(change.from)} → ${abbreviateValue(change.to)}`
      )
    }
  }
  return lines
}

const log = (lines: ReadonlyArray<string>) => Effect.forEach(lines, Console.log, { discard: true })

// ---------------------------------------------------------------------------
// ship create <project> [branch]
// ---------------------------------------------------------------------------

const projectArg = Args.text({ name: "project" }).pipe(Args.optional)
const branchArg = Args.text({ name: "branch" }).pipe(Args.optional)
const baseOption = Options.text("base").pipe(
  Options.withDescription("Base branch to create worktree from (defaults to HEAD)"),
  Options.optional
)

export const createCommand = Command.make(
  "create",
  { project: projectArg, branch: branchArg, base: baseOption },
  ({ project: projectOpt, branch: branchOpt, base: baseOpt }) =>
    Effect.gen(function* () {
      const config = yield* ConfigService
      const editor = yield* EditorService
      const ws = yield* WorkspaceService
      const pathSvc = yield* Path.Path

      // 1. Resolve project (prompt if not specified).
      let projectInput: string
      if (Option.isSome(projectOpt)) {
        projectInput = projectOpt.value
      } else {
        const shipConfig = yield* config.loadConfig()
        const aliases = Object.keys(shipConfig.projects) as Array<ProjectAlias>
        if (aliases.length === 0) {
          yield* log([
            "",
            `  ${red("✗")} No projects registered.`,
            `  ${dim("Register one with: ship init")}`,
            "",
          ])
          return
        }
        projectInput = yield* Prompt.select({
          message: "Select a project",
          choices: aliases.map((alias) => ({
            title: alias,
            value: alias,
            description: shipConfig.projects[alias]!.path,
          })),
        })
      }

      const project = Schema.decodeSync(ProjectAlias)(projectInput)
      const projectConfig = yield* config.getProject(project)

      // 2. Resolve branch.
      const branch = Schema.decodeSync(BranchName)(
        Option.isSome(branchOpt)
          ? branchOpt.value
          : yield* Prompt.text({ message: "Branch name:" })
      )

      const baseBranch = Option.fromNullable(Option.getOrUndefined(baseOpt))

      // Render context (derived names — single source of truth in domain).
      const names = deriveNames(projectConfig.worktree, project, branch)
      const baseCtx = {
        branch,
        worktreeDir: WorktreePath.make(pathSvc.resolve(projectConfig.path, names.worktreeDirRelative)),
        dbName: names.dbName,
        source: projectConfig.database.source,
        proxyDomain: names.proxyDomain,
      }

      yield* Console.log("")

      // 3. Provision — collect the event stream, capture the completed result.
      // (port is only settled at completion, so render with it once known.)
      const events = yield* ws
        .provision({ projectAlias: project, projectConfig, branch, baseBranch })
        .pipe(Stream.runCollect, Effect.map((c) => Array.from(c)))

      const completed = events.find((e) => e._tag === "completed")
      if (completed === undefined || completed._tag !== "completed") {
        yield* Console.log(`  ${green("Ready.")}`)
        yield* Console.log("")
        return
      }
      const result = completed.result
      const renderCtx: RenderContext = { ...baseCtx, port: result.workspace.port }
      yield* Effect.forEach(events, (e) => log(renderEvent(e, renderCtx)), { discard: true })

      // Already fully provisioned → short-circuit message + open prompt.
      if (result.alreadyComplete) {
        const w = result.workspace
        yield* log([
          `  Already exists: ${bold(w.branch)} in ${dim(w.path)}`,
          `  Proxy: ${blue(`https://${w.proxyDomain}`)} → :${w.port}`,
          "",
        ])
        const shouldOpen = yield* Prompt.confirm({ message: "Open in editor?", initial: true })
        if (shouldOpen) yield* editor.open(w.path)
        return
      }

      // Env changes (rendered from the result).
      const envLines = renderEnvChanges(result.envChanges)
      if (envLines.length > 0) {
        yield* Console.log("")
        yield* Console.log(`  Configuring environment...`)
        yield* log(envLines)
      }

      // 4. Auto-open editor (prompt once; persist preference).
      yield* Console.log("")
      const shipConfig = yield* config.loadConfig()
      let shouldOpen = shipConfig.autoOpenEditor
      if (shouldOpen === undefined) {
        shouldOpen = yield* Prompt.confirm({ message: "Open workspace in editor?", initial: true })
        yield* config.saveConfig(new ShipConfig({ ...shipConfig, autoOpenEditor: shouldOpen }))
      }
      if (shouldOpen) yield* editor.open(result.workspace.path)

      yield* Console.log(`  ${green("Ready.")}`)
      yield* Console.log("")
    }).pipe(
      Effect.catchTag("DatabaseUnreachableError", (e) =>
        log(["", `  ${red("✗")} ${e.message}`, `    Start it first, then run this command again.`, ""])
      ),
      Effect.catchAll((e) => Console.error(`\n  ${red("Error:")} ${e.message}\n`))
    )
)
