/**
 * The one spelling of an SRI-format SHA-384 digest (`sha384-<base64>`).
 *
 * Two independent integrity paths compare against strings produced here: the
 * host-pinned SDK hashes (`bundler/sdkIntegrity.ts`, SDK_PACKAGING_SPEC §5.2)
 * and the immutable-URL cache's verify-on-read / verify-before-cache
 * (`utils/fetch.ts`). Both compare with `===` against a pin the HOST computed,
 * so the two must agree on the format exactly — a second copy that drifts (a
 * different digest encoding, a missing prefix) turns every pin into a silent
 * mismatch, which fails closed and looks like a compromised origin.
 */
export const sha384Bytes = async (bytes: BufferSource): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-384', bytes);
  // base64 of the raw digest bytes.
  let bin = '';
  const view = new Uint8Array(digest);
  for (let i = 0; i < view.length; i++) bin += String.fromCharCode(view[i]);
  return `sha384-${btoa(bin)}`;
};
