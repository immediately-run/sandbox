import {
  createBundlerHarness,
  COMPILE_FIXTURE,
  INSTALLED_SDK_PACKAGE_JSON,
  type BundlerHarness,
} from './bundlerHarness';

/**
 * R3-1318 at the `loadNodeModules` seam, driven the way `rootPeers.test.ts` drives it
 * (`parsedPackageJSON` set directly; `fetchManifest` spied, no network). The vendored
 * SDK manifest is written where `vendorModuleFrom` writes it, with the bytes of the SDK
 * this repo installs.
 *
 * Before the change, (a) sent no react and (c) never reached `fetchManifest`.
 */
describe('R3-1318 — the implicit SDK brings its peers', () => {
  const SDK_MANIFEST_PATH = '/node_modules/@immediately-run/sdk/package.json';
  const sdkPeers = (JSON.parse(INSTALLED_SDK_PACKAGE_JSON) as { peerDependencies: Record<string, string> })
    .peerDependencies;

  let h: BundlerHarness;

  beforeEach(async () => {
    h = await createBundlerHarness(COMPILE_FIXTURE);
    await h.bundler.fs.writeFile(SDK_MANIFEST_PATH, INSTALLED_SDK_PACKAGE_JSON);
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

  it('(a) a manifest declaring only jose (baton) sends react and react-dom at the SDK ranges', async () => {
    const sent = await depsSentToCdn({ dependencies: { jose: '^6.2.12' } });
    expect(sent?.jose).toBe('^6.2.12');
    expect(sent?.react).toBe(sdkPeers.react);
    expect(sent?.['react-dom']).toBe(sdkPeers['react-dom']);
  });

  it('(b) a root declaring react keeps its own range', async () => {
    const sent = await depsSentToCdn({ dependencies: { react: '^18.3.0' } });
    expect(sent?.react).toBe('^18.3.0');
    expect(sent?.['react-dom']).toBe(sdkPeers['react-dom']);
  });

  it('(b) a root peer declaration of react-dom also wins over the SDK range', async () => {
    const sent = await depsSentToCdn({ peerDependencies: { 'react-dom': '^18.3.0' } });
    expect(sent?.['react-dom']).toBe('^18.3.0');
  });

  it('(c) a manifest with no dependencies key still queries the CDN with the peers', async () => {
    const sent = await depsSentToCdn({});
    expect(sent).toBeDefined();
    expect(sent?.react).toBe(sdkPeers.react);
    expect(sent?.['react-dom']).toBe(sdkPeers['react-dom']);
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
