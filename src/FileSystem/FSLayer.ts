export class FSLayer {
  constructor(readonly name: string) {}

  shouldSkipLayer(path: string): boolean {
    return false;
  }

  resetCache(): void {
    return;
  }

  writeFile(path: string, content: string): Promise<void> {
    return Promise.resolve();
  }

  readFileAsync(path: string): Promise<string> {
    throw new Error(`readFileAsync is not implemented for fs#${this.name}`);
  }

  isFileAsync(path: string): Promise<boolean> {
    throw new Error(`isFileAsync is not implemented for fs#${this.name}`);
  }
}
