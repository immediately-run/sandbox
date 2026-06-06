import { concreteVersion, selfHostVersion, fetchVendoredModule } from './registryResolvedModules';

describe('concreteVersion', () => {
  it('passes through an exact version', () => {
    expect(concreteVersion('0.2.8')).toBe('0.2.8');
  });

  it('strips caret/tilde/range operators to the floor version', () => {
    expect(concreteVersion('^0.2.8')).toBe('0.2.8');
    expect(concreteVersion('~1.4.0')).toBe('1.4.0');
    expect(concreteVersion('>=2.0.0')).toBe('2.0.0');
    expect(concreteVersion('v3.1.2')).toBe('3.1.2');
  });

  it('keeps prerelease/build metadata', () => {
    expect(concreteVersion('0.3.0-rc.1')).toBe('0.3.0-rc.1');
  });

  it('returns undefined for non-pinned specifiers (caller uses the default)', () => {
    expect(concreteVersion('*')).toBeUndefined();
    expect(concreteVersion('latest')).toBeUndefined();
    expect(concreteVersion('1.2')).toBeUndefined();
    expect(concreteVersion('github:owner/repo')).toBeUndefined();
    expect(concreteVersion(undefined)).toBeUndefined();
  });
});

describe('selfHostVersion (implicit resolution)', () => {
  const DEFAULT = '0.2.8';
  const SDK = '@immediately-run/sdk';

  it("uses the app's concrete pinned version", () => {
    const raw = JSON.stringify({ dependencies: { [SDK]: '0.2.7', react: '^19.0.0' } });
    expect(selfHostVersion(raw, SDK, DEFAULT)).toBe('0.2.7');
  });

  it('reduces a range to its floor version', () => {
    expect(selfHostVersion(JSON.stringify({ dependencies: { [SDK]: '^0.3.1' } }), SDK, DEFAULT)).toBe('0.3.1');
  });

  it('falls back to the default for a non-concrete range', () => {
    expect(selfHostVersion(JSON.stringify({ dependencies: { [SDK]: 'latest' } }), SDK, DEFAULT)).toBe(DEFAULT);
  });

  it('falls back to the default when the SDK is not declared', () => {
    expect(selfHostVersion(JSON.stringify({ dependencies: { react: '^19.0.0' } }), SDK, DEFAULT)).toBe(DEFAULT);
  });

  it('falls back to the default on malformed package.json', () => {
    expect(selfHostVersion('{ not json', SDK, DEFAULT)).toBe(DEFAULT);
  });

  it('ignores the obsolete resolveFromRegistry opt-in (resolution is implicit)', () => {
    // Apps may still carry the field from the migration; it has no effect now.
    const raw = JSON.stringify({
      dependencies: { [SDK]: '0.2.9' },
      'immediately.run': { resolveFromRegistry: [] },
    });
    expect(selfHostVersion(raw, SDK, DEFAULT)).toBe('0.2.9');
  });
});

describe('fetchVendoredModule', () => {
  const makeFetch = (base: string) => {
    const tree: Record<string, string> = {
      [`${base}/manifest.json`]: JSON.stringify({
        files: ['index.js', 'components/Include.js', 'package.json'],
      }),
      [`${base}/index.js`]: 'export * from "./components/Include";',
      [`${base}/components/Include.js`]: 'export const Include = 1;',
      [`${base}/package.json`]: '{"name":"@immediately-run/sdk","main":"./index.js"}',
    };
    const calls: string[] = [];
    const fetchSource = async (url: string) => {
      calls.push(url);
      if (!(url in tree)) throw new Error(`unexpected fetch ${url}`);
      return tree[url];
    };
    return { fetchSource, calls };
  };

  it('fetches the manifest then each file from the given base URL', async () => {
    const base = 'https://immediately-run.github.io/immediately-run-sdk/v/0.2.8';
    const { fetchSource, calls } = makeFetch(base);
    await fetchVendoredModule('@immediately-run/sdk', base, fetchSource);
    expect(calls[0]).toBe(`${base}/manifest.json`);
    expect(calls).toContain(`${base}/index.js`);
    expect(calls).toContain(`${base}/components/Include.js`);
    expect(calls).toContain(`${base}/package.json`);
  });

  it('maps each file to its /node_modules path and flags .js as modules', async () => {
    const base = 'https://immediately-run.github.io/immediately-run-sdk/v/0.2.8';
    const { fetchSource } = makeFetch(base);
    const vendored = await fetchVendoredModule('@immediately-run/sdk', base, fetchSource);
    expect(vendored).toEqual([
      {
        path: '/node_modules/@immediately-run/sdk/index.js',
        content: 'export * from "./components/Include";',
        isModule: true,
      },
      {
        path: '/node_modules/@immediately-run/sdk/components/Include.js',
        content: 'export const Include = 1;',
        isModule: true,
      },
      {
        path: '/node_modules/@immediately-run/sdk/package.json',
        content: '{"name":"@immediately-run/sdk","main":"./index.js"}',
        isModule: false,
      },
    ]);
  });
});
