/**
 * The wire protocol versions this FRAME announces (PLATFORM_LAYERING_SPEC §2 / S1
 * target 2, R3-274d).
 *
 * Two versions, because they answer two different questions:
 *
 * - {@link SANDBOX_PROTOCOL_VERSION} — the version of the sandbox↔host wire THIS
 *   FRAME speaks: the postMessage envelope, the dispatch vocabulary, the channel
 *   set (`src/generated/protocol.ts`). It is the frame's own contract, defined
 *   here, bumped here.
 * - {@link SDK_PROTOCOL_VERSION} — the version of the app↔host request surface the
 *   *SDK* speaks. It is not the frame's to speak for. The SDK announces its own on
 *   its own `sdk-handshake`, from `@immediately-run/sdk`'s `runtime.ts`.
 *
 * Until R3-274d, this frame announced the SDK's number, read at build time out of a
 * SIBLING CHECKOUT of the SDK source (`scripts/gen-sdk-versions.mjs` →
 * `src/generated/sdkVersions.ts`). That is retired: a build must not depend on
 * another repo being checked out next to it, and a frame should not be the one to
 * report a version it does not own.
 *
 * The `protocolVersion` field is still announced, frozen at the value that
 * build-time read has produced since it was introduced, so **nothing on the host
 * side changes behaviour**: the host's fail-closed gate
 * (`site-main/src/registry/protocolHandshake.ts`) compares exactly what it compared
 * before. The frame now sends `sandboxProtocolVersion` alongside it. The host logs
 * that field this phase and enforces nothing — enforcement policy is a separate,
 * later decision, and the two-producers-one-name divergence this leaves behind
 * (`sdk-handshake`, marked in both protocol snapshots) is resolved by R3-274e.
 */

/** The sandbox↔host wire this frame speaks. Bump ONLY for an additive extension
 *  (SDK_PACKAGING_SPEC §9); the host must keep serving every prior version. */
export const SANDBOX_PROTOCOL_VERSION = '1.0.0';

/**
 * The app↔host request-surface protocol, as announced on the legacy
 * `sdk-handshake` field. FROZEN at the value the retired sibling-checkout read
 * produced — it has been `1.0.0` since the field existed, and the authoritative
 * announcement now comes from the app's own SDK, which knows its real version.
 * Do not "refresh" this from an SDK checkout: that is the coupling R3-274d removed.
 */
export const SDK_PROTOCOL_VERSION = '1.0.0';
