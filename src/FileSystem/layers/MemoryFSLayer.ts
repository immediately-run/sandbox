import { FSLayer } from '../FSLayer';

export class MemoryFSLayer extends FSLayer {
  files: Map<string, string> = new Map();

  constructor() {
    super('memory-fs');
  }

  writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
    return Promise.resolve();
  }

  readFileAsync(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content == null) {
      return Promise.reject(new Error(`File ${path} not found`));
    }
    return Promise.resolve(content);
  }

  isFileAsync(path: string): Promise<boolean> {
    return Promise.resolve(this.files.has(path));
  }
}
