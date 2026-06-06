import {
  parseRegistryResolvedModules,
  concreteVersion,
  planRegistryResolution,
} from './registryResolvedModules';

describe('parseRegistryResolvedModules', () => {
  it('returns the opted-in module list', () => {
    const raw = JSON.stringify({
      dependencies: { '@immediately-run/sdk': '^0.2.7' },
      'immediately.run': { resolveFromRegistry: ['@immediately-run/sdk'] },
    });
    expect(parseRegistryResolvedModules(raw)).toEqual(['@immediately-run/sdk']);
  });

  it('defaults to [] when the field is absent (every existing app injects)', () => {
    const raw = JSON.stringify({ dependencies: { react: '^19.0.0' } });
    expect(parseRegistryResolvedModules(raw)).toEqual([]);
  });

  it('defaults to [] when immediately.run has no resolveFromRegistry', () => {
    expect(parseRegistryResolvedModules(JSON.stringify({ 'immediately.run': {} }))).toEqual([]);
  });

  it('ignores a non-array resolveFromRegistry', () => {
    const raw = JSON.stringify({ 'immediately.run': { resolveFromRegistry: '@immediately-run/sdk' } });
    expect(parseRegistryResolvedModules(raw)).toEqual([]);
  });

  it('filters out non-string entries', () => {
    const raw = JSON.stringify({
      'immediately.run': { resolveFromRegistry: ['@immediately-run/sdk', 42, null, 'other'] },
    });
    expect(parseRegistryResolvedModules(raw)).toEqual(['@immediately-run/sdk', 'other']);
  });

  it('returns [] on malformed JSON (safe fallback to injection)', () => {
    expect(parseRegistryResolvedModules('{ not valid json')).toEqual([]);
  });
});

describe('concreteVersion', () => {
  it('passes through an exact version', () => {
    expect(concreteVersion('0.2.7')).toBe('0.2.7');
  });

  it('strips caret/tilde/range operators to the floor version', () => {
    expect(concreteVersion('^0.2.7')).toBe('0.2.7');
    expect(concreteVersion('~1.4.0')).toBe('1.4.0');
    expect(concreteVersion('>=2.0.0')).toBe('2.0.0');
    expect(concreteVersion('v3.1.2')).toBe('3.1.2');
  });

  it('keeps prerelease/build metadata', () => {
    expect(concreteVersion('0.3.0-rc.1')).toBe('0.3.0-rc.1');
  });

  it('returns undefined for non-pinned specifiers (caller falls back to injection)', () => {
    expect(concreteVersion('*')).toBeUndefined();
    expect(concreteVersion('latest')).toBeUndefined();
    expect(concreteVersion('1.2')).toBeUndefined();
    expect(concreteVersion('github:owner/repo')).toBeUndefined();
    expect(concreteVersion(undefined)).toBeUndefined();
  });
});

describe('planRegistryResolution', () => {
  const bases = { '@immediately-run/sdk': 'https://example.test/sdk' };

  it('plans a self-host fetch at the pinned version', () => {
    const raw = JSON.stringify({
      dependencies: { '@immediately-run/sdk': '^0.2.7', react: '^19.0.0' },
      'immediately.run': { resolveFromRegistry: ['@immediately-run/sdk'] },
    });
    const plan = planRegistryResolution(raw, bases);
    expect(plan.get('@immediately-run/sdk')).toEqual({
      name: '@immediately-run/sdk',
      version: '0.2.7',
      baseUrl: 'https://example.test/sdk/v/0.2.7',
    });
  });

  it('omits a module with no self-host base (caller injects it)', () => {
    const raw = JSON.stringify({
      dependencies: { '@other/pkg': '1.0.0' },
      'immediately.run': { resolveFromRegistry: ['@other/pkg'] },
    });
    expect(planRegistryResolution(raw, bases).size).toBe(0);
  });

  it('omits an opted-in module with no concrete pinned version', () => {
    const raw = JSON.stringify({
      dependencies: { '@immediately-run/sdk': 'latest' },
      'immediately.run': { resolveFromRegistry: ['@immediately-run/sdk'] },
    });
    expect(planRegistryResolution(raw, bases).size).toBe(0);
  });

  it('omits an opted-in module absent from dependencies', () => {
    const raw = JSON.stringify({
      'immediately.run': { resolveFromRegistry: ['@immediately-run/sdk'] },
    });
    expect(planRegistryResolution(raw, bases).size).toBe(0);
  });

  it('returns an empty plan when nothing is opted in', () => {
    const raw = JSON.stringify({ dependencies: { '@immediately-run/sdk': '0.2.7' } });
    expect(planRegistryResolution(raw, bases).size).toBe(0);
  });

  it('returns an empty plan on malformed JSON', () => {
    expect(planRegistryResolution('{nope', bases).size).toBe(0);
  });
});
