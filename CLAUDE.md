# CLAUDE.md

## Overview

**ship** is a CLI tool for managing project-aware git worktrees, databases, and an HTTPS reverse proxy. Written in Rust (clap, serde, dialoguer, ureq). Compiles to a small static binary (~2.3 MB release).

## Commands

```bash
cargo run -- <args>          # Dev run (version reports "dev"; update checks disabled)
cargo build --release        # Release binary at target/release/ship
cargo check                  # Typecheck
cargo clippy                 # Lint — must stay warning-free
```

After build, copy `target/release/ship` to `~/.local/bin/ship`.

## Architecture

```
src/
├── main.rs              # clap CLI definition, custom help text, dispatch, post-run update hooks
├── version.rs           # VERSION: "dev" in debug builds, git short SHA in release (via build.rs)
├── errors.rs            # thiserror Error enum — one variant per failure mode, user-facing Display
├── fmt.rs               # Shared ANSI formatting (bold, dim, green, red, blue, yellow)
├── prompt.rs            # Prompt entry points: dialoguer for input/confirm, ui::Picker for lists
├── ui/                  # Terminal widgets
│   ├── table.rs         # Rows of cells + ANSI-aware column widths (pure)
│   ├── picker.rs        # Single/multi list picker; cells can stream in from a background lookup
│   ├── live.rs          # Static table whose pending cells spin until a lookup fills them
│   └── progress.rs      # Live checklist; the running row spins, results land in place
├── schema.rs            # serde models: ShipConfig, ProjectConfig, Workspace, UpdateCache
├── util.rs              # resolve_path (Node path.resolve semantics), cwd_string, plural
├── domain/              # Pure logic — no IO, no subprocesses
│   ├── caddyfile.rs     # Route codec + next_port allocation
│   ├── db_orphans.rs    # Databases matching a project pattern that no workspace claims
│   ├── env_patch.rs     # .env line rewriting (database_url/proxy_url/dev_url)
│   ├── session_slug.rs  # Agent session dir name ↔ path (a `-` is a literal or a `/`)
│   ├── workspace_locate.rs  # cwd/branch-query → workspace resolution
│   └── workspace_name.rs    # Slugging + {placeholder} pattern resolution (both directions)
├── services/            # IO layer — plain module functions
│   ├── shell.rs         # Subprocess exec (captured, interactive, sh -c in dir)
│   ├── runner.rs        # ExecutionRuntime dispatch: local passthrough vs docker exec
│   ├── git.rs           # Worktree/branch ops over shell
│   ├── github.rs        # PR lookup via gh CLI (parallel) + shared PR label
│   ├── database.rs      # Postgres CLI ops (createdb/dropdb/psql/pg_dump) over runner
│   ├── config.rs        # ~/.config/ship/ config + workspace registry (self-migrating load)
│   ├── copy.rs          # Copies gitignored local state into a new worktree
│   ├── proxy.rs         # Caddy reverse proxy via docker
│   ├── editor.rs        # Detect & open editors ($VISUAL/$EDITOR → GUI apps → terminal)
│   ├── env.rs           # .env file copying/patching (delegates rewriting to domain)
│   ├── agent.rs         # Agent session stores: list, remove for a path, find orphans
│   ├── sync.rs          # Fetch + ff-pull base checkout, install/generate/migrate on HEAD move
│   ├── updater.rs       # GitHub-release self-update + background version-check cache
│   └── workspace.rs     # Orchestrator: provision / teardown / reset state machines
└── commands/            # One module per subcommand; owns rendering + error printing
    └── teardown.rs      # Not a subcommand: shared teardown checklist for `down` and `gc`
```

## Key Conventions

- **Layering**: commands → services → domain. Domain modules are pure (no IO); services do IO through `shell`/`runner`; commands only render and prompt. Don't shell out from commands directly. `ui/` is presentation only — it never learns what a workspace or a PR is; callers map their own values into `Update`s.
- **Errors**: one `Error` variant per failure mode in `src/errors.rs`, with the user-facing message in `#[error(...)]`. Commands catch at their boundary and print (`eprintln!("\n  {} {}\n", red("Error:"), e)` or command-specific formats) — they don't propagate to `main`.
- **Nonzero exits**: `shell::exec` (captured) fails on nonzero exit; `exec_interactive`/`exec_in_dir` (inherited stdio) deliberately do NOT — only spawn failures error. A failing dev server must not fail `ship up`.
- **Formatting**: import from `src/fmt.rs`. Never define local ANSI helpers. Color is dropped automatically when stdout isn't a TTY or `NO_COLOR` is set.
- **Aligned columns**: build `ui::Row`s and let `ui::Table` measure them. It ignores ANSI codes, so cells may arrive pre-colored. Hand-rolled `{:<22}` padding breaks on long values — that's what it replaced.
- **Slow list data**: give the row a `.pending()` cell and feed `Picker::stream` a `Receiver`. The list draws at once, a spinner holds the column, and each result swaps in. `services::github::look_up_stream` is the reference producer.
- **Live listings**: `ui::Live` draws a table once and swaps late cells in as they land, in any order (`ship ls` + `github::look_up_stream`). Use `Progress` instead when the work is sequential steps. `Live` never truncates piped output — a pipe has no width, and cutting there drops data.
- **Tearing a workspace down**: always `commands::teardown::run` — it draws the checklist and drops the registry entry. Callers differ only in `TeardownOptions` (`gc` deletes the remote branch and forces; `down` does neither). A warned step keeps the registry entry so the next run retries it; steps skip what is already gone, so retrying is safe.
- **`ship gc` has three exclusive modes**: default sweeps workspaces (blocking PR lookup, then a picker with merged rows pre-checked), `--databases` sweeps unclaimed databases, `--sessions` sweeps orphaned agent transcripts. The database sweep pings every project's server, which is why it is not part of the default run.
- **Live step lists**: pair `ui::Progress` with a `*_stream` service that runs the work on a thread and sends one event per finished step (`workspace::teardown_stream`). `Progress` spins the first unfinished row, so the work must be sequential. Only steps whose output is captured may animate — `sync`'s install/migrate commands inherit stdio and would trample the table, which is why provisioning still buffers.
- **Env rewriting**: `env.files` maps each .env path to its own vars, because one name needs different handling per package (shared postgres `DATABASE_URL` gets rewritten, a worktree-relative sqlite one is `plain`). The pre-per-file flat `autoDetected` shape still decodes by fanning every var out to every file. `ship config show` reports the stored handling with on-disk line numbers.
- **Agent sessions**: every harness stores transcripts in one dir per project path, flattening `/` to `-` — `services::agent::STORES` lists the roots. The flattening is lossy, so a name only proves which path it means when that path exists: `session_slug::resolve` tries each `-` both ways and prunes against the filesystem. `gc --sessions` only considers names under a project's worktree prefix and only deletes ones no live path claims. Teardown skips the step when `deleteAgentSessions` is false.
- **Workspace state has three sources**: tracked files come from the git checkout, postgres from `database::clone_db`, and file-backed state (sqlite, certs, fixtures) from `copy::copy_paths` over the project's `copy` list. `init` proposes copy paths only when git ignores them — tracked files already arrive with the checkout.
- **Prompts**: through `src/prompt.rs` only (it strips trailing `:` — dialoguer adds its own). Reach for `ui::Picker` directly only when a list needs streaming cells or the picked row's cells.
- **Editor opening**: always `editor::open()`, never exec an editor directly.
- **Config JSON**: camelCase keys, 2-space pretty print, trailing newline. `IndexMap` preserves key order. Legacy `database.container` shape is decoded and canonically written back on load — keep that tolerance.
- **Versioning**: `build.rs` embeds the git short SHA (or `$SHIP_VERSION` when set — CI uses this to pin the binary version to the release tag). Debug builds report `dev`, which disables update checks and self-update.
- **Clippy after every change**: `cargo clippy` must stay warning-free.

## Error Variants (src/errors.rs)

`ProjectNotFound`, `ParseConfig`, `EncodeConfig`, `CreateDirectory`, `ReadFile`, `WriteFile`, `ShellExec`, `Database`, `DatabaseUnreachable`, `RouteExists`, `RouteNotFound`, `CertNotFound`, `UpdateCheck`, `UpdateDownload`, `UpdateInstall`, `UnsupportedPlatform`, `WorkspaceNotFound`, `NoActiveWorkspaces`, `Prompt`.

## Config Storage

All state lives in `~/.config/ship/`:

| File | Contents |
|------|----------|
| `config.json` | Projects, editor pref, autoOpenEditor, deleteAgentSessions |
| `workspaces.json` | Active workspace entries |
| `update-cache.json` | Last release check (refreshed by hidden `__refresh-update-cache` worker) |
| `Caddyfile` | Caddy reverse proxy routes |
| `caddy-data/` | Caddy TLS certificates |
| `caddy-config/` | Caddy runtime config |

## Release Pipeline

`.github/workflows/release.yml`: every push to `main` builds `ship-darwin-arm64` + `ship-darwin-x64` on a macOS runner (arm64 natively, x64 via `x86_64-apple-darwin` target), ad-hoc codesigns them, and publishes a GitHub release tagged with the git short SHA. `ship update` matches its embedded version against the latest release tag and swaps the binary in place, so tag, `SHIP_VERSION`, and asset names must stay in lockstep.
