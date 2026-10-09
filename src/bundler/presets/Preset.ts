import { Bundler } from '../bundler';
import { DepMap } from '../module-registry';
import { Module } from '../module/Module';
import { Transformer } from '../transforms/Transformer';

/**
 * The one home of the JS-family file classification: an extension that names
 * browser-ready JavaScript — `.js`/`.jsx`/`.ts`/`.tsx`/`.mjs`/`.cjs`/…, excluding
 * `.d.ts` (types, never runtime-imported). Two consumers must agree on it, and
 * a drifted copy of either re-opens the outage this classification closed
 * (2026-09-06..08): the presets route a JS-family module to the babel/raw-cjs
 * chains, and the module registry registers a package file's published bytes as
 * precompiled JavaScript only when it is JS-family — every other package file
 * (a stylesheet, a JSON document, an asset) is DATA whose published bytes must
 * ride the preset's own transformer chain, not be evaluated as the module's
 * compiled JavaScript.
 */
const JS_FAMILY_FILE = /\.(m|c)?(t|j)sx?$/;

export const isJsFamilyFile = (filepath: string): boolean =>
  JS_FAMILY_FILE.test(filepath) && !filepath.endsWith('.d.ts');

export class Preset {
  private transformers = new Map<string, Transformer>();
  private bundler: Bundler | null = null;

  defaultEntryPoints: string[] = ['index', 'src/index'];
  defaultHtmlBody: string = '';

  constructor(public name: string) {}

  async registerTransformer(transformer: Transformer): Promise<void> {
    if (!this.bundler) {
      throw new Error('Call Preset#init before registering transformers');
    }

    await transformer.init(this.bundler);
    this.transformers.set(transformer.id, transformer);
  }

  getTransformer(id: string): Transformer | undefined {
    return this.transformers.get(id);
  }

  async init(bundler: Bundler): Promise<void> {
    this.bundler = bundler;
  }

  mapTransformers(module: Module): Array<[string, any]> {
    throw new Error('Not implemented');
  }

  getTransformers(module: Module): Array<[Transformer, any]> {
    const transformersMap = this.mapTransformers(module);
    return transformersMap.map((val) => {
      const transformer = this.getTransformer(val[0]);
      if (!transformer) {
        throw new Error(`Transformer ${val[0]} not found`);
      }
      return [transformer, val[1]];
    });
  }

  augmentDependencies(dependencies: DepMap): DepMap {
    return dependencies;
  }
}
