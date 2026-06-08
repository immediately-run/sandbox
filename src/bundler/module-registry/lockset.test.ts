/**
 * @jest-environment jsdom
 *
 * Lockset consumption tests (PRETRANSPILED_ARTIFACTS_SPEC §5.4 + plan phase 01
 * exit criteria): a valid, exactly-matching sidecar lockset replaces the
 * blocking dep_tree request; every mismatch falls back to live resolution.
 * (jsdom: importing ModuleRegistry transitively loads the evaluation runtime,
 * which references `window`/`self` at module scope.)
 */
import { ModuleRegistry } from '.';
import { Bundler } from '../bundler';
import { depMapsEqual, locksetClosureValid, validateLockset } from './lockset';
import { CDN_VERSION, fetchManifest } from './module-cdn';

jest.mock('./module-cdn', () => ({
  ...jest.requireActual('./module-cdn'),
  fetchManifest: jest.fn(),
  fetchModule: jest.fn(),
}));

const mockedFetchManifest = fetchManifest as jest.MockedFunction<typeof fetchManifest>;

const RESOLVED = [
  { n: 'react', v: '18.3.1', d: 0 },
  { n: 'scheduler', v: '0.23.0', d: 1 },
];

// The input DepMap as loadNodeModules computes it for { react: ^18.2.0 } under
// the react preset (augmented; no build deps present).
const DEPS = {
  'core-js': '3.22.7',
  react: '^18.2.0',
  'react-error-boundary': '^6.1.0',
  'react-refresh': '^0.11.0',
};

const lockset = (overrides: Record<string, unknown> = {}) => ({
  cdnVersion: CDN_VERSION,
  dependencies: { ...DEPS },
  resolved: RESOLVED,
  ...overrides,
});

describe('validateLockset', () => {
  it('accepts a well-formed lockset at the current CDN version', () => {
    expect(validateLockset(lockset())).not.toBeNull();
  });

  it.each([
    ['null', null],
    ['non-object', 'lockset'],
    ['wrong cdnVersion', lockset({ cdnVersion: CDN_VERSION + 1 })],
    ['non-string range', lockset({ dependencies: { react: 18 } })],
    ['dependencies array', lockset({ dependencies: ['react'] })],
    ['malformed resolved entry', lockset({ resolved: [{ n: 'react', v: 18, d: 0 }] })],
    ['resolved not an array', lockset({ resolved: {} })],
  ])('rejects %s', (_label, value) => {
    expect(validateLockset(value)).toBeNull();
  });
});

describe('locksetClosureValid (PT-2: no injected top-level package)', () => {
  it('accepts a lockset whose depth-0 entries are all declared', () => {
    expect(locksetClosureValid(lockset())).toBe(true); // react d0 ∈ declared
  });

  it('rejects a lockset with an injected top-level package not in declared deps', () => {
    const poisoned = lockset({
      resolved: [...RESOLVED, { n: 'evil-pkg', v: '1.0.0', d: 0 }],
    });
    expect(locksetClosureValid(poisoned as never)).toBe(false);
  });

  it('does NOT reject an extra transitive (depth>0) entry — documented residual', () => {
    const withTransitive = lockset({
      resolved: [...RESOLVED, { n: 'some-transitive', v: '2.0.0', d: 2 }],
    });
    expect(locksetClosureValid(withTransitive as never)).toBe(true);
  });
});

describe('depMapsEqual', () => {
  it('is order-independent and exact', () => {
    expect(depMapsEqual({ a: '1', b: '2' }, { b: '2', a: '1' })).toBe(true);
    expect(depMapsEqual({ a: '1' }, { a: '2' })).toBe(false);
    expect(depMapsEqual({ a: '1' }, { a: '1', b: '2' })).toBe(false);
    expect(depMapsEqual({ a: '1', b: '2' }, { a: '1' })).toBe(false);
    expect(depMapsEqual({}, {})).toBe(true);
  });
});

describe('ModuleRegistry.fetchManifest with a lockset', () => {
  // fetchManifest never touches the bundler; a bare stub suffices.
  const registry = () => new ModuleRegistry({} as Bundler);

  beforeEach(() => {
    mockedFetchManifest.mockReset();
    mockedFetchManifest.mockResolvedValue([{ n: 'live', v: '1.0.0', d: 0 }]);
  });

  it('uses a matching lockset and skips the dep_tree request', async () => {
    const r = registry();
    await r.fetchManifest({ ...DEPS }, true, lockset());
    expect(r.manifest).toEqual(RESOLVED);
    expect(mockedFetchManifest).not.toHaveBeenCalled();
  });

  it('matches against the post-filter DepMap (build deps stripped)', async () => {
    const r = registry();
    // vite is a build dep: filtered out before comparison, so the lockset
    // (computed over the filtered map) still matches.
    await r.fetchManifest({ ...DEPS, vite: '^5.0.0' }, true, lockset());
    expect(r.manifest).toEqual(RESOLVED);
    expect(mockedFetchManifest).not.toHaveBeenCalled();
  });

  it('resolves live when the dependency echo mismatches (edited deps)', async () => {
    const r = registry();
    await r.fetchManifest({ ...DEPS, zod: '^3.0.0' }, true, lockset());
    expect(mockedFetchManifest).toHaveBeenCalledTimes(1);
    expect(r.manifest).toEqual([{ n: 'live', v: '1.0.0', d: 0 }]);
  });

  it('resolves live with no lockset', async () => {
    const r = registry();
    await r.fetchManifest({ ...DEPS }, true, undefined);
    expect(mockedFetchManifest).toHaveBeenCalledTimes(1);
  });

  it('rejects a lockset with an injected root and resolves live (PT-2)', async () => {
    const r = registry();
    // Echo matches the declared deps, but `resolved` smuggles an extra
    // top-level package — the whole lockset is rejected, not partially trusted.
    const poisoned = lockset({ resolved: [...RESOLVED, { n: 'evil-pkg', v: '1.0.0', d: 0 }] });
    await r.fetchManifest({ ...DEPS }, true, poisoned as never);
    expect(mockedFetchManifest).toHaveBeenCalledTimes(1);
    expect(r.manifest).toEqual([{ n: 'live', v: '1.0.0', d: 0 }]);
  });
});
