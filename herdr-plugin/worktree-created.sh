#!/bin/sh
# worktree.created: when the repo is a ship project, lay the new workspace out
# as three tabs. ship adopts the worktree Herdr made; other repos: no-op.
#   agent     the root tab, runs pi
#   dev       provision.sh: ship create (database, .env, install, route), then ship up
#   terminal  a plain shell
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

herdr=$HERDR_BIN_PATH
worktree=$(field '.data.worktree.path')
new_tab() {
	"$herdr" tab create --workspace "$HERDR_WORKSPACE_ID" --cwd "$worktree" \
		--label "$1" --no-focus | jq -r .result.root_pane.pane_id
}

"$herdr" tab rename "$HERDR_TAB_ID" agent >/dev/null
dev=$(new_tab dev)
new_tab terminal >/dev/null

"$herdr" pane run "$dev" "sh $(quote "$HERDR_PLUGIN_ROOT/provision.sh") $(quote "$ship") $(quote "$alias") $(quote "$branch")" >/dev/null
"$herdr" pane run "$HERDR_PANE_ID" pi >/dev/null
echo "$alias/$branch: agent $HERDR_PANE_ID, dev $dev"
