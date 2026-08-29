// The importable-asset MIME table (shared by the AssetTransformer and the module-space
// fetch shadow — src/bundler/module/moduleSpaceFetch.ts — so an asset is served with the
// same type whether it is imported or fetched by URL).
//
// `wasm` (R3-426): the MIME string must be exactly `application/wasm` —
// `WebAssembly.instantiateStreaming(fetch(url))` REJECTS any other Content-Type. A
// `data:application/wasm;base64,...` URL preserves it through `fetch`, so the asset
// transform's data-URL export works with both loader patterns
// (`fetch(url).then(r => r.arrayBuffer())` and `instantiateStreaming(fetch(url))`).
export const ASSET_MIME_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  wasm: 'application/wasm',
};

export const ASSET_EXTENSIONS = Object.keys(ASSET_MIME_TYPES);

/** The asset MIME type for a filepath, by extension — `undefined` when it is not a
 *  known importable asset. */
export function assetMimeType(filepath: string): string | undefined {
  const match = /\.([^.]+)$/.exec(filepath);
  return match ? ASSET_MIME_TYPES[match[1].toLowerCase()] : undefined;
}
