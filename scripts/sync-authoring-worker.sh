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
echo "Synced $(ls "$DEST"/*.js | wc -l | tr -d ' ') authoring worker file(s) to $DEST"
