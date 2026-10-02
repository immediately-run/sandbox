import { Bundler } from '../../bundler';
import { ModuleNotFoundError } from '../../../errors/ModuleNotFound';
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
    // R3-899: an asset whose bytes cannot be read (absent from the tree while
    // its importer resolved — the fetch-fs split where the index says present
    // and the blob fetch 404s) fails the compile HERE as the ONE error shape,
    // naming the asset AND its importer, instead of surfacing later as an
    // unrelated TypeError on undefined exports. The importer comes from the
    // bundler's own initiators map (every addDependency records it) — the
    // transformer itself only ever sees the asset module.
    let contents: Uint8Array;
    try {
      contents = await this.bundler.fs.boundContext.fs.promises.readFile(filepath);
    } catch (cause) {
      // R3 (loud failure): ENOENT is absence — say so plainly, with the hint
      // aimed at the known author of this shape (an in-browser agent writing
      // the import without the file). Any OTHER code is reported as what it is,
      // never asserted as absence.
      const code = (cause as { code?: unknown }).code;
      const importer = this.bundler.initiators.get(filepath)?.values().next().value as string | undefined;
      // "Cannot find module" is a claim about ABSENCE — make it only for ENOENT.
      // Any other failure (a rate-limited or permission-denied blob read) keeps
      // its own mechanism in the thrown message too, so the stage never
      // announces a missing file for a fetch the tree index answered fine.
      if (code !== 'ENOENT') {
        console.warn(`[bundler] asset ${filepath} could not be read:`, cause);
        throw new Error(
          `Asset "${filepath}" (imported by ${importer ?? 'an unknown module'}) could not be read: ` +
            `${(cause as Error).message}`,
        );
      }
      console.warn(
        `[bundler] asset ${filepath} (imported by ${importer ?? 'an unknown module'}) is absent from the tree — ` +
          `check the import path; an in-browser agent may have written the import without creating the file.`,
      );
      throw new ModuleNotFoundError(filepath, importer ?? '(unknown importer)');
    }
    const bytes = contents instanceof Uint8Array ? contents : new Uint8Array(contents as ArrayBuffer);
    const dataUrl = `data:${mime};base64,${bytesToBase64(bytes)}`;

    return {
      code: `module.exports = ${JSON.stringify(dataUrl)};`,
      dependencies: new Set(),
    };
  }
}
