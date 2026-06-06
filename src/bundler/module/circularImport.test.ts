import {
  prettyModuleName,
  formatCircularImport,
  CircularImportError,
  detectCycle,
} from './circularImport';

describe('prettyModuleName', () => {
  it('strips the virtual /node_modules/ prefix', () => {
    expect(prettyModuleName('/node_modules/@immediately-run/sdk/runtime.js')).toBe(
      '@immediately-run/sdk/runtime.js',
    );
  });
  it('leaves app paths untouched', () => {
    expect(prettyModuleName('/app/src/index.tsx')).toBe('/app/src/index.tsx');
  });
});

describe('detectCycle', () => {
  it('returns null when the module is not on the stack', () => {
    expect(detectCycle(['/a.js', '/b.js'], '/c.js')).toBeNull();
  });

  it('returns the loop slice from the first occurrence', () => {
    // Evaluating A → B, then B require()s A again: the loop is [A, B].
    expect(detectCycle(['/a.js', '/b.js'], '/a.js')).toEqual(['/a.js', '/b.js']);
  });

  it('excludes the non-cyclic caller prefix', () => {
    // X called A called B; B require()s A → loop is [A, B], not [X, A, B].
    expect(detectCycle(['/x.js', '/a.js', '/b.js'], '/a.js')).toEqual(['/a.js', '/b.js']);
  });

  it('detects a self-cycle', () => {
    expect(detectCycle(['/a.js'], '/a.js')).toEqual(['/a.js']);
  });
});

describe('formatCircularImport', () => {
  it('names every module in the loop and closes back to the start', () => {
    const msg = formatCircularImport([
      '/node_modules/@immediately-run/sdk/sandboxUtils.js',
      '/node_modules/@immediately-run/sdk/runtime.js',
    ]);
    expect(msg).toContain('@immediately-run/sdk/sandboxUtils.js');
    expect(msg).toContain('→ @immediately-run/sdk/runtime.js');
    expect(msg).toContain('(cycle closes here)');
    // The closing edge points back to the entry module.
    expect(msg).toContain('→ @immediately-run/sdk/sandboxUtils.js  (cycle closes here)');
    expect(msg).toContain('Circular import detected');
    // No raw /node_modules/ noise in the rendered names.
    expect(msg).not.toContain('/node_modules/');
  });
});

describe('CircularImportError', () => {
  it('is an Error carrying the cycle and a formatted message', () => {
    const err = new CircularImportError(['/a.js', '/b.js']);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('CircularImportError');
    expect(err.cycle).toEqual(['/a.js', '/b.js']);
    expect(err.message).toContain('Circular import detected');
  });
});
