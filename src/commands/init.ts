import { Command, Options, Prompt } from "@effect/cli"
import { FileSystem, Path } from "@effect/platform"
import { Console, Effect, Option } from "effect"
import { ConfigService } from "../services/config.js"
import { ProxyService } from "../services/proxy.js"
import {
  ProjectConfig,
  DatabaseConfig,
  CommandsConfig,
  EnvConfig,
  EnvVarConfig,
  WorktreeConfig,
} from "../schema/config.js"
import { bold, dim, green, blue } from "../fmt.js"

// ---------------------------------------------------------------------------
// Options (all optional — missing = interactive prompt)
// ---------------------------------------------------------------------------

const aliasOpt = Options.text("alias").pipe(Options.optional)
const pathOpt = Options.text("path").pipe(Options.optional)
const dbContainerOpt = Options.text("db-container").pipe(Options.optional)
const dbUserOpt = Options.text("db-user").pipe(Options.optional)
const dbSourceOpt = Options.text("db-source").pipe(Options.optional)
const installCmdOpt = Options.text("install-cmd").pipe(Options.optional)
const generateCmdOpt = Options.text("generate-cmd").pipe(Options.optional)
const migrateCmdOpt = Options.text("migrate-cmd").pipe(Options.optional)
const devCmdOpt = Options.text("dev-cmd").pipe(Options.optional)

// ---------------------------------------------------------------------------
// .env auto-detection
// ---------------------------------------------------------------------------

interface DetectedEnv {
  readonly file: string
  readonly vars: Record<string, { value: string; type: "database_url" | "proxy_url" | "dev_url" | "plain" }>
}

/** Recursively find .env files, respecting .gitignore-style exclusions */
const findEnvFiles = (
  dir: string,
  root: string
): Effect.Effect<string[], never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const pathSvc = yield* Path.Path
    const results: string[] = []

    const entries = yield* fs.readDirectory(dir).pipe(Effect.catchAll(() => Effect.succeed([] as string[])))

    for (const entry of entries) {
      if (["node_modules", ".git", "dist", "build", ".next", ".cache", ".turbo"].includes(entry)) continue

      const fullPath = pathSvc.join(dir, entry)
      const stat = yield* fs.stat(fullPath).pipe(Effect.catchAll(() => Effect.succeed(null)))
      if (!stat) continue

      if (stat.type === "Directory") {
        const nested = yield* findEnvFiles(fullPath, root)
        results.push(...nested)
      } else if (entry === ".env") {
        const relative = pathSvc.relative(root, fullPath)
        results.push(relative)
      }
    }

    return results
  })

const detectEnvFiles = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const pathSvc = yield* Path.Path
  const cwd = process.cwd()

  const results: DetectedEnv[] = []
  const envFiles = yield* findEnvFiles(cwd, cwd)

  for (const candidate of envFiles) {
    const fullPath = pathSvc.join(cwd, candidate)
    const content = yield* fs.readFileString(fullPath)
    const vars: DetectedEnv["vars"] = {}

    for (const line of content.split("\n")) {
      const match = line.match(/^([A-Z_]+)=(.+)$/)
      if (!match) continue
      const [, key, rawValue] = match
      if (!key || !rawValue) continue
      const value = rawValue.replace(/^["']|["']$/g, "")

      if (key === "DATABASE_URL" || key.endsWith("_DATABASE_URL") || key === "QUEUE_DATABASE_URL") {
        vars[key] = { value, type: "database_url" }
      } else if (key.endsWith("_URL") && value.includes(".localhost")) {
        vars[key] = { value, type: "proxy_url" }
      } else if (key.endsWith("_CALLBACK_URL") && value.startsWith("http://localhost")) {
        vars[key] = { value, type: "dev_url" }
      }
    }

    if (Object.keys(vars).length > 0) {
      results.push({ file: candidate, vars })
    }
  }

  return results
})

/** Parse a DATABASE_URL to extract user, host, port, database name */
const parseDatabaseUrl = (url: string) => {
  const match = url.match(/postgres(?:ql)?:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/(.+)/)
  if (!match) return null
  return {
    user: match[1]!,
    password: match[2]!,
    host: match[3]!,
    port: parseInt(match[4]!, 10),
    database: match[5]!,
  }
}

// ---------------------------------------------------------------------------
// Resolve helper: use flag value or prompt
// ---------------------------------------------------------------------------

const resolve = (opt: Option.Option<string>, promptMsg: string, defaultValue?: string) =>
  Option.isSome(opt)
    ? Effect.succeed(opt.value)
    : Prompt.text({ message: promptMsg, default: defaultValue })

// ---------------------------------------------------------------------------
// ship init
// ---------------------------------------------------------------------------

export const initCommand = Command.make(
  "init",
  {
    alias: aliasOpt,
    path: pathOpt,
    dbContainer: dbContainerOpt,
    dbUser: dbUserOpt,
    dbSource: dbSourceOpt,
    installCmd: installCmdOpt,
    generateCmd: generateCmdOpt,
    migrateCmd: migrateCmdOpt,
    devCmd: devCmdOpt,
  },
  (opts) =>
    Effect.gen(function* () {
      const config = yield* ConfigService
      const proxy = yield* ProxyService
      const pathSvc = yield* Path.Path
      const cwd = process.cwd()

      // Detect project name from directory
      const dirName = pathSvc.basename(cwd)

      yield* Console.log("")
      yield* Console.log(`  Detected: ${bold(dirName)} (${dim(cwd)})`)
      yield* Console.log("")

      // Existing registration (matched by cwd) seeds the alias prompt
      const shipConfig = yield* config.loadConfig()
      const aliasForCwd = Object.entries(shipConfig.projects).find(([, p]) => p.path === cwd)?.[0]

      // 1. Project alias
      const alias = yield* resolve(opts.alias, "Project alias:", aliasForCwd ?? dirName.substring(0, 3))

      // Re-running init on a known alias updates it — prompts default to stored values
      const existing = shipConfig.projects[alias]
      if (existing) {
        yield* Console.log(`  ${dim(`Updating existing project "${alias}" — press enter to keep current values.`)}`)
        yield* Console.log("")
      }

      // 2. Project path
      const projectPath = yield* resolve(opts.path, "Project path:", existing?.path ?? cwd)

      // 3. Auto-detect .env files
      yield* Console.log("")
      yield* Console.log(`  Scanning for .env files...`)
      const detected = yield* detectEnvFiles

      let inferredDbUser = existing?.database.user ?? "postgres"
      let inferredDbHost = existing?.database.host ?? "localhost"
      let inferredDbPort = existing?.database.port ?? 5432
      let inferredDbSource = existing?.database.source ?? "postgres"
      const allEnvFiles: string[] = []
      const allDetectedVars: Record<string, EnvVarConfig> = {}

      for (const env of detected) {
        yield* Console.log(`    Found ${blue(env.file)}`)
        allEnvFiles.push(env.file)

        for (const [key, info] of Object.entries(env.vars)) {
          yield* Console.log(`      ${dim(key)} → ${dim(info.value.substring(0, 60))}${info.value.length > 60 ? "..." : ""}`)
          allDetectedVars[key] = new EnvVarConfig({ type: info.type })

          // Extract DB config from DATABASE_URL
          if (info.type === "database_url" && key === "DATABASE_URL") {
            const parsed = parseDatabaseUrl(info.value)
            if (parsed) {
              inferredDbUser = parsed.user
              inferredDbHost = parsed.host
              inferredDbPort = parsed.port
              inferredDbSource = parsed.database
            }
          }
        }
      }

      if (detected.length > 0) {
        yield* Console.log("")
        yield* Console.log(`  Inferred database config:`)
        yield* Console.log(`    User            ${blue(inferredDbUser)}`)
        yield* Console.log(`    Host            ${blue(inferredDbHost)}:${blue(String(inferredDbPort))}`)
        yield* Console.log(`    Source database  ${blue(inferredDbSource)}`)
        yield* Console.log("")
      }

      // 4. Database config (confirm or override)
      const dbContainer = yield* resolve(opts.dbContainer, "Database container name:", existing?.database.container ?? "postgres")
      const dbUser = yield* resolve(opts.dbUser, "Database user:", inferredDbUser)
      const dbSource = yield* resolve(opts.dbSource, "Source database to clone from:", inferredDbSource)

      // 5. Commands
      const installCmd = yield* resolve(opts.installCmd, "Install command:", existing?.commands.install ?? "pnpm install")
      const generateCmd = yield* resolve(opts.generateCmd, "Generate command (e.g. prisma):", existing?.commands.generate ?? "pnpm db generate")
      const migrateCmd = yield* resolve(opts.migrateCmd, "Migrate command:", existing?.commands.migrate ?? "pnpm db migrate:deploy")
      const devCmd = yield* resolve(opts.devCmd, "Dev command:", existing?.commands.dev ?? "pnpm dev -p {port}")

      // 6. Root checkout route — reuse domain/port if the project was registered before
      const rootDomain = existing?.domain ?? `${alias}.localhost`
      const rootPort = existing?.port ?? (yield* proxy.nextPort())

      // 7. Build the config — merge env with existing (manual tweaks like dev_url
      // paths win over fresh detection), keep customized worktree patterns
      const project = new ProjectConfig({
        path: projectPath,
        domain: rootDomain,
        port: rootPort,
        database: new DatabaseConfig({
          container: dbContainer,
          user: dbUser,
          source: dbSource,
          host: inferredDbHost,
          port: inferredDbPort,
        }),
        commands: new CommandsConfig({
          install: installCmd,
          generate: generateCmd,
          migrate: migrateCmd,
          dev: devCmd,
          seed: existing?.commands.seed,
        }),
        env: new EnvConfig({
          files: [...new Set([...(existing?.env.files ?? []), ...allEnvFiles])],
          autoDetected: { ...allDetectedVars, ...(existing?.env.autoDetected ?? {}) },
        }),
        worktree: existing?.worktree ?? new WorktreeConfig({
          dirPattern: `../${dirName}-{branch_slug}/`,
          proxyDomainPattern: `{branch_slug}.${alias}.localhost`,
          dbNamePattern: `${alias}_{branch_slug_safe}`,
        }),
      })

      yield* config.addProject(alias, project)

      yield* proxy.addRoute(rootDomain, rootPort).pipe(
        Effect.catchTag("RouteExistsError", () => Effect.void)
      )

      yield* Console.log("")
      yield* Console.log(`  ${green("✓")} Project ${bold(`"${alias}"`)} ${existing ? "updated" : "registered"}.`)
      yield* Console.log(`  ${green("✓")} Root route     https://${bold(rootDomain)} → :${blue(String(rootPort))}`)
      yield* Console.log("")
    }).pipe(
      Effect.catchAll((e) =>
        Console.error(`Error: ${e.message}`)
      )
    )
)
