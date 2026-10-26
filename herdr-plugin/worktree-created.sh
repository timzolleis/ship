#!/bin/sh
# worktree.created: when the repo is a ship project, run `ship create` in the
# new worktree's pane. ship adopts the worktree Herdr made and adds the
# database clone, .env patches, install, and proxy route. Other repos: no-op.
set -eu

# The pane's shell may resolve a different ship; run the one that matched.
ship=$(command -v ship) || exit 0

field() { printf '%s' "$HERDR_PLUGIN_EVENT_JSON" | jq -r "$1 // empty"; }
resolve() { (cd "$1" 2>/dev/null && pwd -P); }

branch=$(field '.data.worktree.branch')
repo_root=$(field '.data.workspace.worktree.repo_root')
[ -n "$branch" ] && [ -n "$repo_root" ] || exit 0 # detached HEAD
root=$(resolve "$repo_root") || exit 0

tab=$(printf '\t')
alias=$("$ship" projects --json | jq -r '.[] | [.alias, .path] | @tsv' |
	while IFS=$tab read -r a path; do
		if [ "$(resolve "$path")" = "$root" ]; then
			printf '%s' "$a"
			break
		fi
	done)
[ -n "$alias" ] || exit 0

quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

"$HERDR_BIN_PATH" pane run "$HERDR_PANE_ID" \
	"$(quote "$ship") create $(quote "$alias") $(quote "$branch") --no-editor"
echo "ship create $alias $branch in $HERDR_PANE_ID"
