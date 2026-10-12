/**
 * moduleOrigins.ts — the shared origin constants and the one URL builder both
 * unpkg consumers agree on (RegistryFS's lazy file fetch and the esm-fallback
 * subpath loader). The builder's shape is load-bearing: an exact-version
 * unpkg URL is immutable, which is what makes it eligible for the persistent
 * immutable cache (and why a RANGE in the version slot must not be cached —
 * see `bypassImmutableCache` in utils/fetch.ts, R3-820).
 */
import { UNPKG_ROOT, unpkgFileUrl } from './moduleOrigins';

describe('unpkgFileUrl', () => {
  it('builds the exact-version registry address', () => {
    expect(unpkgFileUrl('sql.js', '1.14.2', 'dist/sql-asm.js')).toBe('https://unpkg.com/sql.js@1.14.2/dist/sql-asm.js');
    expect(unpkgFileUrl('@scope/pkg', '2.0.0', 'lib/thing.js')).toBe('https://unpkg.com/@scope/pkg@2.0.0/lib/thing.js');
  });

  it('is rooted at UNPKG_ROOT — the prefix RegistryFS registers as immutable', () => {
    expect(unpkgFileUrl('a', '1.0.0', 'x.js').startsWith(UNPKG_ROOT)).toBe(true);
  });
});
