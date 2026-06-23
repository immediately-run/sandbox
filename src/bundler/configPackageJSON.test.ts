import { createBundlerHarness, type BundlerHarness } from './testHarness/bundlerHarness';

// BOOT_SCAFFOLDING_SPEC §3.3 — the host-resolved package.json delivered out-of-band
// via IInitConfig is the authoritative manifest source; the bundler reads
// `/app/package.json` from the filesystem only as a standalone/older-host fallback.
describe('Bundler out-of-band package.json (BOOT_SCAFFOLDING §3)', () => {
  let h: BundlerHarness;

  // The seeded fixture's package.json has main 'src/index.ts' (COMPILE_FIXTURE).
  afterEach(() => h.teardown());

  it('prefers the config-supplied package.json and does not read it from the fs', async () => {
    h = await createBundlerHarness();
    h.bundler.setConfigPackageJSON({
      main: '/from-config.tsx',
      dependencies: { react: '^19.0.0' },
    });
    const readSpy = jest.spyOn(h.bundler.fs, 'readFileAsync');

    await h.bundler.processPackageJSON();

    expect(h.bundler.parsedPackageJSON?.main).toBe('/from-config.tsx');
    expect(h.bundler.parsedPackageJSON?.dependencies).toEqual({ react: '^19.0.0' });
    // No read of the app package.json when config supplies it.
    const readPaths = readSpy.mock.calls.map((c) => String(c[0]));
    expect(readPaths.some((p) => p.endsWith('/package.json'))).toBe(false);
  });

  it('falls back to the filesystem package.json when no config is supplied', async () => {
    h = await createBundlerHarness();
    h.bundler.setConfigPackageJSON(undefined);

    await h.bundler.processPackageJSON();

    // The seeded COMPILE_FIXTURE package.json.
    expect(h.bundler.parsedPackageJSON?.main).toBe('src/index.ts');
  });

  it('config wins over a different on-disk package.json (adversarial)', async () => {
    h = await createBundlerHarness();
    // The fixture on disk says main 'src/index.ts'; config says otherwise.
    h.bundler.setConfigPackageJSON({ main: '/index.tsx', dependencies: {} });

    await h.bundler.processPackageJSON();

    expect(h.bundler.parsedPackageJSON?.main).toBe('/index.tsx');
  });
});
