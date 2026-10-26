---
name: ship
description: Per-branch dev workspaces with the ship CLI — a git worktree, a cloned postgres database, patched .env files, an HTTPS URL and its own ports for each branch. Use when working on a branch in its own workspace, starting a project's dev server behind HTTPS, giving a second server (an API next to the web app) its own port per workspace, tearing a workspace down, or registering a repo with `ship init`.
---

# ship

`ship create <project> <branch>` gives a branch its own workspace: a git worktree next to the repo, a postgres database cloned from the project's source database (when the project has one), `.env` files patched for both, and `https://<branch>.<alias>.localhost` proxied to the workspace's port.

## Running ship without a terminal

- Prompts answer themselves: a safe default, or exit 1 with `Error: <prompt>: no terminal to ask. Pass <flag>.` Re-run with that flag or argument.
- Exit 0 means everything landed. Exit 1 means it failed, or part of it did: `down` and `gc` keep failed workspaces in the registry, and re-running retries them.
- Read state as JSON: `ship projects --json`, `ship ls [project] --json [--no-pr]`, `ship config show [alias] --json`.
- `ship create` opens the user's editor only with a terminal. Pass `--no-editor` anyway (an agent pane may have one); pass `--editor` only when the user asks to see the workspace.
- `ship <command> --help` lists every flag.

## Workspaces

| Task | Command |
|---|---|
| Create or resume | `ship create <project> <branch> [--base <branch>] --no-editor`. A branch already checked out in another worktree is adopted at its path. |
| Find one | `ship ls <project> --json` → `path`, `proxyDomain`, `port`, `ports`, `dbName` |
| Dev server | `ship up` in the workspace directory. It blocks until the server exits: run it in the background. ship sets `PORT`, plus `<NAME>_PORT` per named port. |
| Re-clone the database | `ship reset` in the workspace directory |
| Run SQL | `ship db exec "<sql>"` in the workspace directory |
| Tear down | `ship down <project> <branch> --force` |
| Clean up merged | `ship gc --dry-run`, then `ship gc --force` |

`down` and `gc` delete worktrees, databases, and branches: run them only when the user asks. The remote branch is kept unless its PR is closed or merged; `--remote` deletes it anyway — ask first.

## Dev servers behind the proxy

- The proxy runs in Docker and reaches `host.docker.internal:<port>` over IPv4. A dev server bound only to `localhost` or `::1` is unreachable from it, or another process on that port answers instead: bind to all interfaces (Vite: `server.host: true` or `--host`).
- `PORT` reaches every process `ship up` starts. When the dev command starts two servers (web + API), both read `PORT` and collide: give the second one a named port.

## A second server: named ports

The routed port goes to the server the browser opens. Every other server gets a named port: each workspace has its own value, from the same pool as the routes, so two workspaces never share one.

1. Make the app read the port, never a fixed number: the API listens on `API_PORT` (fallback: the old port, e.g. `PORT=${API_PORT:-3000}` in its dev script), and whatever calls it (the web dev server's proxy target, a URL in `.env`) uses `API_PORT` too.
2. Declare it at the repo root: `ship init --port api=3000`. `3000` stays the main checkout's port; a bare `--port api` takes a free one. Names are lowercase letters, digits, `-`, `_`.
3. A `.env` value that points at the API: `{"type": "dev_url", "port": "api", "path": "/api"}` for a URL, `{"type": "port", "port": "api"}` for a bare number.
4. Check: `ship config show <alias>` lists `NAMED PORTS`; `ship ls <project> --json` shows each workspace's `ports`. Existing workspaces get theirs on the next `ship up`.

`ship up` sets `API_PORT` (`admin-api` → `ADMIN_API_PORT`) and substitutes `{port:api}` in commands. A name the project doesn't declare fails before anything runs. Named ports are not routed through the proxy.

## Registering a project: `ship init`

1. Run `ship init` at the repo root. `--alias <name>` sets the short name (default: the first 3 letters of the directory).
2. Read the output: the env vars ship will rewrite, the paths it copies into each workspace, the database, and a `Left empty` block — every field the repo gave no evidence for, with the reason.
3. For each left-empty field, inspect the repo. Fill what the project needs in config.json (the path is printed), or re-run `ship init` with `--install-cmd`, `--db-cmd`, `--dev-cmd` (each repeatable, in order), `--port <name>[=<port>]` (repeatable), `--db-container`, `--db-user`, `--db-source`. On a re-run, flags win, then stored values, then detection.
4. Check with `ship config show <alias> --json`. It fails when config.json does not parse.

Never invent a value the repo does not show; ask the user.

### Config fields, under `projects.<alias>`

- `commands.install`, `commands.db`, `commands.dev`: ordered shell commands, run in the worktree. `db` runs after the database clone (migrations, seeds). The last `dev` command is the server; `{port}` and `{port:<name>}` are substituted, `PORT` and `<NAME>_PORT` are set.
- `ports`: named ports, name → the main checkout's port, e.g. `{"api": 3000}` (see "A second server").
- `database` — leave it out when the project has no postgres:
  - `runtime`: `{"_tag": "docker", "container": "<name>"}`, or `{"_tag": "local"}` (reaches localhost:5432 only)
  - `user`, `host`, `port`
  - `source`: the database every workspace clones
  - `namePattern`: workspace database name, e.g. `"<alias>_{branch_slug_safe}"`
- `env.files`: `.env` path → var → `{"type": "<kind>"}`. A file mapped to `{}` is copied verbatim.
  - `database_url`: swap the trailing `/name` for the workspace database (postgres URLs only)
  - `proxy_url`: swap the origin for `https://<workspace domain>`
  - `dev_url`: becomes `http://localhost:<port><path>`; set `"path"` for the suffix, `"port": "<name>"` for a named port
  - `port`: becomes the bare port number; `"port": "<name>"` for a named port
  - `plain`: copy verbatim — sqlite paths, anything worktree-relative
- `copy`: gitignored files or directories copied into each new worktree (sqlite files, certs).

## Updating

Installed with `npx skills add timzolleis/ship -g`; refresh it with `npx skills update`.
