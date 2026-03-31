import { FileSystem, Path } from "@effect/platform"
import type { PlatformError } from "@effect/platform/Error"
import { Effect, Context, Layer, Schema, Option } from "effect"
import { ShipConfig, ProjectConfig } from "../schema/config.js"
import { Workspace, Workspaces } from "../schema/workspace.js"
import { ProjectNotFoundError, InvalidConfigError } from "../errors.js"

// ---------------------------------------------------------------------------
// ConfigService
// ---------------------------------------------------------------------------

export class ConfigService extends Context.Tag("ConfigService")<
  ConfigService,
  {
    readonly configDir: () => string
    readonly loadConfig: () => Effect.Effect<ShipConfig, InvalidConfigError | PlatformError>
    readonly saveConfig: (config: ShipConfig) => Effect.Effect<void, InvalidConfigError | PlatformError>
    readonly getProject: (alias: string) => Effect.Effect<ProjectConfig, ProjectNotFoundError | InvalidConfigError | PlatformError>
    readonly addProject: (alias: string, project: ProjectConfig) => Effect.Effect<void, InvalidConfigError | PlatformError>
    readonly loadWorkspaces: () => Effect.Effect<Workspaces, InvalidConfigError | PlatformError>
    readonly saveWorkspaces: (workspaces: Workspaces) => Effect.Effect<void, InvalidConfigError | PlatformError>
    readonly addWorkspace: (workspace: Workspace) => Effect.Effect<void, InvalidConfigError | PlatformError>
    readonly removeWorkspace: (project: string, branch: string) => Effect.Effect<void, InvalidConfigError | PlatformError>
    readonly findWorkspace: (project: string, branch: string) => Effect.Effect<Option.Option<Workspace>, InvalidConfigError | PlatformError>
  }
>() {}

export const ConfigServiceLive = Layer.effect(
  ConfigService,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const pathSvc = yield* Path.Path

    const home = process.env.HOME ?? process.env.USERPROFILE ?? "~"
    const configDir = pathSvc.join(home, ".config", "ship")
    const configPath = pathSvc.join(configDir, "config.json")
    const workspacesPath = pathSvc.join(configDir, "workspaces.json")

    const ensureDir = (): Effect.Effect<void, PlatformError> =>
      fs.makeDirectory(configDir, { recursive: true })

    const loadConfig = (): Effect.Effect<ShipConfig, InvalidConfigError | PlatformError> =>
      Effect.gen(function* () {
        yield* ensureDir()
        const exists = yield* fs.exists(configPath)
        if (!exists) return new ShipConfig({ projects: {} })
        const raw = yield* fs.readFileString(configPath)
        const json = JSON.parse(raw)
        return yield* Schema.decodeUnknown(ShipConfig)(json).pipe(
          Effect.mapError((e) => new InvalidConfigError({ detail: String(e) }))
        )
      })

    const saveConfig = (config: ShipConfig): Effect.Effect<void, InvalidConfigError | PlatformError> =>
      Effect.gen(function* () {
        yield* ensureDir()
        const encoded = yield* Schema.encode(ShipConfig)(config).pipe(
          Effect.mapError((e) => new InvalidConfigError({ detail: String(e) }))
        )
        yield* fs.writeFileString(configPath, JSON.stringify(encoded, null, 2) + "\n")
      })

    const loadWorkspaces = (): Effect.Effect<Workspaces, InvalidConfigError | PlatformError> =>
      Effect.gen(function* () {
        yield* ensureDir()
        const exists = yield* fs.exists(workspacesPath)
        if (!exists) return [] as Workspaces
        const raw = yield* fs.readFileString(workspacesPath)
        const json = JSON.parse(raw)
        return yield* Schema.decodeUnknown(Workspaces)(json).pipe(
          Effect.mapError((e) => new InvalidConfigError({ detail: String(e) }))
        )
      })

    const saveWorkspaces = (workspaces: Workspaces): Effect.Effect<void, InvalidConfigError | PlatformError> =>
      Effect.gen(function* () {
        yield* ensureDir()
        const encoded = yield* Schema.encode(Workspaces)(workspaces).pipe(
          Effect.mapError((e) => new InvalidConfigError({ detail: String(e) }))
        )
        yield* fs.writeFileString(workspacesPath, JSON.stringify(encoded, null, 2) + "\n")
      })

    return ConfigService.of({
      configDir: () => configDir,
      loadConfig,
      saveConfig,
      getProject: (alias) =>
        Effect.gen(function* () {
          const config = yield* loadConfig()
          const project = config.projects[alias]
          if (!project) return yield* new ProjectNotFoundError({ alias })
          return project
        }),
      addProject: (alias, project) =>
        Effect.gen(function* () {
          const config = yield* loadConfig()
          const updated = new ShipConfig({
            ...config,
            projects: { ...config.projects, [alias]: project }
          })
          yield* saveConfig(updated)
        }),
      loadWorkspaces,
      saveWorkspaces,
      addWorkspace: (workspace) =>
        Effect.gen(function* () {
          const workspaces = yield* loadWorkspaces()
          const filtered = workspaces.filter(
            (w) => !(w.project === workspace.project && w.branch === workspace.branch)
          )
          yield* saveWorkspaces([...filtered, workspace])
        }),
      removeWorkspace: (project, branch) =>
        Effect.gen(function* () {
          const workspaces = yield* loadWorkspaces()
          const filtered = workspaces.filter(
            (w) => !(w.project === project && w.branch === branch)
          )
          yield* saveWorkspaces(filtered)
        }),
      findWorkspace: (project, branch) =>
        Effect.gen(function* () {
          const workspaces = yield* loadWorkspaces()
          const found = workspaces.find(
            (w) => w.project === project && w.branch === branch
          )
          return found ? Option.some(found) : Option.none()
        })
    })
  })
)
