# ship

Project-aware worktree + proxy + database manager. One command to create isolated development workspaces with their own git worktree, database, env config, and HTTPS proxy.

## Install

```bash
# Build from source (requires bun)
git clone <repo-url> && cd ship
bun install
bun build src/main.ts --compile --outfile ship

# Move to PATH
cp ship ~/.local/bin/ship
```

## Quick Start

```bash
# 1. Register a project (run inside the repo)
cd ~/IdeaProjects/elternportal
ship init

# 2. Create a workspace
ship create ep tim/ep-241

# 3. Start developing
cd ../elternportal-tim-ep-241
ship up

# 4. Tear down when done
ship down ep tim/ep-241
```

## Commands

### Project Management

```bash
ship init                    # Register current directory as a project (interactive)
ship init --alias ep ...     # Non-interactive with flags
```

`ship init` auto-detects `.env` files, parses `DATABASE_URL` to infer database config, and identifies URL variables that need patching per workspace.

### Workspace Lifecycle

```bash
ship create <project> [branch]     # Create or resume a workspace
ship create ep tim/ep-241          # Full example
ship create ep                     # Interactive branch prompt

ship down [project] [branch]       # Tear down workspace
ship down                          # Tear down current workspace (in worktree)
ship down ep tim/ep-241             # Tear down specific workspace
ship down --force                  # Skip confirmation
ship down --db-only                # Only drop database

ship ls                            # List all active workspaces
ship ls ep                         # List workspaces for a project
```

#### What `ship create` does

1. Creates a git worktree at `../<project>-<branch-slug>/`
2. Clones the source database to an isolated workspace database
3. Copies and patches `.env` files (DATABASE_URL, BASE_URL, etc.)
4. Runs install, generate, and migrate commands
5. Allocates a port and registers an HTTPS proxy route
6. Registers the workspace in `~/.config/ship/workspaces.json`

### HTTPS Proxy (replaces localproxy)

Manages a Caddy Docker container for local HTTPS reverse proxying.

```bash
ship proxy start               # Start the Caddy proxy container
ship proxy stop                # Stop it
ship proxy status              # Show status and all routes

ship proxy add <domain> <port> # Add a proxy route
ship proxy rm <domain>         # Remove a proxy route
ship proxy ls                  # List all routes

ship proxy trust               # Trust Caddy CA in macOS keychain (once)
ship proxy edit                # Open Caddyfile in $EDITOR
ship proxy next-port           # Print next available port
```

## Configuration

All config lives in `~/.config/ship/`:

| File | Purpose |
|---|---|
| `config.json` | Project definitions (alias, path, DB, commands, env) |
| `workspaces.json` | Active workspace registry |
| `Caddyfile` | Proxy routes (managed by ship) |
| `caddy-data/` | Caddy TLS certificates |
| `caddy-config/` | Caddy runtime config |

### Example config.json

```json
{
  "projects": {
    "ep": {
      "path": "/Users/tim/IdeaProjects/elternportal",
      "database": {
        "container": "postgres",
        "user": "dashboard",
        "source": "dashboard"
      },
      "commands": {
        "install": "pnpm install",
        "generate": "pnpm db generate",
        "migrate": "pnpm db migrate:deploy",
        "dev": "pnpm web dev -p {port}"
      },
      "env": {
        "files": ["apps/dashboard/.env", "packages/db/.env"],
        "autoDetected": {
          "DATABASE_URL": { "type": "database_url" },
          "BASE_URL": { "type": "proxy_url" },
          "BETTER_AUTH_URL": { "type": "proxy_url" }
        }
      },
      "worktree": {
        "dirPattern": "../elternportal-{branch_slug}/",
        "proxyDomainPattern": "ep-{branch_slug}.localhost",
        "dbNamePattern": "ep_{branch_slug_safe}"
      }
    }
  }
}
```

### Env var patching types

| Type | What it does |
|---|---|
| `database_url` | Replaces the database name in the URL |
| `proxy_url` | Replaces the domain with the workspace proxy domain |
| `dev_url` | Replaces with `http://localhost:{port}` + optional path |

## Prerequisites

- [Bun](https://bun.sh) (for building)
- [Docker](https://docker.com) (for Caddy proxy and database operations)
- Git

## Development

```bash
bun install
bun run dev -- <args>          # Run from source
bun run typecheck              # Type check
bun run build                  # Build binary
```

## Built with

- [Effect](https://effect.website) — typed functional programming
- [@effect/cli](https://github.com/Effect-TS/effect/tree/main/packages/cli) — commands, args, options, interactive prompts
- [Caddy](https://caddyserver.com) — automatic HTTPS reverse proxy
