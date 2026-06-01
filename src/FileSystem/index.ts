import gensync, { Gensync } from 'gensync';

import { FSLayer } from './FSLayer';

export class FileSystem {
  // path => content
  readFile: Gensync<(filepath: string) => string>;
  isFile: Gensync<(filepath: string) => boolean>;
  layers: FSLayer[];

  constructor(layers: FSLayer[]) {
    this.layers = layers;
    this.readFile = gensync({
      // File reads are async-only; gensync still requires a sync handler, but it
      // is never invoked because the resolver always runs via `resolveAsync`.
      sync: (path: string): string => {
        throw new Error(`Synchronous file reads are not supported (path: ${path})`);
      },
      async: this.readFileAsync.bind(this),
    });
    this.isFile = gensync({
      // Existence checks are async-only; gensync still requires a sync handler, but
      // it is never invoked because the resolver always runs via `resolveAsync`.
      sync: (path: string): boolean => {
        throw new Error(`Synchronous file existence checks are not supported (path: ${path})`);
      },
      async: this.isFileAsync.bind(this),
    });
  }

  resetCache(): void {
    for (const layer of this.layers) {
      layer.resetCache();
    }
  }

  async writeFile(path: string, content: string): Promise<void> {
    for (let layer of this.layers) {
      if (layer.shouldSkipLayer(path)) continue;

      await layer.writeFile(path, content);
    }
  }

  async readFileAsync(path: string): Promise<string> {
    let lastError = null;
    for (let layer of this.layers) {
      if (layer.shouldSkipLayer(path)) continue;

      try {
        const result = await layer.readFileAsync(path);
        return result;
      } catch (err) {
        // console.log(`Error reading file ${path} from layer ${layer.name}:`, err);
        lastError = err;
      }
    }

    if (!lastError) {
      lastError = new Error(`File ${path} not found`);
    }

    throw lastError;
  }

  async isFileAsync(path: string): Promise<boolean> {
    for (let layer of this.layers) {
      if (layer.shouldSkipLayer(path)) continue;

      try {
        const exists = await layer.isFileAsync(path);
        if (exists) {
          return true;
        }
      } catch (err) {
        // console.error(err);
      }
    }
    return false;
  }
}
