#!/bin/sh
# worktree.removed: when ship manages the removed worktree, tear down the rest
# of its workspace: proxy route, database, registry entry, agent sessions. The
# local branch survives when it holds unpushed commits, as Herdr's dialog
# promises. Runs without a pane; output lands in `herdr plugin log list`.
set -eu

ship=$(command -v ship) || exit 0

path=$(printf '%s' "$HERDR_PLUGIN_EVENT_JSON" | jq -r '.data.worktree.path // empty')
[ -n "$path" ] || exit 0

# The checkout is gone, so match the registry by path, not by resolving it.
target=$("$ship" ls --json --no-pr |
	jq -r --arg p "${path%/}" '.[] | select((.path | rtrimstr("/")) == $p) | [.project, .branch] | @tsv' |
	head -n 1)
[ -n "$target" ] || exit 0

project=${target%%"$(printf '\t')"*}
branch=${target#*"$(printf '\t')"}
exec "$ship" down "$project" "$branch" --force
