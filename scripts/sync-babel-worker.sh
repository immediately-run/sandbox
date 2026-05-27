#!/usr/bin/env bash
# Copies the built Babel worker into the parent app (tinkerable-site-main) so it
# is served same-origin with the page. The parent spawns this worker and bridges
# it to the sandboxed preview iframe over a MessagePort, letting the iframe drop
# `allow-same-origin`. Run after `npm run build:babel-worker`.
#
# Only `*.js` is copied: the entry (`babel-worker.js`, stable name) plus Parcel's
# hashed async chunks (lazily-loaded babel presets/plugins), which resolve
# relative to the worker URL under /babel-worker/. The `parcel-reporter-static-
# files-copy` reporter also drops unrelated assets into dist-worker/ — skip those.
set -euo pipefail

SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )
SRC="$SCRIPT_DIR/../dist-worker"
DEST="$SCRIPT_DIR/../../tinkerable-site-main/public/babel-worker"

if [ ! -f "$SRC/babel-worker.js" ]; then
  echo "error: $SRC/babel-worker.js not found — run 'npm run build:babel-worker' first" >&2
  exit 1
fi

rm -rf "$DEST"
mkdir -p "$DEST"
cp "$SRC"/*.js "$DEST"/
echo "Synced $(ls "$DEST"/*.js | wc -l | tr -d ' ') Babel worker file(s) to $DEST"
