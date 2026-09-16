# ship

One command per branch. `ship create` gives a branch its own git worktree, its own
Postgres database cloned from your dev data, patched `.env` files, an HTTPS URL, and
your editor open on it. `ship down` takes it all away again.

Written in Rust. Single ~2 MB static binary, no runtime.

## What it does

| Capability | How |
|---|---|
| **Isolated worktrees** | `ship create ep tim/ep-241` checks out the branch at `../elternportal-tim-ep-241/` next to your main repo. |
| **Cloned databases** | Each workspace gets `ep_tim_ep_241`, a `pg_dump \| psql` copy of your source database. Reset it any time. |
| **Patched `.env` files** | Database names, proxy origins and callback URLs are rewritten per workspace; everything else is copied verbatim. Handling is configured per file and per variable. |
| **Local state carried over** | Gitignored files a checkout can't bring (sqlite databases, certs, fixtures) are copied into the new worktree. |
| **HTTPS for every branch** | A Caddy container serves `https://tim-ep-241.ep.localhost` and proxies to the port ship allocated. Trust the CA once, no browser warnings after. |
| **Custom command sequences** | Per project: an ordered `install` scope, a `db` scope (migrate, seed) and a `dev` scope. `{port}` is substituted. Blank line ends a scope during `ship init`. |
| **Idempotent, resumable create** | Every resource is probed first. A create that died halfway picks up where it stopped, and a finished one just re-opens the editor. |
| **Base kept fresh** | Before a new worktree, ship fetches and fast-forwards your base branch, reinstalls and migrates the source database when HEAD moved. |
| **PR-aware listing and cleanup** | `ship ls` streams PR status from `gh` into the table. `ship gc` preselects workspaces whose PR is merged and tears them down, remote branch included. |
| **Orphan sweeps** | `gc --databases` drops databases no workspace claims. `gc --sessions` deletes Claude Code and Pi transcripts whose worktree is gone. |
| **Agent transcript cleanup** | Teardown removes the worktree's coding-agent session directories so transcripts don't pile up for dead branches. Toggle with `ship config sessions off`. |
| **Editor integration** | Detects `$VISUAL`/`$EDITOR`, then Zed, Cursor, VS Code, Sublime, then nvim/vim/vi. Remembers what worked. |
| **Self-updating** | `ship update` swaps the binary for the latest GitHub release. A background check runs at most hourly and prints a one-line notice when you're behind. |
| **Scriptable** | Color drops when stdout isn't a TTY or `NO_COLOR` is set. Pickers print their rows and exit when stdin isn't a terminal. `ship init` takes every answer as a flag. |

## Install

Prebuilt macOS binaries (`ship-darwin-arm64`, `ship-darwin-x64`) are attached to
every [GitHub release](https://github.com/timzolleis/ship/releases/latest):

```bash
curl -fsSL -o ~/.local/bin/ship \
  https://github.com/timzolleis/ship/releases/latest/download/ship-darwin-arm64
chmod +x ~/.local/bin/ship
```

Or build from source:

```bash
git clone https://github.com/timzolleis/ship && cd ship
cargo build --release
cp target/release/ship ~/.local/bin/ship
```

Afterwards `ship update` keeps a release build current. Source builds report
version `dev` and never self-update.

### Prerequisites

- **Docker**, for the Caddy proxy and (by default) the Postgres container ship runs `createdb`/`pg_dump`/`psql` in
- **git** 2.5+ (worktrees)
- **gh** (GitHub CLI), optional, for PR status in `ls`, `down` and `gc`
- macOS for `proxy trust`, `open url` and `update`; everything else is plain POSIX

## Quick start

```bash
# 1. Register a project (run inside the repo, answer a few prompts)
cd ~/IdeaProjects/elternportal
ship init

# 2. Start the proxy and trust its CA — once per machine
ship proxy start
ship proxy trust

# 3. Create a workspace for a branch
ship create ep tim/ep-241

# 4. Work in it
cd ../elternportal-tim-ep-241
ship up --open              # dev server + https://tim-ep-241.ep.localhost

# 5. Tear it down when the PR is merged
ship gc                     # or: ship down ep tim/ep-241
```

## Command reference

```
Project setup
  ship init                             Register the current directory (interactive)
  ship init --alias ep --dev-cmd ...    Same, non-interactive
  ship projects                         List registered projects
  ship config show [alias] [--all]      Show env handling and copy paths with file line numbers
  ship config sessions [on|off]         Delete agent transcripts on teardown (default on)

Workspace lifecycle
  ship create [project] [branch]        Create or resume a workspace
  ship create ep feat --base develop    Branch off a specific base
  ship down [project] [branch]          Tear down (cwd workspace, or a picker)
  ship down --force                     Skip confirmation and dirty-worktree checks
  ship down --db-only                   Drop the database and route, keep the worktree
  ship ls [project] [--no-pr]           List workspaces (PR status streams in)
  ship index [project] [--all] [--dry-run]   Register worktrees created outside ship

Day to day
  ship up [--open]                      Start dev server + proxy (workspace or project root)
  ship open [branch] [editor|url|db]    Open editor, browser, or psql
  ship reset                            Drop the workspace DB, re-clone, re-run db commands
  ship db exec "<sql>"                  Run SQL against the workspace database
  ship sync <project>                   Fetch, fast-forward main, install, migrate source DB

Cleanup
  ship gc [--force] [--dry-run] [--sync]     Tear down workspaces whose PR is merged
  ship gc --databases [--force] [--dry-run]  Drop databases no workspace claims
  ship gc --sessions  [--force] [--dry-run]  Delete agent transcripts with no worktree left

Proxy
  ship proxy start | stop | status      Caddy container lifecycle
  ship proxy ls                         List routes
  ship proxy add <domain> <port>        Add a route by hand
  ship proxy rm <domain>                Remove a route
  ship proxy trust                      Trust the Caddy CA in the macOS keychain
  ship proxy edit                       Open the Caddyfile in $EDITOR, reload on exit
  ship proxy next-port                  Print the next free port

  ship update                           Install the latest release
```

## Commands in detail

### `ship init`

Run inside the repository. Registers it under an alias and walks through:

1. **Alias and path.** Defaults to the first three letters of the directory name.
2. **`.env` detection.** Every `.env` outside `node_modules`, `dist`, `.next` and friends is
   scanned. Variables are proposed with a handling based on their name and value:

   | Variable | Value | Proposed handling |
   |---|---|---|
   | `DATABASE_URL`, `*_DATABASE_URL` | any | `database_url` — swap the trailing `/name` |
   | `*_URL` | contains `.localhost` | `proxy_url` — swap the origin for the workspace domain |
   | `*_CALLBACK_URL` | starts with `http://localhost` | `dev_url` — replace with `http://localhost:{port}<path>` |

   Confirm the table with enter, or pick individual rows to change. `plain` copies a
   value untouched, which is what a worktree-relative sqlite `DATABASE_URL` needs.
   Handling is stored per file, so the same variable name can be rewritten in one
   package and left alone in another. Choices you made before survive a re-run.
3. **Local state.** Gitignored `.db`, `.sqlite`, `.pem`, `.key`, `.crt` files are proposed
   for the project's `copy` list, as their containing directory when that is itself
   ignored (so a sqlite file travels with its `-wal`/`-shm` siblings). Sizes are shown
   before you tick them.
4. **Database.** User, host, port and source database are inferred from the first
   Postgres `DATABASE_URL`. You confirm the Docker container name to run the Postgres
   CLI tools in.
5. **Command scopes.** Three ordered lists, each ending on a blank line:
   - `install` runs after the worktree exists (`pnpm install`, `pnpm db generate`, ...)
   - `db` runs after the database is cloned and on `ship reset` (`pnpm db migrate:deploy`, seeds, ...)
   - `dev` runs on `ship up`; the last entry is the long-running server, `{port}` is replaced
6. **Root route.** `https://<alias>.localhost` is registered for the main checkout, so
   `ship up` from the project root works too.

Re-running `ship init` on a known alias updates it. Every prompt defaults to the
stored value. Non-interactive:

```bash
ship init --alias ep --path . \
  --db-container postgres --db-user dashboard --db-source dashboard \
  --install-cmd "pnpm install" --install-cmd "pnpm db generate" \
  --db-cmd "pnpm db migrate:deploy" \
  --dev-cmd "pnpm web dev -p {port}"
```

`ship config show` prints the resulting env handling and copy list together with the
line numbers in `config.json`, for when you'd rather edit the file directly.

### `ship create`

```bash
ship create ep tim/ep-241            # explicit
ship create                          # pick the project, type the branch
ship create ep tim/ep-241 --base develop
```

What happens, in order:

1. **Probe.** Registry entry, worktree, database and proxy route are each checked. If all
   four exist, ship prints the URL and offers to open the editor. If some exist, it
   resumes and skips those steps. If the database server is unreachable, it stops
   before touching anything.
2. **Register** the workspace in `workspaces.json` first, so a crash later is visible to
   `ship ls` and retryable.
3. **Sync base.** Fetch and fast-forward `main`, then run the `install` and `db` scopes
   in the main checkout when HEAD moved. With `--base`, only that ref is fast-forwarded.
   A dirty or diverged main is a warning, not a stop.
4. **Worktree** at the configured `dirPattern`, new branch or existing one.
5. **Database** cloned from the source with `createdb` + `pg_dump | psql`.
6. **Copy** the project's `copy` paths into the worktree. A missing source is a warning.
7. **Env.** Each configured `.env` is copied and its variables rewritten. The changes
   are printed as a before/after diff.
8. **Install** and **db** scopes run inside the worktree.
9. **Proxy route** is added to the Caddyfile and Caddy is reloaded.
10. **Editor** opens. The first time, ship asks whether to always do this.

### `ship down` and `ship gc`

Both run the same checklist per workspace, live: proxy route, database, worktree,
local branch, remote branch (gc only), agent sessions. A step that fails is shown as a
warning and the registry entry stays, so the next run retries it. Steps skip what is
already gone.

- **`ship down`** inside a worktree tears down that one. Outside, with no arguments, it
  opens a multi-select picker over every workspace with PR status filling in as `gh`
  answers. `--db-only` drops only the database and route.
- **`ship gc`** looks up every workspace's PR first, then opens the picker with merged
  ones pre-checked. It forces the worktree removal and deletes the remote branch.
  `--force` skips the picker and takes exactly the merged set. `--sync` fast-forwards
  and migrates the affected projects afterwards.
- **`ship gc --databases`** lists every database on each project's server that matches
  its `dbNamePattern` but is claimed by no workspace, with sizes, and lets you drop
  them. Nothing is pre-checked. An unreachable server is skipped, not treated as empty.
- **`ship gc --sessions`** finds coding-agent transcript directories whose flattened
  path falls under a project's worktree prefix but no longer exists on disk. Only paths
  ship could have created are considered.

All three modes accept `--dry-run`.

### `ship up`

Run inside a workspace or the project root. Starts the proxy container if it isn't
running, ensures the route, prints the URL, then runs the `dev` scope in order. All
but the last command run to completion; the last one is the server and blocks.
`--open` opens the browser two seconds in. A dev server that exits nonzero does not
fail `ship up`.

### `ship open`

```bash
ship open                      # current workspace in the editor
ship open 241                  # fuzzy branch: exact, then */241, then substring
ship open tim/ep-241 url       # that workspace's HTTPS URL
ship open db                   # psql into the current workspace's database
```

Outside a workspace with no branch given, a picker appears.

### `ship reset`, `ship db exec`, `ship sync`

- **`ship reset`** drops the workspace database, clones it again from the source, and
  re-runs the `db` scope. Run inside a workspace.
- **`ship db exec "<sql>"`** runs SQL against the current workspace's database without
  knowing its container, user or name. `"\dt"` works too.
- **`ship sync <project>`** is the base-sync step on its own: fetch, fast-forward main,
  install and migrate the source database when HEAD moved. `ship create` and
  `ship gc --sync` call it for you.

### `ship ls`, `ship projects`, `ship index`

- **`ship ls [project]`** prints project, branch, port and PR. The table draws at once and
  each PR cell swaps in as `gh` answers. `--no-pr` skips the lookup.
- **`ship projects`** lists registered aliases with their paths and database containers.
- **`ship index`** finds worktrees under a project that ship didn't create, derives their
  database name and domain from the project's patterns, reports whether the database
  and route already exist, and registers them so `ls`, `down` and `gc` see them.

### `ship proxy`

Ship runs Caddy 2 in a container named `ship-proxy` on ports 80 and 443 with the
Caddyfile from `~/.config/ship/` mounted read-only.

```
Browser → https://tim-ep-241.ep.localhost
       → ship-proxy (Caddy, ports 80/443, auto TLS)
       → reverse_proxy host.docker.internal:5175
       → your dev server
```

Caddy issues certificates from its own CA. `ship proxy trust` adds that CA to the macOS
system keychain once. `ship proxy edit` opens the Caddyfile in `$EDITOR` and reloads
Caddy when you exit. Ports are allocated from 5174 upwards (the root route registered by `ship init` takes the
first one), filling holes left by
removed routes.

### `ship update`

Compares the embedded version (the git short SHA of the release) against the latest
GitHub release tag, downloads the matching `ship-darwin-*` asset, ad-hoc codesigns it
and swaps it in place. Independently of that, every command spawns a background
version check when the last one is older than an hour, and prints
`ship <sha> is available` on stderr when you're behind. Debug builds skip all of this.

## How ship names things

Everything derives from the project alias and the branch name:

| Thing | Default pattern | `ep` + `tim/ep-241` |
|---|---|---|
| Worktree | `../<repo-dir>-{branch_slug}/` | `../elternportal-tim-ep-241/` |
| Database | `{alias}_{branch_slug_safe}` | `ep_tim_ep_241` |
| Proxy domain | `{branch_slug}.{alias}.localhost` | `tim-ep-241.ep.localhost` |
| Root route | `{alias}.localhost` | `ep.localhost` |
| Port | next free from 5174, root route first | `5175` |

`branch_slug` turns `/` into `-`. `branch_slug_safe` lowercases and turns every
non-alphanumeric character into `_`. The three patterns live under `worktree` in the
project config and can be edited; `{project}` is also available as a placeholder.

### What a workspace looks like on disk

```
~/IdeaProjects/
├── elternportal/                      # main repo, where you ran `ship init`
│   ├── apps/dashboard/.env            # source .env, read but never modified
│   └── ...
└── elternportal-tim-ep-241/           # git worktree on branch tim/ep-241
    ├── apps/dashboard/.env            # copied and patched
    ├── packages/db/.env               # copied and patched
    └── development/sqlite-data/       # copied from the `copy` list
```

```
# Postgres, inside the `postgres` container
dashboard          # source, never modified
ep_tim_ep_241      # clone

# ~/.config/ship/Caddyfile
tim-ep-241.ep.localhost {
    reverse_proxy host.docker.internal:5175
}

# ~/.config/ship/workspaces.json
{
  "project": "ep",
  "branch": "tim/ep-241",
  "path": "/Users/tim/IdeaProjects/elternportal-tim-ep-241",
  "port": 5175,
  "dbName": "ep_tim_ep_241",
  "proxyDomain": "tim-ep-241.ep.localhost",
  "created": "2026-09-16"
}
```

### `.env` patching

| Handling | Before | After |
|---|---|---|
| `database_url` | `postgres://u:p@localhost:5432/dashboard` | `postgres://u:p@localhost:5432/ep_tim_ep_241` |
| `proxy_url` | `https://ep.localhost/some/path` | `https://tim-ep-241.ep.localhost/some/path` |
| `dev_url` (path `/api/auth`) | `http://localhost:3000/api/auth` | `http://localhost:5175/api/auth` |
| `plain` | `file:../../dev/database.db` | `file:../../dev/database.db` |

Only `KEY=VALUE` lines whose key is configured are touched. Comments, blank lines and
unconfigured keys are preserved byte for byte.

## Configuration

All state lives in `~/.config/ship/`:

| File | Contents |
|---|---|
| `config.json` | Projects, editor, `autoOpenEditor`, `deleteAgentSessions` |
| `workspaces.json` | Active workspace registry |
| `update-cache.json` | Last release check |
| `Caddyfile` | Proxy routes, one block per domain |
| `caddy-data/` | Caddy TLS certificates and the CA (`caddy/pki/authorities/local/root.crt`) |
| `caddy-config/` | Caddy runtime state |

### Example `config.json`

```json
{
  "editor": "zed",
  "autoOpenEditor": true,
  "deleteAgentSessions": true,
  "projects": {
    "ep": {
      "path": "/Users/tim/IdeaProjects/elternportal",
      "domain": "ep.localhost",
      "port": 5174,
      "database": {
        "runtime": { "_tag": "docker", "container": "postgres" },
        "user": "dashboard",
        "source": "dashboard",
        "host": "localhost",
        "port": 5432
      },
      "commands": {
        "install": ["pnpm install", "pnpm db generate"],
        "db": ["pnpm db migrate:deploy", "pnpm db seed"],
        "dev": ["pnpm web dev -p {port}"]
      },
      "env": {
        "files": {
          "apps/dashboard/.env": {
            "DATABASE_URL": { "type": "database_url" },
            "BASE_URL": { "type": "proxy_url" },
            "BETTER_AUTH_URL": { "type": "proxy_url" },
            "OAUTH_CALLBACK_URL": { "type": "dev_url", "path": "/api/auth/callback" }
          },
          "apps/console/.env": {
            "DATABASE_URL": { "type": "plain" }
          }
        }
      },
      "copy": ["development/sqlite-data", "certs/localhost.pem"],
      "worktree": {
        "dirPattern": "../elternportal-{branch_slug}/",
        "proxyDomainPattern": "{branch_slug}.ep.localhost",
        "dbNamePattern": "ep_{branch_slug_safe}"
      }
    }
  }
}
```

`database.runtime` can also be `{ "_tag": "local" }` to run the Postgres CLI tools on
the host instead of inside a container. Older configs with a flat `env.autoDetected`
map or a bare `database.container` string are still read and rewritten to the current
shape on the next save.

### Agent sessions

Coding agents keep transcripts outside the worktree, keyed by its path. Ship knows the
stores of Claude Code (`~/.claude/projects`) and Pi (`~/.pi/agent/sessions`,
`~/.Claude Code/agent/sessions`). Teardown deletes the directories for the removed
worktree; `ship config sessions off` keeps them, and `ship gc --sessions` cleans up
later. Ship only ever considers directories under a registered project's worktree
prefix.

## Development

```bash
cargo run -- <args>            # version reports "dev", update checks disabled
cargo check
cargo clippy                   # must stay warning-free
cargo test
cargo build --release          # target/release/ship
```

Layout: `commands/` render and prompt, `services/` do IO, `domain/` is pure logic,
`ui/` holds the table, picker, live-table and progress widgets. See `CLAUDE.md` for
the conventions.

Every push to `main` builds and codesigns both macOS binaries and publishes a release
tagged with the commit's short SHA, which is also the version `ship --version` reports.

## Built with

- [clap](https://github.com/clap-rs/clap), [dialoguer](https://github.com/console-rs/dialoguer),
  [serde](https://serde.rs), [ureq](https://github.com/algesten/ureq)
- [Caddy](https://caddyserver.com) for automatic HTTPS
