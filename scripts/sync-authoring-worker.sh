#!/usr/bin/env bash
# Copies the built authoring worker (tsc/eslint/prettier services) into the parent
# app (immediately-run-site-main) so it is served same-origin with the page. The
# parent's ServiceHost spawns this worker and calls it directly (CLIENT_SERVICES_SPEC
# §6). Run after `npm run build:authoring-worker`. Mirrors sync-babel-worker.sh.
#
# Only `*.js` is copied: the entry (`authoring-worker.js`, stable name) plus
# Parcel's hashed async chunks, which resolve relative to the worker URL under
# /authoring-worker/.
set -euo pipefail

SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )
SRC="$SCRIPT_DIR/../dist-authoring-worker"
DEST="$SCRIPT_DIR/../../immediately-run-site-main/public/authoring-worker"

if [ ! -f "$SRC/authoring-worker.js" ]; then
  echo "error: $SRC/authoring-worker.js not found — run 'npm run build:authoring-worker' first" >&2
  exit 1
fi

rm -rf "$DEST"
mkdir -p "$DEST"
cp "$SRC"/*.js "$DEST"/

# R3-441 — record WHERE the vendored bytes came from, next to the bytes. The
# site-main CI check reads this file, and the docs reconciler refuses to archive
# a sandbox item that touched src/services/authoring/** while this commit
# predates it — the R3-384 case (items archived done while production served a
# pre-fix worker) could then not recur silently.
REPO_COMMIT="$(git -C "$SCRIPT_DIR/.." rev-parse HEAD)"
REPO_DIRTY="$(git -C "$SCRIPT_DIR/.." status --porcelain -- src/services/authoring dist-authoring-worker | wc -l | tr -d ' ')"
cat > "$DEST/PROVENANCE.json" <<EOF
{
  "source": "immediately-run/sandbox",
  "commit": "$REPO_COMMIT",
  "dirty": $([ "$REPO_DIRTY" != "0" ] && echo true || echo false),
  "syncedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "files": [
$(ls "$DEST"/*.js | xargs -n1 basename | sed 's/^/    "/;s/$/"/' | paste -sd, - | sed 's/,/,\n/g')
  ]
}
EOF
echo "Synced $(ls "$DEST"/*.js | wc -l | tr -d ' ') authoring worker file(s) to $DEST"
echo "Provenance: sandbox@${REPO_COMMIT:0:10}$([ "$REPO_DIRTY" != "0" ] && echo ' (dirty authoring sources!)')"
