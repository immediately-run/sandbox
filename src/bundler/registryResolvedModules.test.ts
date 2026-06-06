import { parseRegistryResolvedModules } from './registryResolvedModules';

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
