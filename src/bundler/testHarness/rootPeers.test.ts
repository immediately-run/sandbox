import { createBundlerHarness, COMPILE_FIXTURE, type BundlerHarness } from './bundlerHarness';

/**
 * R3-289 adversarial exit criteria, at the `loadNodeModules` seam — the exact
 * DepMap the bundler hands the module registry (the /dep_tree/ query input),
 * driven the same way `bundlerHarness.gitLibraryDeps.test.ts` drives it
 * (`parsedPackageJSON` set directly; `fetchManifest` spied, no network).
 *
 * The pre-change behaviour (reading `dependencies` alone) fails the first two
 * cases: a peer-only react never entered the query.
 */
describe('R3-289 — the root package’s peers are runtime needs', () => {
  let h: BundlerHarness;

  beforeEach(async () => {
    h = await createBundlerHarness(COMPILE_FIXTURE);
  });

  afterEach(async () => {
    await h.teardown();
  });

  /** Drive the real `loadNodeModules` and return the dependency map it sent to
   *  the CDN, with the app's package.json replaced by `pkg`. */
  async function depsSentToCdn(pkg: unknown): Promise<Record<string, string>> {
    (h.bundler as unknown as { parsedPackageJSON: unknown }).parsedPackageJSON = pkg;
    await h.bundler.initPreset('create-react-app'); // the preset augments the closure
    const registry = (
      h.bundler as unknown as {
        moduleRegistry: { fetchManifest: (...a: unknown[]) => Promise<unknown> };
      }
    ).moduleRegistry;
    let sent: Record<string, string> = {};
    const spy = jest.spyOn(registry, 'fetchManifest').mockImplementation(async (deps: unknown) => {
      sent = { ...(deps as Record<string, string>) };
    });
    try {
      await (h.bundler as unknown as { loadNodeModules: () => Promise<void> }).loadNodeModules();
    } finally {
      spy.mockRestore();
    }
    return sent;
  }

  it('an app whose ONLY declaration of react is a peer resolves it', async () => {
    const sent = await depsSentToCdn({
      name: 'peer-only-react',
      main: 'src/index.ts',
      peerDependencies: { react: '^19.0.0' },
    });
    // react is in the query input (the preset's react-error-boundary imports it).
    expect(sent.react).toBe('^19.0.0');
  });

  it('dependencies wins when both declare the same name at different ranges', async () => {
    const sent = await depsSentToCdn({
      name: 'dep-wins',
      main: 'src/index.ts',
      dependencies: { react: '^18.2.0' },
      peerDependencies: { react: '^19.0.0' },
    });
    expect(sent.react).toBe('^18.2.0');
  });

  it('a peer marked optional in peerDependenciesMeta is NOT fetched', async () => {
    const sent = await depsSentToCdn({
      name: 'optional-peer',
      main: 'src/index.ts',
      peerDependencies: { '@types/react': '^19.0.0', react: '^19.0.0' },
      peerDependenciesMeta: { '@types/react': { optional: true } },
    });
    expect(sent['@types/react']).toBeUndefined();
    expect(sent.react).toBe('^19.0.0');
  });

  it('a package with neither dependencies nor peers queries nothing', async () => {
    const sent = await depsSentToCdn({ name: 'empty', main: 'src/index.ts' });
    // Only the preset's own augmentations (react-refresh/core-js/react-error-boundary).
    expect(Object.keys(sent).filter((k) => !['react-refresh', 'core-js', 'react-error-boundary'].includes(k))).toEqual(
      [],
    );
  });
});
