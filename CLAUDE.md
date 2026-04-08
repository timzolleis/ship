# CLAUDE.md

## Overview

**ship** is a CLI tool for managing project-aware git worktrees, databases, and an HTTPS reverse proxy. Built with Effect-TS, @effect/cli, and @effect/platform. Compiled to a standalone binary via Bun.

## Commands

```bash
bun run src/main.ts          # Dev run
bun run build                # Compile to ./ship binary
bun run typecheck            # tsc --noEmit
```

After build, copy `./ship` to `~/.local/bin/ship`.

## Architecture

```
src/
├── main.ts              # CLI entry, layer composition
├── fmt.ts               # Shared ANSI formatting (bold, dim, green, red, blue, yellow)
├── errors.ts            # Schema.TaggedError domain errors
├── schema/
│   ├── config.ts        # ShipConfig, ProjectConfig, DatabaseConfig, etc.
│   └── workspace.ts     # Workspace, Workspaces
├── services/
│   ├── shell.ts         # ShellService — command execution (wraps CommandExecutor)
│   ├── git.ts           # GitService — worktree/branch ops (depends on Shell)
│   ├── database.ts      # DatabaseService — docker exec postgres ops (depends on Shell)
│   ├── config.ts        # ConfigService — ~/.config/ship/ config + workspace registry
│   ├── proxy.ts         # ProxyService — Caddy reverse proxy (depends on Shell)
│   ├── editor.ts        # EditorService — detect & open editors (depends on Shell, Config)
│   └── env.ts           # patchEnvFiles() — .env copying/patching (standalone function)
└── commands/
    ├── init.ts          # Register project (interactive)
    ├── create.ts        # Create workspace (worktree + db + env + proxy)
    ├── down.ts          # Tear down workspace
    ├── up.ts            # Start dev server + proxy
    ├── list.ts          # List workspaces
    ├── open.ts          # Open editor/url/db
    ├── reset.ts         # Reset workspace database
    ├── gc.ts            # Clean up merged-PR workspaces
    ├── db.ts            # Database subcommands (exec)
    └── proxy/proxy.ts   # Proxy subcommands (start/stop/status/add/rm/trust/edit)
```

## Layer Composition

```
NodeContext.layer (FileSystem, Path, CommandExecutor, Terminal)
  └─ ShellServiceLive
       ├─ GitServiceLive
       ├─ DatabaseServiceLive
       └─ ProxyServiceLive (+ NodeContext)
  └─ ConfigServiceLive (+ NodeContext)
  └─ EditorServiceLive (+ ShellLive + ConfigLive + NodeContext)
```

All services are `Context.Tag` + `Layer.effect`. The layer yields dependencies once; methods return `Effect<A, E>` with no R requirement. Commands access services via `yield* ServiceName`.

## Effect Patterns

| Pattern | How |
|---------|-----|
| Services | `Context.Tag` + `Layer.effect`, deps yielded in layer constructor |
| Errors | `Schema.TaggedError` — yieldable (no `Effect.fail()` needed) |
| Error handling | `catchTag` for specific, `catchAll` at CLI boundary |
| Shell execution | All through `ShellService` (never raw `CommandExecutor` in commands) |
| File I/O | Via `FileSystem.FileSystem` from @effect/platform |
| Formatting | Shared `src/fmt.ts` (never define local ANSI helpers) |

## Error Types (src/errors.ts)

- `ProjectNotFoundError` — project alias not in config
- `InvalidConfigError` — schema decode/encode failure
- `RouteExistsError` — proxy route already exists
- `RouteNotFoundError` — proxy route not found
- `CertNotFoundError` — Caddy CA cert not generated yet

## Config Storage

All state lives in `~/.config/ship/`:

| File | Contents |
|------|----------|
| `config.json` | Projects, editor pref, autoOpenEditor |
| `workspaces.json` | Active workspace entries |
| `Caddyfile` | Caddy reverse proxy routes |
| `caddy-data/` | Caddy TLS certificates |
| `caddy-config/` | Caddy runtime config |

## Key Conventions

- **New services**: `Context.Tag` + `Layer.effect` with deps yielded in layer. Export `FooServiceLive`.
- **New errors**: `Schema.TaggedError` in `src/errors.ts`. Use `get message()` for user-facing text.
- **New commands**: Use services from context (`yield* ServiceName`). Never access `CommandExecutor` directly.
- **Formatting**: Import from `src/fmt.ts`. Never define local `bold`/`dim`/etc.
- **Editor opening**: Always use `EditorService.open()`, never shell exec an editor directly.
- **Typecheck after every change**: `bun run typecheck` must pass before building.
