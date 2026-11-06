import {
  ARTIFACT_INDEX_SCHEMA_VERSION,
  parseArtifactIndex,
  toolchainMatches,
  normalizeRepoRelPath,
  outWithinArtifacts,
  validateSeedEntry,
  readableLayerOnly,
  manifestShaMap,
  selectSeedVariant,
  type ArtifactFileEntry,
} from './artifactIndex';

// R3-48 Gate 2 (G2-2) — unit suite for the seeding-validation core
// (PRETRANSPILED_ARTIFACTS_SPEC §4.2/§5.1/§5.7). The adversarial rows (`..`
// paths, escaping `out`, dirty, srcSha mismatch, writable-layer presence, stamp
// mismatch) are the §9 Gate-2 security criteria, proven here in isolation; they
// become the regression net the G2-5 integration leans on.

const validToolchain = {
  transpiler: '@immediately-run/transpiler',
  version: '1.2.3',
  toolchainHash: 'abc123',
  preset: 'react',
};

const validIndex = {
  schemaVersion: ARTIFACT_INDEX_SCHEMA_VERSION,
  toolchain: validToolchain,
  files: {
    '/src/App.tsx': { srcSha: 'sha-app', out: 'transpiled/src/App.tsx.js', deps: ['react', './Button'] },
  },
};

describe('parseArtifactIndex (§4.2 structural validation)', () => {
  it('accepts a well-formed index', () => {
    const idx = parseArtifactIndex(JSON.parse(JSON.stringify(validIndex)));
    expect(idx).not.toBeNull();
    expect(idx!.toolchain.version).toBe('1.2.3');
    expect(idx!.files['/src/App.tsx'].deps).toEqual(['react', './Button']);
  });

  it('rejects a wrong schemaVersion (no forward-guessing across versions)', () => {
    expect(parseArtifactIndex({ ...validIndex, schemaVersion: 2 })).toBeNull();
  });

  it('rejects a missing toolchain field (the stamp must be complete)', () => {
    const { toolchainHash, ...partial } = validToolchain;
    expect(parseArtifactIndex({ ...validIndex, toolchain: partial })).toBeNull();
  });

  it('rejects a malformed files entry (missing out / non-string deps)', () => {
    expect(parseArtifactIndex({ ...validIndex, files: { '/x.ts': { srcSha: 's', deps: [] } } })).toBeNull();
    expect(parseArtifactIndex({ ...validIndex, files: { '/x.ts': { srcSha: 's', out: 'o', deps: [1] } } })).toBeNull();
  });

  it('rejects non-object input', () => {
    expect(parseArtifactIndex(null)).toBeNull();
    expect(parseArtifactIndex('nope')).toBeNull();
  });

  it('keeps a well-formed `library` variant on its entry (R3-1343)', () => {
    const idx = parseArtifactIndex({
      ...validIndex,
      files: {
        '/src/App.tsx': {
          srcSha: 'sha-app',
          out: 'transpiled/src/App.tsx.js',
          deps: ['react'],
          library: { out: 'transpiled-lib/src/App.tsx.js', deps: ['react/jsx-runtime'] },
        },
      },
    });
    expect(idx!.files['/src/App.tsx'].library).toEqual({
      out: 'transpiled-lib/src/App.tsx.js',
      deps: ['react/jsx-runtime'],
    });
  });

  it('drops a malformed `library` variant WITHOUT rejecting the index (R3-843 at the variant level)', () => {
    for (const library of [42, 'nope', { out: 3, deps: [] }, { out: 'o' }, { deps: [] }, { out: 'o', deps: [1] }]) {
      const idx = parseArtifactIndex({
        ...validIndex,
        files: { '/src/App.tsx': { srcSha: 'sha-app', out: 'transpiled/src/App.tsx.js', deps: [], library } },
      });
      // The entry survives; only its variant is gone.
      expect(idx).not.toBeNull();
      expect(idx!.files['/src/App.tsx'].library).toBeUndefined();
    }
  });
});

describe('toolchainMatches (§4.4 stamp gate)', () => {
  it('matches only when BOTH version and toolchainHash agree', () => {
    expect(toolchainMatches(validToolchain, { version: '1.2.3', toolchainHash: 'abc123' })).toBe(true);
    expect(toolchainMatches(validToolchain, { version: '1.2.4', toolchainHash: 'abc123' })).toBe(false);
    expect(toolchainMatches(validToolchain, { version: '1.2.3', toolchainHash: 'DIFFERENT' })).toBe(false);
  });
});

describe('normalizeRepoRelPath (§5.1/§5.7 path confinement)', () => {
  it('accepts a clean absolute repo-relative path', () => {
    expect(normalizeRepoRelPath('/src/App.tsx')).toBe('/src/App.tsx');
  });

  it('rejects traversal, dot, empty, relative, and root paths', () => {
    expect(normalizeRepoRelPath('/src/../etc/passwd')).toBeNull();
    expect(normalizeRepoRelPath('/src/./App.tsx')).toBeNull();
    expect(normalizeRepoRelPath('/src//App.tsx')).toBeNull(); // empty segment
    expect(normalizeRepoRelPath('src/App.tsx')).toBeNull(); // not absolute
    expect(normalizeRepoRelPath('/')).toBeNull();
    expect(normalizeRepoRelPath('')).toBeNull();
  });
});

describe('outWithinArtifacts (§5.1/§5.7 out confinement)', () => {
  it('accepts a path inside the artifacts dir', () => {
    expect(outWithinArtifacts('transpiled/src/App.tsx.js')).toBe(
      '.immediately.run/artifacts/transpiled/src/App.tsx.js',
    );
  });

  it('rejects traversal out of the artifacts dir', () => {
    expect(outWithinArtifacts('../../node_modules/react/index.js')).toBeNull();
    expect(outWithinArtifacts('transpiled/../../../etc/x')).toBeNull();
  });

  it('rejects an absolute out (cannot escape via leading slash)', () => {
    expect(outWithinArtifacts('/node_modules/react/index.js')).toBeNull();
    expect(outWithinArtifacts('')).toBeNull();
  });
});

describe('validateSeedEntry (§5.1 per-file seeding rules)', () => {
  const manifestShas = new Map<string, string>([['/src/App.tsx', 'sha-app']]);
  const entry: ArtifactFileEntry = { srcSha: 'sha-app', out: 'transpiled/src/App.tsx.js', deps: ['react'] };

  it('passes a fully-valid entry and returns the confined out + deps', () => {
    const r = validateSeedEntry('/src/App.tsx', entry, { manifestShas, dirtySet: new Set() });
    expect(r).toEqual({
      ok: true,
      path: '/src/App.tsx',
      out: '.immediately.run/artifacts/transpiled/src/App.tsx.js',
      deps: ['react'],
    });
  });

  it('rejects a traversing path key (bad-path) before anything else', () => {
    const r = validateSeedEntry('/src/../../etc/x', entry, { manifestShas, dirtySet: new Set() });
    expect(r).toEqual({ ok: false, reason: 'bad-path' });
  });

  it('rejects a path absent from the manifest entries (not-in-manifest)', () => {
    const r = validateSeedEntry('/src/Sneaky.tsx', entry, { manifestShas, dirtySet: new Set() });
    expect(r).toEqual({ ok: false, reason: 'not-in-manifest' });
  });

  it('rejects an out that escapes the artifacts dir (out-escapes-artifacts)', () => {
    const evil = { ...entry, out: '../../node_modules/react/index.js' };
    const r = validateSeedEntry('/src/App.tsx', evil, { manifestShas, dirtySet: new Set() });
    expect(r).toEqual({ ok: false, reason: 'out-escapes-artifacts' });
  });

  it('rejects a dirty (previous-session-edited) path (dirty)', () => {
    const r = validateSeedEntry('/src/App.tsx', entry, { manifestShas, dirtySet: new Set(['/src/App.tsx']) });
    expect(r).toEqual({ ok: false, reason: 'dirty' });
  });

  it('rejects an srcSha that disagrees with the manifest (srcsha-mismatch)', () => {
    const corrupt = { ...entry, srcSha: 'sha-tampered' };
    const r = validateSeedEntry('/src/App.tsx', corrupt, { manifestShas, dirtySet: new Set() });
    expect(r).toEqual({ ok: false, reason: 'srcsha-mismatch' });
  });
});

describe('readableLayerOnly (§5.1 PT2-4)', () => {
  it('passes when no seeding input is in the writable layer', () => {
    const inputs = ['/.immediately.run/artifacts/index.json', '/.immediately.run/artifacts/transpiled/src/App.tsx.js'];
    expect(readableLayerOnly(inputs, new Set(['/src/App.tsx']))).toBe(true);
  });

  it('rejects the whole section if ANY input is writable-layer present', () => {
    const inputs = ['/.immediately.run/artifacts/index.json', '/.immediately.run/artifacts/transpiled/src/App.tsx.js'];
    const writable = new Set(['/.immediately.run/artifacts/transpiled/src/App.tsx.js']);
    expect(readableLayerOnly(inputs, writable)).toBe(false);
  });
});

describe('manifestShaMap', () => {
  it('canonicalizes entry paths so lookups align with normalizeRepoRelPath', () => {
    const map = manifestShaMap([
      { path: 'src/App.tsx', sha: 'sha-app' }, // relative → absolutized
      { path: '/src/Button.tsx', sha: 'sha-btn' },
    ]);
    expect(map.get('/src/App.tsx')).toBe('sha-app');
    expect(map.get('/src/Button.tsx')).toBe('sha-btn');
  });

  it('drops entries whose path cannot canonicalize', () => {
    const map = manifestShaMap([{ path: '/src/../etc', sha: 'x' }]);
    expect(map.size).toBe(0);
  });
});

describe('selectSeedVariant (R3-1343 — which bytes a root serves for one entry)', () => {
  const base = (over: Partial<ArtifactFileEntry> = {}): ArtifactFileEntry => ({
    srcSha: 's',
    out: 'transpiled/src/x.js',
    deps: [],
    ...over,
  });

  it('the /app root always seeds the base entry — the publisher path IS the mounted path', () => {
    const withVariant = base({ library: { out: 'transpiled-lib/src/x.js', deps: ['react/jsx-runtime'] } });
    expect(selectSeedVariant(withVariant, { isAppRoot: true })).toEqual({ kind: 'base' });
    expect(selectSeedVariant(base(), { isAppRoot: true })).toEqual({ kind: 'base' });
  });

  it('a library root seeds the variant when the zip carries one, with `out` confined', () => {
    const decision = selectSeedVariant(
      base({ library: { out: 'transpiled-lib/src/x.js', deps: ['react/jsx-runtime'] } }),
      { isAppRoot: false },
    );
    expect(decision).toEqual({
      kind: 'library',
      out: '.immediately.run/artifacts/transpiled-lib/src/x.js',
      deps: ['react/jsx-runtime'],
    });
  });

  it('a library root skips an entry with no variant — no /app compile byte-matches a mount', () => {
    // Two path axes make the base artifact unusable at a mount, and either alone is
    // enough: the CHAIN (refresh for app-root `.tsx`/`.jsx`/`.js`, plain under
    // `/node_modules`) and COMPACTION (the transpiler minifies `/node_modules/**`, so
    // even a same-chain `.ts` compiles pretty at /app and minified at the mount —
    // verified 2026-11-06: the plain `.ts` pair differs by formatting alone). `.mdx`
    // has no chain at all under `/node_modules`. The entry carries no path — the
    // decision cannot depend on the extension, and does not.
    expect(selectSeedVariant(base(), { isAppRoot: false })).toEqual({
      kind: 'skip',
      reason: 'library-variant-missing',
    });
  });

  it('a variant whose `out` escapes .immediately.run/artifacts/ is treated as absent', () => {
    // Adversarial row: the escaping variant never seeds — the confinement rule is the
    // same one `validateSeedEntry` applies to the base `out`.
    const escaping = base({ library: { out: '../../evil.js', deps: [] } });
    expect(selectSeedVariant(escaping, { isAppRoot: false })).toEqual({
      kind: 'skip',
      reason: 'library-variant-missing',
    });
  });
});
