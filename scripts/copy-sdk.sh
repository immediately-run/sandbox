#!/usr/bin/env bash
set -euo pipefail

# Vendors the published @immediately-run/sdk build into static/ so it can be injected
# into the sandbox iframe at runtime (the iframe cannot reach npmjs). The SDK is
# installed as a devDependency; here we copy its prebuilt dist/ into
# static/immediately-run-sdk/, which parcel then copies into the served dist/ root.
SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )
ROOT="$SCRIPT_DIR/.."
SRC="$ROOT/node_modules/@immediately-run/sdk/dist"
DEST="$ROOT/static/immediately-run-sdk"

if [ ! -d "$SRC" ]; then
  echo "error: $SRC not found — run 'npm install' to install @immediately-run/sdk first." >&2
  exit 1
fi

rm -rf "$DEST"
mkdir -p "$DEST"

# Copy the ESM build (.js), sourcemaps and type declarations, preserving the
# directory layout. The sandbox runtime imports the ESM files; the .cjs variants
# are not needed inside the iframe.
( cd "$SRC" && find . \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' \) -print0 \
  | while IFS= read -r -d '' f; do
      mkdir -p "$DEST/$(dirname "$f")"
      cp "$f" "$DEST/$f"
    done )

# Minimal package.json so the in-sandbox resolver can resolve the bare
# "@immediately-run/sdk" specifier to the flattened ESM entrypoint.
cat > "$DEST/package.json" <<'JSON'
{
  "name": "@immediately-run/sdk",
  "main": "./index.js",
  "module": "./index.js",
  "types": "./index.d.ts"
}
JSON

# Manifest of the vendored files, fetched by the bundler at boot (addLocalModules
# in src/bundler/bundler.ts). Generated in the same step that copies the files so
# the list can never drift from the directory contents.
( cd "$DEST" && node -e '
  const fs = require("fs"), path = require("path");
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (p.endsWith(".js")) files.push(p);
    }
  })(".");
  files.push("package.json");
  fs.writeFileSync("manifest.json", JSON.stringify({ files: files.sort() }, null, 2) + "\n");
' )

echo "Copied @immediately-run/sdk -> static/immediately-run-sdk/"
