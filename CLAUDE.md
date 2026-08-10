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
├── prompt.rs            # dialoguer wrappers (input/confirm/select) returning crate errors
├── schema.rs            # serde models: ShipConfig, ProjectConfig, Workspace, UpdateCache
├── util.rs              # resolve_path (Node path.resolve semantics), cwd_string, plural
├── domain/              # Pure logic — no IO, no subprocesses
│   ├── caddyfile.rs     # Route codec + next_port allocation
│   ├── env_patch.rs     # .env line rewriting (database_url/proxy_url/dev_url)
│   ├── workspace_locate.rs  # cwd/branch-query → workspace resolution
│   └── workspace_name.rs    # Slugging + {placeholder} pattern resolution
├── services/            # IO layer — plain module functions
│   ├── shell.rs         # Subprocess exec (captured, interactive, sh -c in dir)
│   ├── runner.rs        # ExecutionRuntime dispatch: local passthrough vs docker exec
│   ├── git.rs           # Worktree/branch ops over shell
│   ├── database.rs      # Postgres CLI ops (createdb/dropdb/psql/pg_dump) over runner
│   ├── config.rs        # ~/.config/ship/ config + workspace registry (self-migrating load)
│   ├── copy.rs          # Copies gitignored local state into a new worktree
│   ├── proxy.rs         # Caddy reverse proxy via docker
│   ├── editor.rs        # Detect & open editors ($VISUAL/$EDITOR → GUI apps → terminal)
│   ├── env.rs           # .env file copying/patching (delegates rewriting to domain)
│   ├── claude.rs        # Clears ~/.claude/projects/<slug>/ on teardown
│   ├── sync.rs          # Fetch + ff-pull base checkout, install/generate/migrate on HEAD move
│   ├── updater.rs       # GitHub-release self-update + background version-check cache
│   └── workspace.rs     # Orchestrator: provision / teardown / reset state machines
└── commands/            # One module per subcommand; owns rendering + error printing
```

## Key Conventions

- **Layering**: commands → services → domain. Domain modules are pure (no IO); services do IO through `shell`/`runner`; commands only render and prompt. Don't shell out from commands directly.
- **Errors**: one `Error` variant per failure mode in `src/errors.rs`, with the user-facing message in `#[error(...)]`. Commands catch at their boundary and print (`eprintln!("\n  {} {}\n", red("Error:"), e)` or command-specific formats) — they don't propagate to `main`.
- **Nonzero exits**: `shell::exec` (captured) fails on nonzero exit; `exec_interactive`/`exec_in_dir` (inherited stdio) deliberately do NOT — only spawn failures error. A failing dev server must not fail `ship up`.
- **Formatting**: import from `src/fmt.rs`. Never define local ANSI helpers. Pad columns BEFORE colorizing (ANSI codes break format widths). Color is dropped automatically when stdout isn't a TTY or `NO_COLOR` is set.
- **Env rewriting**: `env.files` maps each .env path to its own vars, because one name needs different handling per package (shared postgres `DATABASE_URL` gets rewritten, a worktree-relative sqlite one is `plain`). The pre-per-file flat `autoDetected` shape still decodes by fanning every var out to every file. `ship config show` reports the stored handling with on-disk line numbers.
- **Workspace state has three sources**: tracked files come from the git checkout, postgres from `database::clone_db`, and file-backed state (sqlite, certs, fixtures) from `copy::copy_paths` over the project's `copy` list. `init` proposes copy paths only when git ignores them — tracked files already arrive with the checkout.
- **Prompts**: through `src/prompt.rs` only (it strips trailing `:` — dialoguer adds its own).
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
| `config.json` | Projects, editor pref, autoOpenEditor |
| `workspaces.json` | Active workspace entries |
| `update-cache.json` | Last release check (refreshed by hidden `__refresh-update-cache` worker) |
| `Caddyfile` | Caddy reverse proxy routes |
| `caddy-data/` | Caddy TLS certificates |
| `caddy-config/` | Caddy runtime config |

## Release Pipeline

`.github/workflows/release.yml`: every push to `main` builds `ship-darwin-arm64` + `ship-darwin-x64` on a macOS runner (arm64 natively, x64 via `x86_64-apple-darwin` target), ad-hoc codesigns them, and publishes a GitHub release tagged with the git short SHA. `ship update` matches its embedded version against the latest release tag and swaps the binary in place, so tag, `SHIP_VERSION`, and asset names must stay in lockstep.
