import { transformFile, TRANSPILER_VERSION } from '@immediately-run/transpiler';

import { createBundlerHarness, mountInMemoryFs, type BundlerHarness } from '../testHarness/bundlerHarness';
import { EMBEDDED_TOOLCHAIN_HASH } from './embeddedToolchainHash';

// R3-1343 — seeding + spot-verification (PRETRANSPILED_ARTIFACTS_SPEC §5.1/§5.7) of a
// git-mounted library's OWN artifacts (LIBRARY_MOUNTS_SPEC §3 step 4).
//
// The CLI emits every artifact at `/app/<rel>` (immediately-run-cli `emitArtifacts`),
// and TWO axes of the transpile are functions of that path: the react preset gives
// app-root `.tsx`/`.jsx`/`.js` the react-refresh envelope and `/node_modules/**` the
// plain chain, AND the transpiler minifies `/node_modules/**` output
// (`compact: /node_modules/.test(filepath)`) while `/app` compiles print pretty — so
// even a same-chain `.ts` differs by formatting alone (verified 2026-11-06). A library
// is mounted at `/node_modules/<name>/…`, so its base artifact can NEVER byte-match a
// mounted-path compile, and seeding it made the §5.7 spot-check — which re-transpiles
// at the MOUNTED path, the correct reference — flag every genuine library artifact as
// tampered, discarding the whole cache on every boot that sampled one (grove's
// GroveNav.tsx, prod, 2026-11-05).
//
// Owner rulings 2026-11-06: library code carries no hot-reload envelope; a zip's
// optional `library` variant — the compile at the mounted-path shape, byte-identical
// at ANY mount name (its source map names only the basename) — is what a library root
// serves; emission is opt-in per repo (CLI side, R3-1345). Until a library opts in,
// every file is a cache MISS (live transpile), never a distrust.

const LIB_PATH = '/node_modules/@scope/lib/src/Greet.tsx';
const TS_PATH = '/node_modules/@scope/lib/src/plain.ts';
const SOURCE = `export const Greet = () => <span>hi</span>;\nexport default Greet;\n`;
const TS_SOURCE = `export const n = 1;\n`;
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

/** The transpile of `code` at `path` — every artifact input in this suite comes from
 *  this (the real producer), never from a typed literal. */
const compileAt = async (path: string, code: string): Promise<string> => {
  const r = await transformFile({ path, code });
  if ('error' in r) throw new Error(`fixture: ${path} failed to transform`);
  return r.code;
};

/** The artifact exactly as today's CLI produces it: the compile at `/app/<rel>`. */
const appCompile = (rel: string, code: string): Promise<string> => compileAt(`/app/src/${rel}`, code);

/** The `library` variant: the compile at the mounted-path shape, produced here under a
 *  mount name DIFFERENT from the consumer's — path independence is part of the contract
 *  (the zip is built once, under the publisher's package name, and mounted under
 *  whatever name the consuming app gave it). */
const variantCompile = (rel: string, code: string): Promise<string> =>
  compileAt(`/node_modules/@other/lib/src/${rel}`, code);

const GREET_OUT = 'transpiled/src/Greet.tsx.js';
const GREET_VARIANT_OUT = 'transpiled-lib/src/Greet.tsx.js';
const PLAIN_OUT = 'transpiled/src/plain.ts.js';
const PLAIN_VARIANT_OUT = 'transpiled-lib/src/plain.ts.js';

interface LibFiles {
  /** Greet.tsx's base artifact bytes (the /app compile). */
  greetBase: string;
  /** Greet.tsx's `library` variant bytes, or null to omit the variant from the index. */
  greetVariant: string | null;
  /** When set, written into the index as Greet.tsx's `library` field verbatim (malformed shapes). */
  rawLibrary?: unknown;
  /** Also carry `src/plain.ts` with these base bytes; its variant bytes, or null to omit. */
  plain?: { base: string; variant: string | null };
}

/** A library repo as its cache zip delivers it: source, manifest sidecar, artifact
 *  index, and the pre-transpiled outputs (base + optional `library` variants). */
const libraryRepo = (over: LibFiles): Record<string, string> => ({
  'package.json': '{"name":"@scope/lib","version":"1.0.0","main":"src/Greet.tsx"}',
  'src/Greet.tsx': SOURCE,
  ...(over.plain ? { 'src/plain.ts': TS_SOURCE } : {}),
  '.immediately.run/contribute-manifest.json': JSON.stringify({
    schemaVersion: 1,
    commitSha: 'lib-commit-sha',
    entries: [
      { path: 'src/Greet.tsx', sha: 'sha-greet', type: 'blob' },
      ...(over.plain ? [{ path: 'src/plain.ts', sha: 'sha-plain', type: 'blob' }] : []),
    ],
  }),
  '.immediately.run/artifacts/index.json': JSON.stringify({
    schemaVersion: 1,
    toolchain: {
      transpiler: '@immediately-run/transpiler',
      version: TRANSPILER_VERSION,
      toolchainHash: EMBEDDED_TOOLCHAIN_HASH,
      preset: 'react',
    },
    files: {
      '/src/Greet.tsx': {
        srcSha: 'sha-greet',
        out: GREET_OUT,
        deps: [],
        ...(over.rawLibrary !== undefined
          ? { library: over.rawLibrary }
          : over.greetVariant !== null
          ? { library: { out: GREET_VARIANT_OUT, deps: ['react/jsx-runtime'] } }
          : {}),
      },
      ...(over.plain
        ? {
            '/src/plain.ts': {
              srcSha: 'sha-plain',
              out: PLAIN_OUT,
              deps: [],
              ...(over.plain.variant !== null ? { library: { out: PLAIN_VARIANT_OUT, deps: [] } } : {}),
            },
          }
        : {}),
    },
  }),
  [`.immediately.run/artifacts/${GREET_OUT}`]: over.greetBase,
  ...(over.greetVariant !== null ? { [`.immediately.run/artifacts/${GREET_VARIANT_OUT}`]: over.greetVariant } : {}),
  ...(over.plain
    ? {
        [`.immediately.run/artifacts/${PLAIN_OUT}`]: over.plain.base,
        ...(over.plain.variant !== null
          ? { [`.immediately.run/artifacts/${PLAIN_VARIANT_OUT}`]: over.plain.variant }
          : {}),
      }
    : {}),
});

describe('R3-1343 seeding + spot-verify of a library-root artifact', () => {
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

  it('the fixture is the shape that diverges: BOTH paths compile both files to other bytes', async () => {
    // Guards against a vacuous pass: the chain axis alone (`.tsx` vs `.ts`) is not the
    // whole story — the compaction axis makes even the same-chain `.ts` differ, and if
    // the transpiler ever stopped branching on the path the cases below would no longer
    // distinguish variant-aware seeding from seeding the base artifact.
    expect(await variantCompile('Greet.tsx', SOURCE)).not.toBe(await appCompile('Greet.tsx', SOURCE));
    expect(await variantCompile('plain.ts', TS_SOURCE)).not.toBe(await appCompile('plain.ts', TS_SOURCE));
  });

  describe('a zip without variants (every zip built today)', () => {
    it('seeds NOTHING — the modules live-transpile and the boot stays clean', async () => {
      // On origin/main both entries seeded their /app artifacts and the first
      // spot-check distrusted the section (the prod grove false alarm this item
      // exists to end) — for the `.tsx` via the chain, for the `.ts` via compaction.
      await register(
        libraryRepo({
          greetBase: await appCompile('Greet.tsx', SOURCE),
          greetVariant: null,
          plain: { base: await appCompile('plain.ts', TS_SOURCE), variant: null },
        }),
      );
      const result = await h.bundler.seedArtifacts(EMPTY_DIRTY);
      expect(result.seeded).toBe(0);
      expect(result.libraryVariantMissing).toBe(2);
      expect(result.libraryVariantRejected).toBeUndefined();
      // The consult MISS is what makes the bundler transpile the module live.
      expect(await h.bundler.artifactStore.consult(LIB_PATH)).toBeNull();
      expect(await h.bundler.artifactStore.consult(TS_PATH)).toBeNull();
      // Nothing consumed → nothing to distrust, no discard, no §8.14 event.
      expect(await h.bundler.artifactStore.spotVerify()).toEqual({ tampered: false, sampled: 0 });
    });
  });

  describe('a zip with `library` variants', () => {
    it('seeds the .tsx variant and passes spot-verify at the mounted path', async () => {
      // The variant is built under @other/lib and consumed under @scope/lib — the
      // mounted-path compile is path-independent, so spot-verify at the MOUNTED path
      // must byte-equal it (the property that makes one zip serve every consumer).
      await register(
        libraryRepo({
          greetBase: await appCompile('Greet.tsx', SOURCE),
          greetVariant: await variantCompile('Greet.tsx', SOURCE),
          plain: {
            base: await appCompile('plain.ts', TS_SOURCE),
            variant: await variantCompile('plain.ts', TS_SOURCE),
          },
        }),
      );
      const result = await h.bundler.seedArtifacts(EMPTY_DIRTY);
      expect(result.seeded).toBe(2);
      const hit = await h.bundler.artifactStore.consult(LIB_PATH);
      expect(hit?.content).toBe(await variantCompile('Greet.tsx', SOURCE));
      expect(hit?.deps).toEqual(['react/jsx-runtime']);
      // The same-chain `.ts` serves its variant too — never its pretty /app compile.
      const tsHit = await h.bundler.artifactStore.consult(TS_PATH);
      expect(tsHit?.content).toBe(await variantCompile('plain.ts', TS_SOURCE));
      expect(h.bundler.artifactStore.consumedCount()).toBe(2);
      const verdict = await h.bundler.artifactStore.spotVerify();
      expect(verdict).toEqual({ tampered: false, sampled: 2 });
      expect(await h.bundler.artifactStore.consult(LIB_PATH)).not.toBeNull();
    });

    it('still detects a TAMPERED variant and discards the section', async () => {
      await register(
        libraryRepo({
          greetBase: await appCompile('Greet.tsx', SOURCE),
          greetVariant: `${await variantCompile('Greet.tsx', SOURCE)}\n/* TAMPERED */\n`,
        }),
      );
      await h.bundler.seedArtifacts(EMPTY_DIRTY);
      expect(await h.bundler.artifactStore.consult(LIB_PATH)).not.toBeNull();
      const verdict = await h.bundler.artifactStore.spotVerify();
      expect(verdict).toMatchObject({ tampered: true, path: LIB_PATH, reason: 'transpile-mismatch' });
      expect(await h.bundler.artifactStore.consult(LIB_PATH)).toBeNull();
    });
  });

  it('a malformed `library` field rejects only that file — the rest of the index seeds', async () => {
    // R3-843's lesson at the variant level: one poisoned entry must never cost every
    // artifact. Greet.tsx's malformed variant drops (cache miss); the healthy sibling
    // still seeds its own variant.
    await register(
      libraryRepo({
        greetBase: await appCompile('Greet.tsx', SOURCE),
        greetVariant: null,
        rawLibrary: 42,
        plain: { base: await appCompile('plain.ts', TS_SOURCE), variant: await variantCompile('plain.ts', TS_SOURCE) },
      }),
    );
    const result = await h.bundler.seedArtifacts(EMPTY_DIRTY);
    expect(result.seeded).toBe(1);
    // The malformed variant counts as REJECTED, not missing — the zip carries one;
    // the runtime just cannot serve it. On a post-emission zip this count is the
    // emission-or-confinement bug signal (R3-1343 diagnostics).
    expect(result.libraryVariantRejected).toBe(1);
    expect(result.libraryVariantMissing).toBeUndefined();
    expect(await h.bundler.artifactStore.consult(TS_PATH)).not.toBeNull();
    expect(await h.bundler.artifactStore.consult(LIB_PATH)).toBeNull();
  });
});
