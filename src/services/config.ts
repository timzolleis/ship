import { FileSystem, Path } from "@effect/platform"
import { Effect, Schema, Option } from "effect"
import { ShipConfig, ProjectConfig } from "../schema/config.js"
import { Workspace, Workspaces } from "../schema/workspace.js"
import {
  ProjectNotFoundError,
  ParseConfigError,
  EncodeConfigError,
  CreateDirectoryError,
  ReadFileError,
  WriteFileError
} from "../errors.js"

// ---------------------------------------------------------------------------
// JSON schemas (string ↔ domain, pretty-printed on encode)
// ---------------------------------------------------------------------------

const jsonOpts = { space: 2 } as const
const ShipConfigJson = Schema.parseJson(ShipConfig, jsonOpts)
const WorkspacesJson = Schema.parseJson(Workspaces, jsonOpts)

// ---------------------------------------------------------------------------
// ConfigService
// ---------------------------------------------------------------------------

type ConfigReadError = ParseConfigError | ReadFileError | CreateDirectoryError
type ConfigWriteError = EncodeConfigError | WriteFileError | CreateDirectoryError
type ConfigError = ConfigReadError | ConfigWriteError

export class ConfigService extends Effect.Service<ConfigService>()("ConfigService", {
  effect: Effect.gen(function* () {
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

    // -- Generic JSON file helpers --

    const loadJsonFile = <A>(
      path: string,
      schema: Schema.Schema<A, string>,
      fallback: A
    ): Effect.Effect<A, ConfigReadError> =>
      Effect.gen(function* () {
        yield* ensureDir()
        const exists = yield* fs.exists(path).pipe(
          Effect.mapError((e) => new ReadFileError({ path, detail: String(e) }))
        )
        if (!exists) return fallback
        const raw = yield* fs.readFileString(path).pipe(
          Effect.mapError((e) => new ReadFileError({ path, detail: String(e) }))
        )
        return yield* Schema.decode(schema)(raw).pipe(
          Effect.mapError((e) => new ParseConfigError({ file: path, detail: String(e) }))
        )
      })

    const saveJsonFile = <A>(
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

    // -- Public methods --

    const loadConfig = (): Effect.Effect<ShipConfig, ConfigReadError> =>
      loadJsonFile(configPath, ShipConfigJson, new ShipConfig({ projects: {} }))

    const saveConfig = (config: ShipConfig): Effect.Effect<void, ConfigWriteError> =>
      saveJsonFile(configPath, ShipConfigJson, config)

    const loadWorkspaces = (): Effect.Effect<Workspaces, ConfigReadError> =>
      loadJsonFile(workspacesPath, WorkspacesJson, [] as Workspaces)

    const saveWorkspaces = (workspaces: Workspaces): Effect.Effect<void, ConfigWriteError> =>
      saveJsonFile(workspacesPath, WorkspacesJson, workspaces)

    const getProject: (alias: string) => Effect.Effect<ProjectConfig, ProjectNotFoundError | ConfigReadError> =
      Effect.fn("ConfigService.getProject")(function* (alias) {
        const config = yield* loadConfig()
        const project = config.projects[alias]
        if (!project) return yield* new ProjectNotFoundError({ alias })
        return project
      })

    const addProject: (alias: string, project: ProjectConfig) => Effect.Effect<void, ConfigError> =
      Effect.fn("ConfigService.addProject")(function* (alias, project) {
        const config = yield* loadConfig()
        const updated = new ShipConfig({
          ...config,
          projects: { ...config.projects, [alias]: project }
        })
        yield* saveConfig(updated)
      })

    const addWorkspace: (workspace: Workspace) => Effect.Effect<void, ConfigError> =
      Effect.fn("ConfigService.addWorkspace")(function* (workspace) {
        const workspaces = yield* loadWorkspaces()
        const filtered = workspaces.filter(
          (w) => !(w.project === workspace.project && w.branch === workspace.branch)
        )
        yield* saveWorkspaces([...filtered, workspace])
      })

    const removeWorkspace: (project: string, branch: string) => Effect.Effect<void, ConfigError> =
      Effect.fn("ConfigService.removeWorkspace")(function* (project, branch) {
        const workspaces = yield* loadWorkspaces()
        const filtered = workspaces.filter(
          (w) => !(w.project === project && w.branch === branch)
        )
        yield* saveWorkspaces(filtered)
      })

    const findWorkspace: (project: string, branch: string) => Effect.Effect<Option.Option<Workspace>, ConfigReadError> =
      Effect.fn("ConfigService.findWorkspace")(function* (project, branch) {
        const workspaces = yield* loadWorkspaces()
        const found = workspaces.find(
          (w) => w.project === project && w.branch === branch
        )
        return found ? Option.some(found) : Option.none()
      })

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
      findWorkspace
    }
  })
}) {}
