#!/bin/sh
# Runs in the dev tab: provision the ship workspace, put its URL in the Herdr
# sidebar ($url), then start the dev server. A failed create stops here and
# leaves the shell, so re-running this command resumes it.
#   provision.sh <ship-binary> <project> <branch>
set -eu
ship=$1 project=$2 branch=$3

"$ship" create "$project" "$branch" --no-editor

domain=$("$ship" ls "$project" --json --no-pr |
	jq -r --arg b "$branch" '.[] | select(.branch == $b) | .proxyDomain')
if [ -n "$domain" ]; then
	"${HERDR_BIN_PATH:-herdr}" workspace report-metadata "$HERDR_WORKSPACE_ID" \
		--source ship --token "url=https://$domain" >/dev/null || true
fi

exec "$ship" up
