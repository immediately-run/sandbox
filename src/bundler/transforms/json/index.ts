import { ITranspilationContext, ITranspilationResult, Transformer } from '../Transformer';

/**
 * `import data from './thing.json'` — a plain, universally-expected import that the
 * platform could not do at all until R3-280's Drill 3 tried to.
 *
 * Every other bundler in the ecosystem supports it, so nothing declares it and nothing
 * warns: an app (or a library) simply dies at boot with `No transformer for …/x.json`.
 * It stayed invisible because the one first-party JSON import in the estate — Grove's
 * `viewer.manifest.json`, which backs the manifest-override contract — is reachable only
 * from the LIBRARY entry, so the fork and dispatch modes never touched it. The moment a
 * shell composed Grove as a library, the mode that is supposed to be equivalent to the
 * other two stopped booting.
 *
 * JSON is data, not code: it is parsed here at transform time and re-emitted as a frozen
 * literal, so the module evaluates with no `JSON.parse` at runtime and no dependencies to
 * scan. A malformed file fails HERE, naming the file, rather than as an opaque syntax error
 * inside the CommonJS wrapper.
 */
export class JSONTransformer extends Transformer {
  constructor() {
    super('json-transformer');
  }

  async transform(ctx: ITranspilationContext): Promise<ITranspilationResult> {
    let parsed: unknown;
    try {
      // `JSON.parse` rejects a leading BOM outright, and a BOM is exactly what a file
      // authored on Windows (or exported by a lot of tooling) carries — so without this the
      // import fails with `Unexpected token '\uFEFF'`, which reads like a corrupt file
      // rather than an encoding detail. Strip it; everything else is left to the parser.
      parsed = JSON.parse(ctx.code.replace(/^\uFEFF/, ''));
    } catch (err) {
      throw new Error(`Invalid JSON in ${ctx.module.filepath}: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Re-serialize the PARSED value rather than pasting the source: it normalizes away a
    // BOM/trailing whitespace, and guarantees the emitted text is a JS expression (a raw
    // file could otherwise carry something that parses as JSON but not as JS).
    return {
      code: `module.exports = ${JSON.stringify(parsed)};`,
      dependencies: new Set(),
    };
  }
}
