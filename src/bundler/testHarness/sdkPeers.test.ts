import {
  createBundlerHarness,
  COMPILE_FIXTURE,
  SELF_HOSTED_SDK_PACKAGE_JSON,
  type BundlerHarness,
} from './bundlerHarness';

/**
 * R3-1318 at the `loadNodeModules` seam, driven the way `rootPeers.test.ts` drives it
 * (`parsedPackageJSON` set directly; `fetchManifest` spied, no network). The vendored
 * SDK manifest is written where `vendorModuleFrom` writes it, with the bytes production
 * writes there: the recorded self-host manifest for the default SDK 0.16.0, which has
 * no `peerDependencies`. The peers therefore come from `IMPLICIT_SDK_PEERS`; the drift
 * guard pinning that constant to the npm SDK's peers is in `selfHostPeers.test.ts`.
 *
 * Before the change, (a) sent no react and (c) never reached `fetchManifest`. Removing
 * the `IMPLICIT_SDK_PEERS` fallback fails (a) and (c).
 */
describe('R3-1318 — the implicit SDK brings its peers', () => {
  const SDK_MANIFEST_PATH = '/node_modules/@immediately-run/sdk/package.json';

  let h: BundlerHarness;

  beforeEach(async () => {
    h = await createBundlerHarness(COMPILE_FIXTURE);
    await h.bundler.fs.writeFile(SDK_MANIFEST_PATH, SELF_HOSTED_SDK_PACKAGE_JSON);
  });

  afterEach(async () => {
    await h.teardown();
  });

  /** Drive the real `loadNodeModules` with the app's package.json replaced by `pkg`;
   *  the dependency map sent to the CDN, or undefined when no query was made. */
  async function depsSentToCdn(pkg: unknown): Promise<Record<string, string> | undefined> {
    (h.bundler as unknown as { parsedPackageJSON: unknown }).parsedPackageJSON = pkg;
    await h.bundler.initPreset('create-react-app');
    const registry = (
      h.bundler as unknown as {
        moduleRegistry: { fetchManifest: (...a: unknown[]) => Promise<unknown> };
      }
    ).moduleRegistry;
    let sent: Record<string, string> | undefined;
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

  it('(a) the self-host manifest and a root declaring only jose (baton) send react and react-dom at ^19.0.0', async () => {
    const sent = await depsSentToCdn({ dependencies: { jose: '^6.2.12' } });
    expect(sent?.jose).toBe('^6.2.12');
    expect(sent?.react).toBe('^19.0.0');
    expect(sent?.['react-dom']).toBe('^19.0.0');
  });

  it('(b) a vendored manifest that declares peerDependencies wins over IMPLICIT_SDK_PEERS', async () => {
    const declaring = { ...JSON.parse(SELF_HOSTED_SDK_PACKAGE_JSON), peerDependencies: { react: '^20.0.0' } };
    await h.bundler.fs.writeFile(SDK_MANIFEST_PATH, JSON.stringify(declaring));
    const sent = await depsSentToCdn({ dependencies: { jose: '^6.2.12' } });
    expect(sent?.react).toBe('^20.0.0');
    expect(sent?.['react-dom']).toBeUndefined();
  });

  it("(c) a root declaring react keeps its own range over the SDK's", async () => {
    const sent = await depsSentToCdn({ dependencies: { react: '^18.3.0' } });
    expect(sent?.react).toBe('^18.3.0');
    expect(sent?.['react-dom']).toBe('^19.0.0');
  });

  it("(c) the root's range also wins over a manifest-declared peer", async () => {
    const declaring = { ...JSON.parse(SELF_HOSTED_SDK_PACKAGE_JSON), peerDependencies: { react: '^20.0.0' } };
    await h.bundler.fs.writeFile(SDK_MANIFEST_PATH, JSON.stringify(declaring));
    const sent = await depsSentToCdn({ peerDependencies: { react: '^18.3.0' } });
    expect(sent?.react).toBe('^18.3.0');
  });

  it('a manifest with no dependencies key still queries the CDN with the peers', async () => {
    const sent = await depsSentToCdn({});
    expect(sent).toBeDefined();
    expect(sent?.react).toBe('^19.0.0');
    expect(sent?.['react-dom']).toBe('^19.0.0');
  });

  it('an unparseable vendored manifest contributes nothing and warns', async () => {
    await h.bundler.fs.writeFile(SDK_MANIFEST_PATH, '{ not json');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const sent = await depsSentToCdn({ dependencies: { jose: '^6.2.12' } });
      expect(sent?.['react-dom']).toBeUndefined();
      expect(warn.mock.calls.some((c) => String(c[0]).includes(SDK_MANIFEST_PATH))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
