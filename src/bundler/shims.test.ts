/**
 * shims.ts — the shimmed-builtin name list (R3-1203 single-sourced it here).
 *
 * The list is the contract between `Bundler.preloadModules` (which preloads one
 * shim package per name — it drives its loop off this constant) and the
 * undeclared-import collector (which must skip exactly these names, so a
 * package's metadata naming `fs` resolves to the shim, never to an esm.sh
 * rescue). This suite pins the contract's invariants on the real export; the
 * collector side of the same contract is derived from this constant in
 * undeclared-transitive.test.ts.
 */
import { NODE_SHIMMED_BUILTIN_NAMES } from './shims';

describe('NODE_SHIMMED_BUILTIN_NAMES (the preload↔collector contract)', () => {
  it('every entry is a bare, lowercase, deduped builtin name — collector/set semantics hold', () => {
    expect(NODE_SHIMMED_BUILTIN_NAMES.length).toBe(new Set(NODE_SHIMMED_BUILTIN_NAMES).size);
    for (const name of NODE_SHIMMED_BUILTIN_NAMES) {
      expect(name).toMatch(/^[a-z][a-z0-9]*$/); // no scope, no node: prefix, no path
    }
  });

  it('carries the two shims with their own module sources (fs, crypto) — preloadModules keys on them', () => {
    // `Bundler.preloadModules` overrides the source for exactly these two; a
    // name dropping out of the list here would stop being preloaded at all.
    expect(NODE_SHIMMED_BUILTIN_NAMES).toContain('fs');
    expect(NODE_SHIMMED_BUILTIN_NAMES).toContain('crypto');
  });
});
