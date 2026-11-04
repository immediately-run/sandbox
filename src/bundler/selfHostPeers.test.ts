import { IMPLICIT_SDK_PEERS, sdkPeerDependencies } from './selfHostPeers';
import { INSTALLED_SDK_PACKAGE_JSON, SELF_HOSTED_SDK_PACKAGE_JSON } from './testHarness/bundlerHarness';

describe('sdkPeerDependencies', () => {
  const selfHosted = JSON.parse(SELF_HOSTED_SDK_PACKAGE_JSON) as Record<string, unknown>;
  const npmPkg = JSON.parse(INSTALLED_SDK_PACKAGE_JSON) as {
    dependencies?: Record<string, string>;
    peerDependencies: Record<string, string>;
  };

  it('returns IMPLICIT_SDK_PEERS for the real self-hosted manifest, which has no peerDependencies', () => {
    expect(selfHosted.peerDependencies).toBeUndefined();
    expect(sdkPeerDependencies(selfHosted)).toEqual({ react: '^19.0.0', 'react-dom': '^19.0.0' });
  });

  it('returns a copy, so a caller cannot mutate the constant', () => {
    const peers = sdkPeerDependencies(selfHosted);
    peers.react = 'mutated';
    expect(IMPLICIT_SDK_PEERS.react).toBe('^19.0.0');
  });

  it('prefers a manifest that declares peerDependencies over the constant', () => {
    const peers = sdkPeerDependencies({ ...selfHosted, peerDependencies: { react: '^20.0.0' } });
    expect(peers).toEqual({ react: '^20.0.0' });
  });

  it("does not return the SDK's own dependencies", () => {
    const peers = sdkPeerDependencies({ ...npmPkg, dependencies: { 'not-a-peer': '^1.0.0' } });
    expect(peers['not-a-peer']).toBeUndefined();
  });

  it('drops a peer marked optional in peerDependenciesMeta', () => {
    const peers = sdkPeerDependencies({
      ...npmPkg,
      peerDependenciesMeta: { 'react-dom': { optional: true } },
    });
    expect(peers['react-dom']).toBeUndefined();
    expect(peers.react).toBe(npmPkg.peerDependencies.react);
  });

  it("(d) IMPLICIT_SDK_PEERS equals the installed npm SDK's non-optional peerDependencies", () => {
    // Drift guard: an SDK release that changes its peers fails here until the constant follows.
    const npmPeers = sdkPeerDependencies(JSON.parse(INSTALLED_SDK_PACKAGE_JSON) as Record<string, unknown>);
    expect({ ...IMPLICIT_SDK_PEERS }).toEqual(npmPeers);
  });
});
