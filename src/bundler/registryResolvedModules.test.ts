import {
  concreteVersion,
  compareSemver,
  resolveSelfHostVersion,
  fetchVendoredModule,
  SelfHostResolutionError,
} from './registryResolvedModules';

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

describe('compareSemver', () => {
  it('orders numeric triples', () => {
    expect(compareSemver('0.2.7', '0.2.8')).toBe(-1);
    expect(compareSemver('0.2.8', '0.2.8')).toBe(0);
    expect(compareSemver('0.10.0', '0.9.9')).toBe(1);
    expect(compareSemver('1.0.0', '0.99.99')).toBe(1);
  });

  it('orders a prerelease below its release', () => {
    expect(compareSemver('0.2.8-beta.1', '0.2.8')).toBe(-1);
    expect(compareSemver('0.3.0-rc.1', '0.2.8')).toBe(1);
  });
});

describe('resolveSelfHostVersion (implicit resolution, fail-closed §5.1)', () => {
  const DEFAULT = '0.4.0';
  const FLOOR = '0.2.8';
  const SDK = '@immediately-run/sdk';
  const resolve = (raw: string) => resolveSelfHostVersion(raw, SDK, DEFAULT, FLOOR);

  it("uses the app's concrete pinned version when at/above the floor", () => {
    const raw = JSON.stringify({ dependencies: { [SDK]: '0.2.9', react: '^19.0.0' } });
    expect(resolve(raw)).toBe('0.2.9');
  });

  it('accepts a pin exactly at the floor', () => {
    expect(resolve(JSON.stringify({ dependencies: { [SDK]: '0.2.8' } }))).toBe('0.2.8');
  });

  it('reduces a range to its floor version', () => {
    expect(resolve(JSON.stringify({ dependencies: { [SDK]: '^0.3.1' } }))).toBe('0.3.1');
  });

  it('FAILS CLOSED on a pin below the floor (§5.1(b) — never boots the known crash)', () => {
    const raw = JSON.stringify({ dependencies: { [SDK]: '0.2.7' } });
    expect(() => resolve(raw)).toThrow(SelfHostResolutionError);
    expect(() => resolve(raw)).toThrow(/below the supported floor 0\.2\.8/);
  });

  it('FAILS CLOSED on a prerelease of the floor version', () => {
    expect(() => resolve(JSON.stringify({ dependencies: { [SDK]: '0.2.8-beta.1' } }))).toThrow(
      SelfHostResolutionError,
    );
  });

  it('FAILS CLOSED on a declared non-concrete specifier (§5.1(c) — no silent aliasing)', () => {
    for (const spec of ['latest', '*', '1.2', 'github:owner/repo']) {
      const raw = JSON.stringify({ dependencies: { [SDK]: spec } });
      expect(() => resolve(raw)).toThrow(SelfHostResolutionError);
      expect(() => resolve(raw)).toThrow(/not a concrete version/);
    }
  });

  it('uses the default ONLY when the SDK is not declared at all', () => {
    expect(resolve(JSON.stringify({ dependencies: { react: '^19.0.0' } }))).toBe(DEFAULT);
    expect(resolve(JSON.stringify({}))).toBe(DEFAULT);
  });

  it('uses the default on malformed package.json (boot fails later if truly broken)', () => {
    expect(resolve('{ not json')).toBe(DEFAULT);
  });

  it('ignores the obsolete resolveFromRegistry opt-in (resolution is implicit)', () => {
    // Apps may still carry the field from the migration; it has no effect now.
    const raw = JSON.stringify({
      dependencies: { [SDK]: '0.2.9' },
      'immediately.run': { resolveFromRegistry: [] },
    });
    expect(resolve(raw)).toBe('0.2.9');
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

  it('FAILS CLOSED with a clear boot error when the version is unavailable (§5.1(a))', async () => {
    const failingFetch = async (url: string): Promise<string> => {
      throw new Error(`404 for ${url}`);
    };
    const base = 'https://immediately-run.github.io/immediately-run-sdk/v/9.9.9';
    await expect(fetchVendoredModule('@immediately-run/sdk', base, failingFetch)).rejects.toThrow(
      SelfHostResolutionError,
    );
    await expect(fetchVendoredModule('@immediately-run/sdk', base, failingFetch)).rejects.toThrow(
      /unavailable/,
    );
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
