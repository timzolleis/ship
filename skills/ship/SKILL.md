---
name: ship
description: Per-branch dev workspaces with the ship CLI — a git worktree, a cloned postgres database, patched .env files, and an HTTPS URL for each branch. Use when working on a branch in its own workspace, starting a project's dev server behind HTTPS, tearing a workspace down, or registering a repo with `ship init`.
---

# ship

`ship create <project> <branch>` gives a branch its own workspace: a git worktree next to the repo, a postgres database cloned from the project's source database (when the project has one), `.env` files patched for both, and `https://<branch>.<alias>.localhost` proxied to the workspace's port.

## Running ship without a terminal

- Prompts answer themselves: a safe default, or exit 1 with `Error: <prompt>: no terminal to ask. Pass <flag>.` Re-run with that flag or argument.
- Exit 0 means everything landed. Exit 1 means it failed, or part of it did: `down` and `gc` keep failed workspaces in the registry, and re-running retries them.
- Read state as JSON: `ship projects --json`, `ship ls [project] --json [--no-pr]`, `ship config show [alias] --json`.
- `ship <command> --help` lists every flag.

## Workspaces

| Task | Command |
|---|---|
| Create or resume | `ship create <project> <branch> [--base <branch>]` |
| Find one | `ship ls <project> --json` → `path`, `proxyDomain`, `port`, `dbName` |
| Dev server | `ship up` in the workspace directory. It blocks until the server exits: run it in the background. ship sets `PORT`. |
| Re-clone the database | `ship reset` in the workspace directory |
| Run SQL | `ship db exec "<sql>"` in the workspace directory |
| Tear down | `ship down <project> <branch> --force` |
| Clean up merged | `ship gc --dry-run`, then `ship gc --force` |

`down` and `gc` delete worktrees, databases, and branches: run them only when the user asks. The remote branch is kept unless its PR is closed or merged; `--remote` deletes it anyway — ask first.

## Registering a project: `ship init`

1. Run `ship init` at the repo root. `--alias <name>` sets the short name (default: the first 3 letters of the directory).
2. Read the output: the env vars ship will rewrite, the paths it copies into each workspace, the database, and a `Left empty` block — every field the repo gave no evidence for, with the reason.
3. For each left-empty field, inspect the repo. Fill what the project needs in config.json (the path is printed), or re-run `ship init` with `--install-cmd`, `--db-cmd`, `--dev-cmd` (each repeatable, in order), `--db-container`, `--db-user`, `--db-source`. On a re-run, flags win, then stored values, then detection.
4. Check with `ship config show <alias> --json`. It fails when config.json does not parse.

Never invent a value the repo does not show; ask the user.

### Config fields, under `projects.<alias>`

- `commands.install`, `commands.db`, `commands.dev`: ordered shell commands, run in the worktree. `db` runs after the database clone (migrations, seeds). The last `dev` command is the server; `{port}` is substituted and `PORT` is set.
- `database` — leave it out when the project has no postgres:
  - `runtime`: `{"_tag": "docker", "container": "<name>"}`, or `{"_tag": "local"}` (reaches localhost:5432 only)
  - `user`, `host`, `port`
  - `source`: the database every workspace clones
  - `namePattern`: workspace database name, e.g. `"<alias>_{branch_slug_safe}"`
- `env.files`: `.env` path → var → `{"type": "<kind>"}`. A file mapped to `{}` is copied verbatim.
  - `database_url`: swap the trailing `/name` for the workspace database (postgres URLs only)
  - `proxy_url`: swap the origin for `https://<workspace domain>`
  - `dev_url`: becomes `http://localhost:<port><path>`; set `"path"` for the suffix
  - `plain`: copy verbatim — sqlite paths, anything worktree-relative
- `copy`: gitignored files or directories copied into each new worktree (sqlite files, certs).

## Updating

After `ship update`, run `ship skill install` to refresh this file.
