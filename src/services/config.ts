import { FileSystem, Path } from "@effect/platform"
import { Context, Effect, Layer, Option, Ref, Schema } from "effect"
import { ProjectConfig, ShipConfig } from "../schema/config.js"
import { BranchName, ProjectAlias } from "../schema/ids.js"
import { Workspace, Workspaces } from "../schema/workspace.js"
import {
  CreateDirectoryError,
  EncodeConfigError,
  ParseConfigError,
  ProjectNotFoundError,
  ReadFileError,
  WriteFileError,
} from "../errors.js"

// ---------------------------------------------------------------------------
// Error aliases
// ---------------------------------------------------------------------------

type ConfigReadError = ParseConfigError | ReadFileError | CreateDirectoryError
type ConfigWriteError = EncodeConfigError | WriteFileError | CreateDirectoryError
type ConfigError = ConfigReadError | ConfigWriteError

// ---------------------------------------------------------------------------
// JSON codecs (string ↔ domain, pretty-printed on encode)
// ---------------------------------------------------------------------------

const jsonOpts = { space: 2 } as const
const ShipConfigJson = Schema.parseJson(ShipConfig, jsonOpts)
const WorkspacesJson = Schema.parseJson(Workspaces, jsonOpts)

// ---------------------------------------------------------------------------
// ConfigService shape
// ---------------------------------------------------------------------------

export interface ConfigShape {
  readonly configDir: () => string
  readonly loadConfig: () => Effect.Effect<ShipConfig, ConfigReadError>
  readonly saveConfig: (c: ShipConfig) => Effect.Effect<void, ConfigWriteError>
  readonly getProject: (
    alias: ProjectAlias
  ) => Effect.Effect<ProjectConfig, ProjectNotFoundError | ConfigReadError>
  readonly addProject: (
    alias: ProjectAlias,
    p: ProjectConfig
  ) => Effect.Effect<void, ConfigError>
  readonly loadWorkspaces: () => Effect.Effect<Workspaces, ConfigReadError>
  readonly saveWorkspaces: (ws: Workspaces) => Effect.Effect<void, ConfigWriteError>
  readonly addWorkspace: (w: Workspace) => Effect.Effect<void, ConfigError>
  readonly removeWorkspace: (
    project: ProjectAlias,
    branch: BranchName
  ) => Effect.Effect<void, ConfigError>
  readonly findWorkspace: (
    project: ProjectAlias,
    branch: BranchName
  ) => Effect.Effect<Option.Option<Workspace>, ConfigReadError>
}

// ---------------------------------------------------------------------------
// Legacy detection (D10)
//
// A stored config is "legacy" when any project's `database` carries a bare
// `container` string and no `runtime` key. The schema decode tolerates this
// (DatabaseConfigFromStored), so we inspect the raw JSON to decide whether a
// canonical write-back is owed.
// ---------------------------------------------------------------------------

const isLegacyRaw = (raw: string): boolean => {
  try {
    const parsed = JSON.parse(raw) as {
      projects?: Record<string, { database?: Record<string, unknown> }>
    }
    const projects = parsed.projects ?? {}
    return Object.values(projects).some((p) => {
      const db = p?.database
      return !!db && "container" in db && !("runtime" in db)
    })
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Workspace registry helpers (pure, shared by both adapters)
// ---------------------------------------------------------------------------

const upsertWorkspace = (workspaces: Workspaces, ws: Workspace): Workspaces => [
  ...workspaces.filter((w) => !(w.project === ws.project && w.branch === ws.branch)),
  ws,
]

const dropWorkspace = (
  workspaces: Workspaces,
  project: ProjectAlias,
  branch: BranchName
): Workspaces => workspaces.filter((w) => !(w.project === project && w.branch === branch))

const lookupWorkspace = (
  workspaces: Workspaces,
  project: ProjectAlias,
  branch: BranchName
): Option.Option<Workspace> => {
  const found = workspaces.find((w) => w.project === project && w.branch === branch)
  return found ? Option.some(found) : Option.none()
}

// ---------------------------------------------------------------------------
// ConfigService
// ---------------------------------------------------------------------------

export class ConfigService extends Context.Tag("ship/ConfigService")<
  ConfigService,
  ConfigShape
>() {
  static layer: Layer.Layer<ConfigService, never, FileSystem.FileSystem | Path.Path> =
    Layer.effect(
      ConfigService,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const pathSvc = yield* Path.Path

        const home = process.env.HOME ?? process.env.USERPROFILE ?? "~"
        const dir = pathSvc.join(home, ".config", "ship")
        const configPath = pathSvc.join(dir, "config.json")
        const workspacesPath = pathSvc.join(dir, "workspaces.json")

        const ensureDir = (): Effect.Effect<void, CreateDirectoryError> =>
          fs.makeDirectory(dir, { recursive: true }).pipe(
            Effect.mapError((e) => new CreateDirectoryError({ path: dir, detail: String(e) }))
          )

        const readRaw = (path: string): Effect.Effect<Option.Option<string>, ConfigReadError> =>
          Effect.gen(function* () {
            yield* ensureDir()
            const exists = yield* fs.exists(path).pipe(
              Effect.mapError((e) => new ReadFileError({ path, detail: String(e) }))
            )
            if (!exists) return Option.none<string>()
            const raw = yield* fs.readFileString(path).pipe(
              Effect.mapError((e) => new ReadFileError({ path, detail: String(e) }))
            )
            return Option.some(raw)
          })

        const decodeWith = <A>(
          path: string,
          schema: Schema.Schema<A, string>,
          raw: string
        ): Effect.Effect<A, ParseConfigError> =>
          Schema.decode(schema)(raw).pipe(
            Effect.mapError((e) => new ParseConfigError({ file: path, detail: String(e) }))
          )

        const writeWith = <A>(
          path: string,
          schema: Schema.Schema<A, string>,
          data: A
        ): Effect.Effect<void, ConfigWriteError> =>
          Effect.gen(function* () {
            yield* ensureDir()
            const json = yield* Schema.encode(schema)(data).pipe(
              Effect.mapError((e) => new EncodeConfigError({ detail: String(e) }))
            )
            yield* fs.writeFileString(path, json + "\n").pipe(
              Effect.mapError((e) => new WriteFileError({ path, detail: String(e) }))
            )
          })

        // --- Config ---

        const saveConfig: ConfigShape["saveConfig"] = (config) =>
          writeWith(configPath, ShipConfigJson, config)

        // Self-migrating load (D10): if the stored raw was the legacy database
        // shape, re-encode canonical and write back best-effort. Load still
        // succeeds even if the write-back fails.
        const loadConfig: ConfigShape["loadConfig"] = () =>
          Effect.gen(function* () {
            const maybeRaw = yield* readRaw(configPath)
            if (Option.isNone(maybeRaw)) return new ShipConfig({ projects: {} })
            const raw = maybeRaw.value
            const config = yield* decodeWith(configPath, ShipConfigJson, raw)
            if (isLegacyRaw(raw)) {
              yield* saveConfig(config).pipe(Effect.ignore)
            }
            return config
          })

        const getProject: ConfigShape["getProject"] = (alias) =>
          Effect.gen(function* () {
            const config = yield* loadConfig()
            const project = config.projects[alias]
            if (!project) return yield* new ProjectNotFoundError({ alias })
            return project
          })

        const addProject: ConfigShape["addProject"] = (alias, project) =>
          Effect.gen(function* () {
            const config = yield* loadConfig()
            const updated = new ShipConfig({
              ...config,
              projects: { ...config.projects, [alias]: project },
            })
            yield* saveConfig(updated)
          })

        // --- Workspaces ---

        const loadWorkspaces: ConfigShape["loadWorkspaces"] = () =>
          Effect.gen(function* () {
            const maybeRaw = yield* readRaw(workspacesPath)
            if (Option.isNone(maybeRaw)) return [] as Workspaces
            return yield* decodeWith(workspacesPath, WorkspacesJson, maybeRaw.value)
          })

        const saveWorkspaces: ConfigShape["saveWorkspaces"] = (workspaces) =>
          writeWith(workspacesPath, WorkspacesJson, workspaces)

        const addWorkspace: ConfigShape["addWorkspace"] = (workspace) =>
          loadWorkspaces().pipe(
            Effect.flatMap((ws) => saveWorkspaces(upsertWorkspace(ws, workspace)))
          )

        const removeWorkspace: ConfigShape["removeWorkspace"] = (project, branch) =>
          loadWorkspaces().pipe(
            Effect.flatMap((ws) => saveWorkspaces(dropWorkspace(ws, project, branch)))
          )

        const findWorkspace: ConfigShape["findWorkspace"] = (project, branch) =>
          loadWorkspaces().pipe(Effect.map((ws) => lookupWorkspace(ws, project, branch)))

        return {
          configDir: () => dir,
          loadConfig,
          saveConfig,
          getProject,
          addProject,
          loadWorkspaces,
          saveWorkspaces,
          addWorkspace,
          removeWorkspace,
          findWorkspace,
        }
      })
    )

  static layerMemory: (initial?: {
    config?: ShipConfig
    workspaces?: Workspaces
  }) => Layer.Layer<ConfigService> = (initial) =>
    Layer.effect(
      ConfigService,
      Effect.gen(function* () {
        const configRef = yield* Ref.make(
          initial?.config ?? new ShipConfig({ projects: {} })
        )
        const workspacesRef = yield* Ref.make<Workspaces>(initial?.workspaces ?? [])

        const loadConfig: ConfigShape["loadConfig"] = () => Ref.get(configRef)
        const saveConfig: ConfigShape["saveConfig"] = (config) =>
          Ref.set(configRef, config)

        const getProject: ConfigShape["getProject"] = (alias) =>
          Ref.get(configRef).pipe(
            Effect.flatMap((config) => {
              const project = config.projects[alias]
              return project
                ? Effect.succeed(project)
                : new ProjectNotFoundError({ alias })
            })
          )

        const addProject: ConfigShape["addProject"] = (alias, project) =>
          Ref.update(
            configRef,
            (config) =>
              new ShipConfig({
                ...config,
                projects: { ...config.projects, [alias]: project },
              })
          )

        const loadWorkspaces: ConfigShape["loadWorkspaces"] = () =>
          Ref.get(workspacesRef)
        const saveWorkspaces: ConfigShape["saveWorkspaces"] = (workspaces) =>
          Ref.set(workspacesRef, workspaces)

        const addWorkspace: ConfigShape["addWorkspace"] = (workspace) =>
          Ref.update(workspacesRef, (ws) => upsertWorkspace(ws, workspace))

        const removeWorkspace: ConfigShape["removeWorkspace"] = (project, branch) =>
          Ref.update(workspacesRef, (ws) => dropWorkspace(ws, project, branch))

        const findWorkspace: ConfigShape["findWorkspace"] = (project, branch) =>
          Ref.get(workspacesRef).pipe(
            Effect.map((ws) => lookupWorkspace(ws, project, branch))
          )

        return {
          configDir: () => ".config/ship",
          loadConfig,
          saveConfig,
          getProject,
          addProject,
          loadWorkspaces,
          saveWorkspaces,
          addWorkspace,
          removeWorkspace,
          findWorkspace,
        }
      })
    )
}
