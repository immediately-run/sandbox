import { TRANSPILER_VERSION } from '@immediately-run/transpiler';

import { parseArtifactIndex, validateSeedEntry, normalizeRepoRelPath } from './artifactIndex';
import { EMBEDDED_TOOLCHAIN_HASH } from './embeddedToolchainHash';

// R3-168 Phase-0 ROUTING SPIKE (MDX_FROM_MOUNT_SPEC §3): *can the Bundler's
// artifact-consult + the metadata-store seeding cover a SIBLING content mount
// (`/mnt/{hash}`), not just `/app`?*
//
// This is a de-risking spike, not the implementation. It proves the answer is YES by
// exercising a **root-parameterized** replica of the ArtifactStore's core seed /
// consult / seedMdxMetadata logic against BOTH `/app` and `/mnt/spike`, reusing the
// production `parseArtifactIndex` / `validateSeedEntry` / `normalizeRepoRelPath`
// (already root-agnostic — they operate on repo-relative keys). It also reproduces
// the two coupling defects the trace surfaced, and shows the fix:
//
//  1. **Seed/consult keying only coincides for `/app`.** Production `seed()` writes
//     `/transpiled${v.path}.js` (v.path is repo-relative) while `consult()` reads
//     `/transpiled${stripAppRoot(path)}.js`. For `/app` these agree (stripAppRoot
//     strips the root → the repo-relative path); for `/mnt/{hash}` they DON'T, so a
//     mount consult would miss. Fix: strip the ACTIVE root consistently on both.
//  2. **`/transpiled` collides across roots.** Repo-relative keying means
//     `/app/content/x` and `/mnt/spike/content/x` both map to
//     `/transpiled/content/x.js`. Fix: namespace `/transpiled` per root.
//
// The metadata "path-rebasing wrinkle" (spec §3, §7) is shown to be trivial: the
// sidecar keys are repo-relative internally (`normalizeRepoRelPath`), so seeding
// rebases by joining to the ACTIVE root instead of `/app` — a one-line change.

// ---- a tiny in-memory ArtifactFs (the spike needs no ZenFS harness) ------------
class MapFs {
  private files = new Map<string, string>();
  set(path: string, content: string) {
    this.files.set(path, content);
  }
  readFileAsync(path: string): Promise<string> {
    const v = this.files.get(path);
    if (v === undefined) return Promise.reject(new Error(`ENOENT ${path}`));
    return Promise.resolve(v);
  }
  writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
    return Promise.resolve();
  }
  isFileAsync(path: string): Promise<boolean> {
    return Promise.resolve(this.files.has(path));
  }
  has(path: string) {
    return this.files.has(path);
  }
}

// ---- root-parameterized helpers (the proposed change; today these are `/app`-only
//      free functions in artifactStore.ts / fsLayout.ts) --------------------------
const ARTIFACTS = '.immediately.run/artifacts';
const underRoot = (root: string, repoRel: string) => `${root}${repoRel.startsWith('/') ? '' : '/'}${repoRel}`;
const stripRoot = (root: string, abs: string) =>
  abs === root ? '/' : abs.startsWith(`${root}/`) ? abs.slice(root.length) : abs;
// Namespace `/transpiled` per root so two mounts with the same repo-relative path
// never collide (defect 2). `/app` → `/transpiled/app/...`, `/mnt/spike` →
// `/transpiled/mnt/spike/...`.
const transpiledFor = (root: string, absPath: string) => `/transpiled${root}${stripRoot(root, absPath)}.js`;

/** A root-parameterized seed: reads the ROOT's artifact index + manifest, writes each
 *  covered artifact into the root's `/transpiled` namespace, keyed by the root-joined
 *  absolute path. Returns the seeded absolute paths → bytes (the consult map). */
async function seedFromRoot(fs: MapFs, root: string, manifestShas: Map<string, string>) {
  const seeded = new Map<string, string>();
  const index = parseArtifactIndex(JSON.parse(await fs.readFileAsync(underRoot(root, `${ARTIFACTS}/index.json`))));
  if (!index) return seeded;
  if (index.toolchain.version !== TRANSPILER_VERSION || index.toolchain.toolchainHash !== EMBEDDED_TOOLCHAIN_HASH) {
    return seeded;
  }
  for (const [rawKey, entry] of Object.entries(index.files)) {
    const v = validateSeedEntry(rawKey, entry, { manifestShas, dirtySet: new Set() });
    if (!v.ok) continue;
    const content = await fs.readFileAsync(underRoot(root, `/${v.out}`));
    const abs = underRoot(root, v.path); // ROOT-joined (the rebase)
    await fs.writeFile(transpiledFor(root, abs), content); // per-root namespace
    seeded.set(abs, content);
  }
  return seeded;
}

/** A root-parameterized consult: HIT iff the root's `/transpiled` namespace holds
 *  the module (uses the SAME root-stripping as the seed — the fix for defect 1). */
async function consultFromRoot(fs: MapFs, root: string, absModulePath: string): Promise<string | null> {
  if (absModulePath !== root && !absModulePath.startsWith(`${root}/`)) return null;
  const p = transpiledFor(root, absModulePath);
  return (await fs.isFileAsync(p)) ? fs.readFileAsync(p) : null;
}

/** A root-parameterized metadata seed: rebases the repo-relative sidecar keys to the
 *  ACTIVE root (the §3 wrinkle → trivial). */
async function seedMetadataFromRoot(fs: MapFs, root: string, manifestShas: Map<string, string>) {
  const entries = new Map<string, Record<string, unknown>>();
  const parsed = JSON.parse(await fs.readFileAsync(underRoot(root, `${ARTIFACTS}/mdx-metadata.json`)));
  for (const [rawKey, value] of Object.entries(
    parsed.files as Record<string, { srcSha: string; frontmatter: Record<string, unknown> }>,
  )) {
    const path = normalizeRepoRelPath(rawKey);
    if (!path) continue;
    const sha = manifestShas.get(path);
    if (sha === undefined || value.srcSha !== sha) continue;
    if (Object.keys(value.frontmatter).length === 0) continue;
    entries.set(underRoot(root, path), value.frontmatter); // rebased to ACTIVE root
  }
  return entries;
}

// ---- fixtures: the same content repo, resident under two different roots --------
const contentFixture = (root: string, fs: MapFs) => {
  fs.set(
    underRoot(root, `${ARTIFACTS}/index.json`),
    JSON.stringify({
      schemaVersion: 1,
      toolchain: {
        transpiler: '@immediately-run/transpiler',
        version: TRANSPILER_VERSION,
        toolchainHash: EMBEDDED_TOOLCHAIN_HASH,
        preset: 'react',
      },
      files: { '/content/post.mdx': { srcSha: 'sha-post', out: 'transpiled/content/post.mdx.js', deps: [] } },
    }),
  );
  fs.set(
    underRoot(root, `/${ARTIFACTS}/transpiled/content/post.mdx.js`),
    `/* pre-compiled ${root} */ export default 1;\n`,
  );
  fs.set(
    underRoot(root, `${ARTIFACTS}/mdx-metadata.json`),
    JSON.stringify({
      schemaVersion: 1,
      files: { '/content/post.mdx': { srcSha: 'sha-post', frontmatter: { title: 'Post', tags: ['x'] } } },
    }),
  );
};

const MANIFEST = new Map([['/content/post.mdx', 'sha-post']]);

describe('R3-168 Phase-0 spike: artifact-consult + metadata-seed can cover a sibling mount', () => {
  it('baseline: seeds + consults an /app artifact (parity with production keying)', async () => {
    const fs = new MapFs();
    contentFixture('/app', fs);
    const seeded = await seedFromRoot(fs, '/app', MANIFEST);
    expect(seeded.has('/app/content/post.mdx')).toBe(true);
    const hit = await consultFromRoot(fs, '/app', '/app/content/post.mdx');
    expect(hit).toMatch(/pre-compiled \/app/);
  });

  it('THE SPIKE ANSWER — YES: seeds + consults an artifact resident in a /mnt mount (zero transform)', async () => {
    const fs = new MapFs();
    contentFixture('/mnt/spike', fs);
    const seeded = await seedFromRoot(fs, '/mnt/spike', MANIFEST);
    // The artifact hit is keyed at the MOUNT path (rebased), served from bytes.
    expect(seeded.get('/mnt/spike/content/post.mdx')).toMatch(/pre-compiled \/mnt\/spike/);
    const hit = await consultFromRoot(fs, '/mnt/spike', '/mnt/spike/content/post.mdx');
    expect(hit).toMatch(/pre-compiled \/mnt\/spike/); // HIT — no live transpile
    // The consult MISSES a path outside the mount (the store is root-scoped).
    expect(await consultFromRoot(fs, '/mnt/spike', '/app/content/post.mdx')).toBeNull();
  });

  it('defect 1 fixed: seed/consult keying agrees for a mount (it would NOT with the /app-only helpers)', async () => {
    // Production writes `/transpiled${v.path}` (repo-rel) but consults
    // `/transpiled${stripAppRoot(path)}`; for a mount those differ. The
    // root-parameterized pair uses stripRoot on BOTH → they agree.
    const fs = new MapFs();
    contentFixture('/mnt/spike', fs);
    await seedFromRoot(fs, '/mnt/spike', MANIFEST);
    expect(fs.has('/transpiled/mnt/spike/content/post.mdx.js')).toBe(true);
    expect(await consultFromRoot(fs, '/mnt/spike', '/mnt/spike/content/post.mdx')).not.toBeNull();
  });

  it('defect 2 fixed: two roots with the SAME repo-relative path do NOT collide in /transpiled', async () => {
    const fs = new MapFs();
    contentFixture('/app', fs);
    contentFixture('/mnt/spike', fs);
    await seedFromRoot(fs, '/app', MANIFEST);
    await seedFromRoot(fs, '/mnt/spike', MANIFEST);
    // Distinct per-root transpiled entries; each consult returns ITS root's bytes.
    expect(await consultFromRoot(fs, '/app', '/app/content/post.mdx')).toMatch(/pre-compiled \/app/);
    expect(await consultFromRoot(fs, '/mnt/spike', '/mnt/spike/content/post.mdx')).toMatch(/pre-compiled \/mnt\/spike/);
  });

  it('the §3 path-rebasing wrinkle is trivial: metadata seeds keyed to the MOUNT root, no scan', async () => {
    const fs = new MapFs();
    contentFixture('/mnt/spike', fs);
    const entries = await seedMetadataFromRoot(fs, '/mnt/spike', MANIFEST);
    // The sidecar key `/content/post.mdx` (repo-relative) rebases to the mount root.
    expect(entries.has('/mnt/spike/content/post.mdx')).toBe(true);
    expect(entries.get('/mnt/spike/content/post.mdx')).toEqual({ title: 'Post', tags: ['x'] });
    // No `/app` key leaks in from a mount seed.
    expect(entries.has('/app/content/post.mdx')).toBe(false);
  });
});
