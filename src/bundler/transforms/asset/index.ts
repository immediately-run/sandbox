import { Bundler } from '../../bundler';
import { ITranspilationContext, ITranspilationResult, Transformer } from '../Transformer';
import { assetMimeType } from './mime';

export { ASSET_EXTENSIONS } from './mime';

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  // Chunk the conversion to avoid blowing the call stack on large assets.
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)));
  }
  return btoa(binary);
};

/**
 * Turns imported binary assets (images, WebAssembly) into JS modules that export
 * a base64 data URL, e.g. `import logo from './logo.png'` — or, R3-426,
 * `import wasm from './add.wasm'` — yields the URL string. The data URL's MIME is
 * the asset's real type, which `fetch(dataUrl)` preserves — for `.wasm` that makes
 * both `r.arrayBuffer()` + `WebAssembly.instantiate` and
 * `WebAssembly.instantiateStreaming(fetch(url))` (which requires `application/wasm`)
 * work from the exported URL.
 *
 * The module source handed to transformers is read as UTF-8, which mangles
 * binary data, so we re-read the raw bytes straight from the zenfs layer.
 */
export class AssetTransformer extends Transformer {
  private bundler: Bundler | null = null;

  constructor() {
    super('asset-transformer');
  }

  async init(bundler: Bundler): Promise<void> {
    this.bundler = bundler;
  }

  async transform(ctx: ITranspilationContext, config: any): Promise<ITranspilationResult> {
    const filepath = ctx.module.filepath;
    const mime = assetMimeType(filepath);
    if (!mime) {
      throw new Error(`Unsupported asset type for ${filepath}`);
    }

    // The bundler fs is a single CachedFS over the ZenFS bound context (R3-48 G0-4);
    // re-read the raw bytes straight from the bound context (the gensync `readFile`
    // surface is UTF-8/string-only and would mangle binary data).
    if (!this.bundler) {
      throw new Error(`Cannot read asset ${filepath}: bundler unavailable`);
    }
    const contents = await this.bundler.fs.boundContext.fs.promises.readFile(filepath);
    const bytes = contents instanceof Uint8Array ? contents : new Uint8Array(contents as ArrayBuffer);
    const dataUrl = `data:${mime};base64,${bytesToBase64(bytes)}`;

    return {
      code: `module.exports = ${JSON.stringify(dataUrl)};`,
      dependencies: new Set(),
    };
  }
}
