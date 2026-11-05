import { transformFile, TRANSPILER_VERSION } from '@immediately-run/transpiler';

import { createBundlerHarness, mountInMemoryFs, type BundlerHarness } from '../testHarness/bundlerHarness';
import { EMBEDDED_TOOLCHAIN_HASH } from './embeddedToolchainHash';

// R3-1343 — spot-verification (PRETRANSPILED_ARTIFACTS_SPEC §5.7) of a git-mounted
// library's OWN artifacts (LIBRARY_MOUNTS_SPEC §3 step 4).
//
// The CLI emits every artifact at `/app/<rel>` (immediately-run-cli `emitArtifacts`), and
// the react preset picks its variant by path: an app-root `.tsx` gets react-refresh, a
// `/node_modules/**` one does not. A library is mounted at `/node_modules/<name>/…`, so a
// verifier that re-transpiles at the MOUNTED path computes a different function of the
// same source and flags every genuine library `.tsx` as tampered — on prod, grove's
// GroveNav.tsx raised `artifact-integrity:distrust` on every baton-board boot. The `.ts`
// fixture in artifactLibraryRoot.test.ts could not see it: `.ts` is plain in both variants.

const LIB_PATH = '/node_modules/@scope/lib/src/Greet.tsx';
const SOURCE = `import React from 'react';\nexport const Greet = () => <span>hi</span>;\nexport default Greet;\n`;
const EMPTY_DIRTY = { dirtySet: new Set<string>(), writableLayer: new Set<string>() };

const APP_FIXTURE: Record<string, string> = {
  'package.json': JSON.stringify({
    name: 'lib-spot-verify-consumer',
    main: 'src/index.ts',
    dependencies: { '@scope/lib': 'github:owner/repo#abc123' },
  }),
  'index.html': '<!doctype html><div id="root"></div>',
  'src/index.ts': "import { Greet } from '@scope/lib';\nexport default Greet;\n",
};

/** The artifact exactly as the publisher produces it: the CLI's call, at `/app/<rel>`. */
const publisherArtifact = async (): Promise<string> => {
  const r = await transformFile({ path: '/app/src/Greet.tsx', code: SOURCE });
  if ('error' in r) throw new Error('fixture: Greet.tsx failed to transform');
  return r.code;
};

const libraryRepo = (artifact: string): Record<string, string> => ({
  'package.json': '{"name":"@scope/lib","version":"1.0.0","main":"src/Greet.tsx"}',
  'src/Greet.tsx': SOURCE,
  '.immediately.run/contribute-manifest.json': JSON.stringify({
    schemaVersion: 1,
    commitSha: 'lib-commit-sha',
    entries: [{ path: 'src/Greet.tsx', sha: 'sha-greet', type: 'blob' }],
  }),
  '.immediately.run/artifacts/index.json': JSON.stringify({
    schemaVersion: 1,
    toolchain: {
      transpiler: '@immediately-run/transpiler',
      version: TRANSPILER_VERSION,
      toolchainHash: EMBEDDED_TOOLCHAIN_HASH,
      preset: 'react',
    },
    files: { '/src/Greet.tsx': { srcSha: 'sha-greet', out: 'transpiled/src/Greet.tsx.js', deps: [] } },
  }),
  '.immediately.run/artifacts/transpiled/src/Greet.tsx.js': artifact,
});

describe('R3-1343 spot-verify of a library-root artifact', () => {
  let h: BundlerHarness;
  let unmount: (() => void) | null = null;

  beforeEach(async () => {
    h = await createBundlerHarness(APP_FIXTURE, { forCompile: true });
  });
  afterEach(async () => {
    unmount?.();
    unmount = null;
    await h.teardown();
  });

  const seedAndConsume = async (artifact: string) => {
    unmount = await mountInMemoryFs('/mnt/testlib', libraryRepo(artifact));
    await h.bundler.registerGitLibraryMount('@scope/lib', '/mnt/testlib');
    expect((await h.bundler.seedArtifacts(EMPTY_DIRTY)).seeded).toBe(1);
    expect(await h.bundler.artifactStore.consult(LIB_PATH)).not.toBeNull();
    expect(h.bundler.artifactStore.consumedCount()).toBe(1);
  };

  it('the fixture is the shape that diverges: the mounted path transpiles to other bytes', async () => {
    // Guards against a vacuous pass: if the preset ever stops branching on the path, the
    // pass case below no longer distinguishes the fix and this says so.
    const mounted = await transformFile({ path: LIB_PATH, code: SOURCE });
    if ('error' in mounted) throw new Error('fixture: mounted transform failed');
    expect(mounted.code).not.toBe(await publisherArtifact());
  });

  it("passes a genuine library .tsx artifact (= the publisher's transpile at /app/<rel>)", async () => {
    await seedAndConsume(await publisherArtifact());
    const verdict = await h.bundler.artifactStore.spotVerify();
    expect(verdict).toEqual({ tampered: false, sampled: 1 });
    expect(await h.bundler.artifactStore.consult(LIB_PATH)).not.toBeNull();
  });

  it('still detects a tampered library artifact and discards the section', async () => {
    await seedAndConsume(`${await publisherArtifact()}\n/* TAMPERED */\n`);
    const verdict = await h.bundler.artifactStore.spotVerify();
    expect(verdict).toMatchObject({ tampered: true, path: LIB_PATH, reason: 'transpile-mismatch' });
    expect(await h.bundler.artifactStore.consult(LIB_PATH)).toBeNull();
  });
});
