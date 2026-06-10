import { Args, Command, Options, Prompt } from "@effect/cli"
import { Console, Effect, Option, Schema, Stream } from "effect"
import { ConfigService } from "../services/config.js"
import type {
  CreateDirectoryError,
  EncodeConfigError,
  ParseConfigError,
  ReadFileError,
  WriteFileError,
} from "../errors.js"
import {
  WorkspaceService,
  type StepEvent,
  type TeardownStep,
} from "../services/workspace.js"
import { locateWorkspace } from "../domain/workspace-locate.js"
import type { ProjectConfig } from "../schema/config.js"
import type { Workspace } from "../schema/workspace.js"
import { BranchName, ProjectAlias } from "../schema/ids.js"
import { bold, dim, green, red, yellow } from "../fmt.js"

type ConfigError =
  | ParseConfigError
  | ReadFileError
  | CreateDirectoryError
  | EncodeConfigError
  | WriteFileError

// ---------------------------------------------------------------------------
// ship down [project] [branch] [--force] [--db-only]
// ---------------------------------------------------------------------------

const projectArg = Args.text({ name: "project" }).pipe(Args.optional)
const branchArg = Args.text({ name: "branch" }).pipe(Args.optional)
const forceOpt = Options.boolean("force").pipe(Options.withAlias("f"))
const dbOnlyOpt = Options.boolean("db-only")

// Render a teardown step event in the same shape the command used before.
const renderTeardown = (e: StepEvent<TeardownStep>): Effect.Effect<void> => {
  const label: Record<TeardownStep, string> = {
    "proxy-route": "Proxy route   ",
    database: "Database      ",
    worktree: "Worktree      ",
    branch: "Branch        ",
    "remote-branch": "Remote branch ",
    "claude-convos": "Claude convos ",
  }
  const name = label[e.step]
  if (e.status === "warning") {
    return Console.log(`  ${yellow("⚠")} ${name} ${dim(e.detail ?? "failed")}`)
  }
  if (e.status === "skipped-existing") {
    // claude-convos reports "skipped-existing" when there was nothing to clear.
    return e.step === "claude-convos" ? Effect.void : Console.log(`  ${dim("·")} ${name} skipped`)
  }
  return Console.log(`  ${green("✓")} ${name} done`)
}

// Tear down a workspace via WorkspaceService, then drop its registry entry.
// down's option mapping: removeWorktree = !dbOnly, deleteRemoteBranch = false.
export const tearDownWorkspace = (
  workspace: Workspace,
  projectConfig: ProjectConfig,
  opts: { dbOnly: boolean; force: boolean }
): Effect.Effect<void, ConfigError, WorkspaceService | ConfigService> =>
  Effect.gen(function* () {
    const ws = yield* WorkspaceService
    const config = yield* ConfigService

    yield* ws
      .teardown(workspace, projectConfig, {
        removeWorktree: !opts.dbOnly,
        force: opts.force,
        deleteRemoteBranch: false,
      })
      .pipe(Stream.runForEach(renderTeardown))

    yield* config.removeWorkspace(workspace.project, workspace.branch)
  })

export const downCommand = Command.make(
  "down",
  { project: projectArg, branch: branchArg, force: forceOpt, dbOnly: dbOnlyOpt },
  ({ project: projectOpt, branch: branchOpt, force, dbOnly }) =>
    Effect.gen(function* () {
      const config = yield* ConfigService

      // Resolve target workspace.
      let workspace: Workspace

      if (Option.isSome(projectOpt) && Option.isSome(branchOpt)) {
        const project = Schema.decodeSync(ProjectAlias)(projectOpt.value)
        const branch = Schema.decodeSync(BranchName)(branchOpt.value)
        const found = yield* config.findWorkspace(project, branch)
        if (Option.isNone(found)) {
          yield* Console.log(`  ${red("✗")} No workspace found for ${bold(project)} / ${bold(branch)}`)
          return
        }
        workspace = found.value
      } else {
        const workspaces = yield* config.loadWorkspaces()
        const located = locateWorkspace(workspaces, { cwd: process.cwd() })

        if (Option.isSome(located)) {
          workspace = located.value
        } else if (workspaces.length > 0) {
          const filtered = Option.isSome(projectOpt)
            ? workspaces.filter((w) => w.project === projectOpt.value)
            : workspaces

          if (filtered.length === 0) {
            yield* Console.log(`  ${red("✗")} No workspaces found for project ${bold(Option.getOrElse(projectOpt, () => "?"))}`)
            return
          }

          workspace = yield* Prompt.select({
            message: "Select workspace to tear down",
            choices: filtered.map((w) => ({
              title: `${w.project}  ${w.branch}`,
              value: w,
              description: w.proxyDomain,
            })),
          })
        } else {
          yield* Console.log(`  ${red("✗")} No workspaces found.`)
          return
        }
      }

      // Confirm unless --force.
      if (!force) {
        const confirmed = yield* Prompt.confirm({
          message: `Tear down workspace ${bold(workspace.branch)}?`,
        })
        if (!confirmed) {
          yield* Console.log(`  Cancelled.`)
          return
        }
      }

      const projectConfig = yield* config.getProject(workspace.project)

      yield* Console.log("")
      yield* tearDownWorkspace(workspace, projectConfig, { dbOnly, force })
      yield* Console.log("")
      yield* Console.log(`  ${green("Teardown complete.")}`)
      yield* Console.log("")
    }).pipe(
      Effect.catchAll((e) =>
        Console.error(`\n  ${red("Error:")} ${e.message}\n`)
      )
    )
)
