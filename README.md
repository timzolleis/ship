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
ship create <project> [branch]     # Create workspace (or open existing)
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
7. Opens the workspace in your editor (asks on first run, remembers preference)

### Dev Server

```bash
ship up                        # Start dev server + ensure proxy is running
ship up --open                 # Also open browser
```

Run inside a workspace. Ensures the proxy container is running, the route is registered, then executes the configured dev command.

### Database Reset

```bash
ship reset                     # Drop DB and re-clone from source
ship reset --fresh             # Drop DB, create empty, run seed
```

Run inside a workspace. Useful when the DB gets into a bad state.

### Open Things

```bash
ship open                      # Open current workspace in editor
ship open 241                  # Fuzzy match branch (substring search)
ship open tim/ep-241           # Exact branch match
ship open url                  # Open proxy URL in browser
ship open db                   # Open psql session to workspace DB
ship open tim/ep-241 url       # Open specific workspace's URL
```

Branch matching tries exact match, then suffix (`*/241`), then substring (`241` anywhere in branch name).

Editor detection finds the first available from: `$VISUAL`, `$EDITOR`, Zed, Cursor, VS Code, Sublime, nvim, vim, vi. On macOS, GUI editors are detected via `/Applications/` (works even if CLI shims aren't in PATH). The working editor is saved to config.

### Garbage Collection

```bash
ship gc                        # Check all workspaces for merged PRs
ship gc --force                # Auto-teardown all merged, no prompts
ship gc --dry-run              # Just show what would be cleaned up
```

Uses `gh pr view` to check PR status. Prompts to tear down each workspace with a merged PR.

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

## Architecture

### How ship organizes things

```
~/.config/ship/                    # ship's home — all state lives here
├── config.json                    # project definitions (created by `ship init`)
├── workspaces.json                # registry of active workspaces
├── Caddyfile                      # proxy routes (one block per workspace)
├── caddy-data/                    # Caddy TLS certs + CA (auto-generated)
│   └── caddy/pki/authorities/
│       └── local/root.crt         # the CA cert you trust with `ship proxy trust`
└── caddy-config/                  # Caddy runtime state
```

### What happens when you run `ship create ep tim/ep-241`

Given a project `ep` pointing to `/Users/tim/IdeaProjects/elternportal`:

```
/Users/tim/IdeaProjects/
├── elternportal/                  # main repo (where you ran `ship init`)
│   ├── apps/dashboard/.env        # source .env (read, never modified)
│   └── ...
│
└── elternportal-tim-ep-241/       # NEW — git worktree (sibling directory)
    ├── apps/dashboard/.env        # PATCHED copy — different DB, different URLs
    ├── packages/db/.env           # PATCHED copy
    └── ...                        # full repo checkout on branch tim/ep-241
```

**Database** (inside Docker `postgres` container):
```
dashboard          # source DB (never modified)
ep_tim_ep_241      # NEW — cloned from dashboard via pg_dump | psql
```

**Proxy** (Caddyfile gets a new block):
```
ep-tim-ep-241.localhost {
    reverse_proxy host.docker.internal:5174
}
```

**Workspace registry** (`workspaces.json` gets a new entry):
```json
{
  "project": "ep",
  "branch": "tim/ep-241",
  "path": "/Users/tim/IdeaProjects/elternportal-tim-ep-241",
  "port": 5174,
  "dbName": "ep_tim_ep_241",
  "proxyDomain": "ep-tim-ep-241.localhost",
  "created": "2026-03-31"
}
```

### Naming conventions

Everything derives from the branch name and project alias:

| Thing | Pattern | Example |
|---|---|---|
| Branch | as provided | `tim/ep-241` |
| Worktree dir | `../{project}-{branch_slug}/` | `../elternportal-tim-ep-241/` |
| Database | `{alias}_{branch_slug_safe}` | `ep_tim_ep_241` |
| Proxy domain | `{alias}-{branch_slug}.localhost` | `ep-tim-ep-241.localhost` |
| Port | auto-allocated (starts at 5174) | `5174` |

Where `branch_slug` = slashes → hyphens (`tim/ep-241` → `tim-ep-241`) and `branch_slug_safe` = non-alphanumeric → underscores, lowercased.

### .env patching

When creating a workspace, ship copies `.env` files from the main repo to the worktree and rewrites specific variables. Which variables to rewrite is determined during `ship init` (auto-detected from `.localhost` domains and database URLs).

| Original | Patched |
|---|---|
| `DATABASE_URL=postgres://dashboard:pw@localhost:5432/dashboard` | `DATABASE_URL=postgres://dashboard:pw@localhost:5432/ep_tim_ep_241` |
| `BASE_URL=https://elternportal.localhost` | `BASE_URL=https://ep-tim-ep-241.localhost` |
| `BETTER_AUTH_URL=https://elternportal.localhost` | `BETTER_AUTH_URL=https://ep-tim-ep-241.localhost` |

All other env vars are copied as-is.

### Proxy architecture

Ship runs a **Caddy** Docker container (`ship-proxy`) that handles HTTPS termination with auto-generated certificates.

```
Browser → https://ep-tim-ep-241.localhost
       → Caddy container (ports 80/443)
       → reverse_proxy host.docker.internal:5174
       → your dev server
```

The Caddy CA is self-signed. Run `ship proxy trust` once to add it to your macOS keychain so browsers accept the certs without warnings.

### Lifecycle

```
ship init          →  writes ~/.config/ship/config.json
ship create        →  creates worktree + DB + env + proxy route + workspaces.json entry
ship down          →  removes proxy route + drops DB + removes worktree + deletes branch
ship down --db-only →  only drops DB (useful for resetting state)
```

## Configuration

All config lives in `~/.config/ship/`:

| File | Purpose |
|---|---|
| `config.json` | Project definitions, editor preference, auto-open setting |
| `workspaces.json` | Active workspace registry |
| `Caddyfile` | Proxy routes (managed by ship) |
| `caddy-data/` | Caddy TLS certificates |
| `caddy-config/` | Caddy runtime config |

### Example config.json

```json
{
  "editor": "zed",
  "autoOpenEditor": true,
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
