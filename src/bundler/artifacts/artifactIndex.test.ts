import {
  ARTIFACT_INDEX_SCHEMA_VERSION,
  parseArtifactIndex,
  toolchainMatches,
  normalizeRepoRelPath,
  outWithinArtifacts,
  validateSeedEntry,
  readableLayerOnly,
  manifestShaMap,
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
    expect(outWithinArtifacts('transpiled/src/App.tsx.js')).toBe('.immediately.run/artifacts/transpiled/src/App.tsx.js');
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
