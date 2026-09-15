import { TRANSPILER_VERSION } from '@immediately-run/transpiler';

import { createBundlerHarness, mountInMemoryFs, type BundlerHarness } from '../testHarness/bundlerHarness';
import { EMBEDDED_TOOLCHAIN_HASH } from './embeddedToolchainHash';

// LIBRARY_MOUNTS_SPEC §7/L4 + PRETRANSPILED_ARTIFACTS_SPEC §5.1 — a git-mounted library's
// OWN cache-zip artifacts are consumed, not ignored.
//
// The gap this closes: the store was anchored at `/app` (every path went through
// `underAppRoot`), so a library repo's `.immediately.run/artifacts/` rode along in its
// cache zip and was never read — a consumer re-transpiled the whole library on every cold
// boot while holding the compiled bytes. The byte-delivery half (L4, merged) was already
// there; only consumption was missing.
//
// The security property under test is that the binding check TRANSFERS: an artifact is
// seeded only when the LIBRARY's own manifest sidecar attests its source blob's sha. A
// library with no sidecar (REST-fetched rather than zip-delivered) seeds nothing.

const LIB_ARTIFACT = '/* pre-transpiled lib */ exports.greet = () => "hi";\n';
const EMPTY_DIRTY = { dirtySet: new Set<string>(), writableLayer: new Set<string>() };

const APP_FIXTURE: Record<string, string> = {
  'package.json': JSON.stringify({
    name: 'lib-artifact-consumer',
    main: 'src/index.ts',
    dependencies: { '@scope/lib': 'github:owner/repo#abc123' },
  }),
  'index.html': '<!doctype html><div id="root"></div>',
  'src/index.ts': "import { greet } from '@scope/lib';\nexport default greet;\n",
};

/** A library repo as its cache zip delivers it: source, manifest sidecar, artifact index,
 *  and the pre-transpiled output. `over` bends one input at a time. */
const libraryRepo = (
  over: { toolchainHash?: string; srcSha?: string; sidecar?: boolean } = {},
): Record<string, string> => ({
  'package.json': '{"name":"@scope/lib","version":"1.0.0","main":"src/greet.ts"}',
  'src/greet.ts': 'export const greet = () => "hi";\n',
  ...(over.sidecar === false
    ? {}
    : {
        '.immediately.run/contribute-manifest.json': JSON.stringify({
          schemaVersion: 1,
          commitSha: 'lib-commit-sha',
          entries: [{ path: 'src/greet.ts', sha: 'sha-greet', type: 'blob' }],
        }),
      }),
  '.immediately.run/artifacts/index.json': JSON.stringify({
    schemaVersion: 1,
    toolchain: {
      transpiler: '@immediately-run/transpiler',
      version: TRANSPILER_VERSION,
      toolchainHash: over.toolchainHash ?? EMBEDDED_TOOLCHAIN_HASH,
      preset: 'react',
    },
    files: {
      '/src/greet.ts': {
        srcSha: over.srcSha ?? 'sha-greet',
        out: 'transpiled/src/greet.ts.js',
        deps: [],
      },
    },
  }),
  '.immediately.run/artifacts/transpiled/src/greet.ts.js': LIB_ARTIFACT,
});

describe("a git-mounted library's own artifacts are seeded and consumed", () => {
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

  const register = async (files: Record<string, string>) => {
    unmount = await mountInMemoryFs('/mnt/testlib', files);
    await h.bundler.registerGitLibraryMount('@scope/lib', '/mnt/testlib');
  };

  it('seeds the library artifact and serves it with ZERO babel transforms', async () => {
    await register(libraryRepo());
    expect((await h.bundler.seedArtifacts(EMPTY_DIRTY)).seeded).toBe(1);

    h.babel.resetTransformRequests();
    const mod = await h.bundler.transformModule('/node_modules/@scope/lib/src/greet.ts');
    expect(mod.compiled).toBe(LIB_ARTIFACT);
    expect(h.babel.transformRequests).not.toContain('/node_modules/@scope/lib/src/greet.ts');
  });

  it('seeds NOTHING when the library ships no manifest sidecar (REST-fetched, not zipped)', async () => {
    // The binding check is what transfers from the app root: an artifact is honoured only
    // when the library's OWN manifest attests its source blob. No sidecar → an empty
    // manifest map → every entry `not-in-manifest` → live transpile. This is the reason
    // library seeding needs no bespoke security gate.
    await register(libraryRepo({ sidecar: false }));
    expect((await h.bundler.seedArtifacts(EMPTY_DIRTY)).seeded).toBe(0);
  });

  it('refuses an artifact whose srcSha does not match the manifest — a swapped source', async () => {
    await register(libraryRepo({ srcSha: 'sha-something-else' }));
    expect((await h.bundler.seedArtifacts(EMPTY_DIRTY)).seeded).toBe(0);
  });

  it('skips a library built with a different toolchain WITHOUT costing the app its own', async () => {
    // §4.4 is per-root: a stale library must degrade to live transpile for itself alone.
    await register(libraryRepo({ toolchainHash: 'not-our-toolchain' }));
    expect((await h.bundler.seedArtifacts(EMPTY_DIRTY)).seeded).toBe(0);
    // Nothing to consult → the module stays on the live-transpile path, and the app's own
    // section is untouched (it has no artifacts in this fixture, but the stamp gate ran
    // per-root rather than rejecting globally).
    expect(await h.bundler.artifactStore.consult('/node_modules/@scope/lib/src/greet.ts')).toBeNull();
  });

  it("does not let a library's commitSha overwrite the app's distrust key", async () => {
    // §5.7 marks are keyed by (repo coords, commitSha) and the parent attributes them to
    // the mount it OWNS — the app repo. A library's sidecar commit must never land there,
    // or a distrust mark would be filed against the wrong repo.
    await register(libraryRepo());
    await h.bundler.seedArtifacts(EMPTY_DIRTY);
    expect(h.bundler.artifactStore.getCommitSha()).not.toBe('lib-commit-sha');
  });

  it('keys /transpiled by full path, so an app file cannot shadow a library module', async () => {
    // Both `/app/node_modules/@scope/lib/src/greet.ts` and the mounted library's
    // `src/greet.ts` strip to the same repo-relative key. Full-path keying is what makes
    // them distinct entries rather than one serving the other's bytes.
    await register(libraryRepo());
    await h.bundler.seedArtifacts(EMPTY_DIRTY);
    const libPath = '/node_modules/@scope/lib/src/greet.ts';
    expect(await h.bundler.artifactStore.consult(libPath)).toMatchObject({
      content: LIB_ARTIFACT,
    });
    expect(await h.bundler.artifactStore.consult('/app/node_modules/@scope/lib/src/greet.ts')).toBeNull();
  });

  it('ignores a path in no root at all', async () => {
    await register(libraryRepo());
    expect(await h.bundler.artifactStore.consult('/mnt/elsewhere/x.ts')).toBeNull();
  });
});

// Round 2 of the R3-168 gate: `/transpiled` keys on the full module path, which separates
// `/app` from `/mnt/{hash}` but NOT two roots where one nests inside the other — their joins
// can name the same module. `consult` already attributes such a module to the innermost root
// (`rootFor`), so seeding follows the same rule rather than writing whichever index was read
// last.
describe('two artifact roots that NEST resolve to the innermost, not to registration order', () => {
  let h: BundlerHarness;
  const unmounts: Array<() => void> = [];

  beforeEach(async () => {
    h = await createBundlerHarness(APP_FIXTURE, { forCompile: true });
  });
  afterEach(async () => {
    while (unmounts.length) unmounts.pop()?.();
    await h.teardown();
  });

  const INNER_ARTIFACT = '/* inner */ exports.greet = () => "inner";\n';

  /** A library whose own subtree carries a second, nested library. Both indexes name
   *  `/node_modules/@scope/lib/nested/src/greet.ts`. */
  const nesting = (): Record<string, string> => ({
    'package.json': '{"name":"@scope/lib","version":"1.0.0","main":"src/greet.ts"}',
    'nested/src/greet.ts': 'export const greet = () => "inner";\n',
    '.immediately.run/contribute-manifest.json': JSON.stringify({
      schemaVersion: 1,
      entries: [{ path: 'nested/src/greet.ts', sha: 'sha-outer-view', type: 'blob' }],
    }),
    '.immediately.run/artifacts/index.json': JSON.stringify({
      schemaVersion: 1,
      toolchain: {
        transpiler: '@immediately-run/transpiler',
        version: TRANSPILER_VERSION,
        toolchainHash: EMBEDDED_TOOLCHAIN_HASH,
        preset: 'react',
      },
      files: { '/nested/src/greet.ts': { srcSha: 'sha-outer-view', out: 'transpiled/outer.js', deps: [] } },
    }),
    '.immediately.run/artifacts/transpiled/outer.js': LIB_ARTIFACT,
    'nested/.immediately.run/contribute-manifest.json': JSON.stringify({
      schemaVersion: 1,
      entries: [{ path: 'src/greet.ts', sha: 'sha-inner', type: 'blob' }],
    }),
    'nested/.immediately.run/artifacts/index.json': JSON.stringify({
      schemaVersion: 1,
      toolchain: {
        transpiler: '@immediately-run/transpiler',
        version: TRANSPILER_VERSION,
        toolchainHash: EMBEDDED_TOOLCHAIN_HASH,
        preset: 'react',
      },
      files: { '/src/greet.ts': { srcSha: 'sha-inner', out: 'transpiled/inner.js', deps: [] } },
    }),
    'nested/.immediately.run/artifacts/transpiled/inner.js': INNER_ARTIFACT,
  });

  it('serves the innermost root`s bytes, and says what the outer root`s index claimed', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      unmounts.push(await mountInMemoryFs('/mnt/nesting', nesting()));
      await h.bundler.registerGitLibraryMount('@scope/lib', '/mnt/nesting');
      // …and the nested subtree as a root in its own right, OUTER first.
      h.bundler.artifactStore.addRoot('/node_modules/@scope/lib/nested');
      await h.bundler.seedArtifacts(EMPTY_DIRTY);

      const shared = '/node_modules/@scope/lib/nested/src/greet.ts';
      // The inner root owns the path, so its artifact is what a consult serves — never the
      // outer root's bytes under the inner root's name.
      expect(await h.bundler.artifactStore.consult(shared)).toMatchObject({ content: INNER_ARTIFACT });
      // …and the outer root's losing entry is reported rather than silently not written.
      const said = warn.mock.calls.map((c) => c.join(' ')).filter((l) => l.includes('nested artifact root owns'));
      expect(said).toHaveLength(1);
      expect(said[0]).toContain(shared);
    } finally {
      warn.mockRestore();
    }
  });
});
