import { sdkPeerDependencies } from './selfHostPeers';
import { INSTALLED_SDK_PACKAGE_JSON } from './testHarness/bundlerHarness';

describe('sdkPeerDependencies', () => {
  const sdkPkg = JSON.parse(INSTALLED_SDK_PACKAGE_JSON) as {
    dependencies?: Record<string, string>;
    peerDependencies: Record<string, string>;
  };

  it('returns react and react-dom at the ranges the real SDK manifest declares', () => {
    const peers = sdkPeerDependencies(sdkPkg);
    expect(peers.react).toBe(sdkPkg.peerDependencies.react);
    expect(peers['react-dom']).toBe(sdkPkg.peerDependencies['react-dom']);
    expect(peers).toEqual(sdkPkg.peerDependencies);
  });

  it("does not return the SDK's own dependencies", () => {
    const peers = sdkPeerDependencies({ ...sdkPkg, dependencies: { 'not-a-peer': '^1.0.0' } });
    expect(peers['not-a-peer']).toBeUndefined();
  });

  it('drops a peer marked optional in peerDependenciesMeta', () => {
    const peers = sdkPeerDependencies({
      ...sdkPkg,
      peerDependenciesMeta: { 'react-dom': { optional: true } },
    });
    expect(peers['react-dom']).toBeUndefined();
    expect(peers.react).toBe(sdkPkg.peerDependencies.react);
  });

  it('returns nothing for a missing manifest', () => {
    expect(sdkPeerDependencies(undefined)).toEqual({});
  });
});
