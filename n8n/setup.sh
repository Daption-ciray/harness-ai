#!/usr/bin/env bash
# Imports the harness workflows into a local n8n, with the credential they need.
#
# The token is read from the harness sidecar and written to a temporary file that
# is deleted immediately after import — it should not sit on disk next to the
# workflows, and it must never reach the repository.
set -euo pipefail

REPO="${1:-$PWD}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export N8N_USER_FOLDER="${N8N_USER_FOLDER:-$HOME/.n8n-harness}"

SLUG="$(cd "$REPO" && node -e "
  import('$HERE/../src/paths.ts').then(m => console.log(m.resolvePaths(process.cwd()).slug))
")"
TOKEN_FILE="${HARNESS_HOME:-$HOME/.harness}/$SLUG/api-token"

if [ ! -f "$TOKEN_FILE" ]; then
  echo "no API token yet — run \`harness serve\` once in $REPO, then try again" >&2
  exit 1
fi

CRED="$(mktemp -t harness-cred)"
trap 'rm -f "$CRED"' EXIT
# A stable id, so re-running updates the credential instead of adding another.
cat > "$CRED" <<JSON
[{
  "id": "harnessApiToken",
  "name": "harness",
  "type": "httpHeaderAuth",
  "data": { "name": "Authorization", "value": "Bearer $(cat "$TOKEN_FILE")" }
}]
JSON

# Errors are shown, not swallowed. The first version of this script sent both
# imports to /dev/null and died silently under `set -e`, which is the worst
# possible outcome for a setup step: it looks like it did nothing at all.
quiet_migrations() { grep -viE "^(Starting|Finished) migration" || true; }
n8n import:credentials --input="$CRED" 2>&1 | quiet_migrations
n8n import:workflow --separate --input="$HERE/workflows/" 2>&1 | quiet_migrations

echo "imported: 7 role workflows + the coordinator, and a credential called 'harness'"
echo
echo "next:"
echo "  1. in $REPO:   harness serve"
echo "  2. anywhere:   N8N_USER_FOLDER=$N8N_USER_FOLDER n8n start"
echo "  3. open http://127.0.0.1:5678, pick the credential named 'harness' on the"
echo "     HTTP nodes if it is not already selected, then activate 'harness · coordinator'"
