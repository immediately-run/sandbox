import { SANDBOX_PROTOCOL_VERSION, SDK_PROTOCOL_VERSION, handshakePayload } from './version';

// R3-274d — the frame announces its OWN wire version. The property under test is
// that the announcement stayed ADDITIVE: a host built before this change reads
// `protocolVersion` and must find it unchanged, in the same place, with the same
// meaning. Dropping or renaming it would refuse every frame on an older host.
describe('handshakePayload — additive frame version announcement', () => {
  it('still carries the legacy protocolVersion field', () => {
    expect(handshakePayload().protocolVersion).toBe(SDK_PROTOCOL_VERSION);
  });

  it('carries the frame protocol version alongside it', () => {
    expect(handshakePayload().sandboxProtocolVersion).toBe(SANDBOX_PROTOCOL_VERSION);
  });

  it('is additive: the legacy field is a strict subset of the new payload', () => {
    const legacy = { protocolVersion: SDK_PROTOCOL_VERSION };
    expect(handshakePayload()).toMatchObject(legacy);
  });

  it('announces semver-shaped versions (the host compares them numerically)', () => {
    for (const v of [SDK_PROTOCOL_VERSION, SANDBOX_PROTOCOL_VERSION]) {
      expect(v).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it('does not source the SDK version from a sibling checkout any more', () => {
    // The retired path was scripts/gen-sdk-versions.mjs → src/generated/sdkVersions.ts.
    // Both are deleted; this asserts nothing re-introduces the import.
    expect(() => require('../generated/sdkVersions')).toThrow();
  });
});
