# Protect remote branches during workspace teardown

`ship down` and workspace-mode `ship gc` delete a remote branch by default only when its pull request is closed or merged. A missing or open pull request keeps the remote branch. `--remote` explicitly deletes it regardless of pull-request state. Workspace selection, local teardown, database/session GC modes, and the existing best-effort pull-request lookup stay unchanged.

A pull-request lookup failure remains indistinguishable from “no PR” and therefore takes the safe keep path. `gc --force --remote` still auto-selects only merged workspaces; `--remote` changes remote-branch handling, not workspace selection.

## 1. Remote branch decision domain module

Owner: `domain::remote_branch`.

```ts
type PullRequestBranchState =
  | { readonly status: "no-pull-request" }
  | { readonly status: "open"; readonly number: number }
  | { readonly status: "closed" };
// "closed" includes GitHub CLOSED and MERGED states.

type RemoteBranchPolicy = "closed-pull-requests-only" | "always-delete";

type RemoteBranchAction =
  | { readonly action: "keep-no-pull-request" }
  | { readonly action: "keep-open-pull-request"; readonly number: number }
  | { readonly action: "delete" };

function decideRemoteBranch(
  state: PullRequestBranchState,
  policy: RemoteBranchPolicy,
): RemoteBranchAction;
```

The Rust implementation uses ordinary enum variants. It does not add an Effect-style `_tag` convention.

Decision table:

| Policy | PR state | Action |
|---|---|---|
| `ClosedPullRequestsOnly` | no PR | `KeepNoPullRequest` |
| `ClosedPullRequestsOnly` | open | `KeepOpenPullRequest(number)` |
| `ClosedPullRequestsOnly` | closed or merged | `Delete` |
| `AlwaysDelete` | any | `Delete` |

`services::workspace::RemoteBranch` disappears. `TeardownOptions.remote_branch` receives the domain-owned `RemoteBranchAction`. There is no silent generic `Keep` action: every kept remote branch carries the reason rendered by teardown.

## 2. GitHub pull-request projection

Owner: `services::github`, the existing `gh` adapter.

```ts
function pullRequestBranchState(pr: Pr | undefined): PullRequestBranchState;
```

Projection:

```ts
undefined       -> NoPullRequest
state === OPEN  -> OpenPullRequest(number)
state === CLOSED || state === MERGED -> ClosedPullRequest
```

`pr_for_branch` keeps its existing `Option`-like contract. Missing `gh`, repository/remote failures, malformed output, and a branch with no PR still produce `undefined`; the projection does not claim stronger evidence than the adapter has.

## 3. CLI contracts

Owner: `main` clap declarations and command dispatch.

```ts
type DownArgs = {
  readonly project?: string;
  readonly branch?: string;
  readonly force: boolean;
  readonly dbOnly: boolean;
  readonly remote: boolean; // conflicts with dbOnly
};

type GcArgs = {
  readonly force: boolean;
  readonly dryRun: boolean;
  readonly sync: boolean;
  readonly sessions: boolean;
  readonly databases: boolean;
  readonly remote: boolean; // conflicts with sessions and databases
};
```

- `remote: false` maps to `ClosedPullRequestsOnly`.
- `remote: true` maps to `AlwaysDelete`.
- `--remote` is valid with `gc --force`, `gc --dry-run`, and `gc --sync`.
- `--remote` does not alter GC preselection or dry-run workspace verdicts.

## 4. Teardown execution contract

Owner: `services::workspace` for effects and `commands::teardown` for rendering/registry completion.

```ts
type TeardownOptions = {
  readonly removeWorktree: boolean;
  readonly force: boolean;
  readonly remoteBranch: RemoteBranchAction;
};
```

When `removeWorktree` is true, the checklist always includes `RemoteBranch` because every action now has a visible outcome:

```ts
KeepNoPullRequest
  -> Status.SkippedExisting("kept — no PR")

KeepOpenPullRequest(number)
  -> Status.SkippedExisting(`kept — PR #${number} is open`)

Delete
  -> git.delete_remote_branch(...)
  -> Removed      => Status.Done
  -> AlreadyGone  => Status.SkippedExisting
  -> Error        => Status.Warning(error)
```

When `removeWorktree` is false (`down --db-only`), no remote-branch step runs. Existing warning, retry, and registry-retention semantics do not change.

## Call paths

### `ship down`

```text
main::Cli parses Down { project, branch, force, db_only, remote }
→ clap rejects db_only + remote before dispatch
→ commands::down::run(..., remote)
→ resolve one or more workspace targets using the existing cwd/arguments/picker flow
→ if confirmation or ClosedPullRequestsOnly needs PR evidence:
    services::github::look_up_all(selected workspaces)
    → PR/lookup failure projected by pullRequestBranchState
  else:
    no policy-driven PR lookup is required
→ render the existing confirmation when !force
→ domain::remote_branch::decideRemoteBranch(state, policy)
→ build TeardownJob { opts.remote_branch: action }
→ commands::teardown::run_all
→ services::workspace::teardown_all_stream
→ execute the action from §4
→ remove successful workspace registry entries; retain warned/incomplete entries
→ commands::down prints completion or existing typed Error text
```

The picker may still stream PR labels before selection. Selected picker rows may require a second blocking lookup because cell updates do not mutate the row’s stored workspace value; safety policy uses the post-selection lookup, not display text.

Files and evidence:

- `src/commands/down.rs`: carry `remote`, retain selected PR state, select policy/action, and preserve picker/confirmation behavior.
- Prove with the domain decision test from the shared path below and `cargo check`; no command test is added because command orchestration has no injectable GitHub/teardown seam and the pure owner captures the material decision.

### `ship gc` workspace mode

```text
main::Cli parses Gc { force, dry_run, sync, sessions, databases, remote }
→ clap rejects remote + sessions/databases before dispatch
→ commands::gc::run(..., remote)
→ workspace mode performs the existing blocking look_up_all
→ preserve selection:
    force      => merged workspaces only
    interactive => merged prechecked; user may select closed/open/no-PR rows
    dry-run    => existing merged-only workspace verdicts
→ for each selected workspace:
    github::pullRequestBranchState(pr)
    → domain::remote_branch::decideRemoteBranch(state, policy)
    → build TeardownJob { opts.remote_branch: action }
→ commands::teardown::run_all
→ execute the action from §4
→ preserve existing cleanup summary and optional sync
```

Files and evidence:

- `src/commands/gc.rs`: carry `remote` through workspace mode and replace `gc_teardown`’s unsafe no-PR delete fallback with the shared decision.
- Prove with the domain decision test and existing `cargo test`; GC mode selection remains unchanged.

### Shared CLI and remote-branch teardown path

```text
main clap declaration
→ dispatch carries remote to down/gc
→ github adapter projects external PR state
→ remote_branch domain module selects one exhaustive action
→ workspace teardown executes exactly that action
→ teardown renderer exposes kept/deleted/already-gone/warning outcome
```

Files and evidence:

- `src/main.rs`: add both `--remote` flags, conflicts, dispatch arguments, and concise help text.
- `src/domain/mod.rs`, `src/domain/remote_branch.rs`: add the pure state/policy/action owner and a table-driven behavior test covering all decision-table rows.
- `src/services/github.rs`: project `Option<Pr>` to the domain state without changing lookup failure behavior.
- `src/services/workspace.rs`: consume `RemoteBranchAction`, remove the service-owned `RemoteBranch`, show both keep reasons, and keep remote steps out of db-only teardown.
- `CLAUDE.md`: replace the obsolete `down`/`gc` remote-branch rule with the safe-default/explicit-override rule.
- Prove CLI conflicts with parse-only invocations that exit before project I/O: `cargo run -- down --db-only --remote` and `cargo run -- gc --sessions --remote` must fail with clap conflict errors.
- Completion checks: `cargo fmt --check`, `cargo test`, `cargo check`, and warning-free `cargo clippy`, each with observed exit code 0.

## Decisions and watch-outs

- Do not infer “no PR” as permission to delete. The adapter intentionally collapses lookup failure and absence, so only a known closed/merged PR permits default deletion.
- Do not make `--remote` broaden `gc --force` selection. It only overrides protection for workspaces already selected by the existing mode.
- Do not replace the streaming `down` picker with a blocking candidate lookup. A post-selection lookup is the contained cost required for an authoritative safe decision.
- Preserve unrelated in-progress working-tree changes; this change builds on the current parallel teardown shape rather than reverting it.
