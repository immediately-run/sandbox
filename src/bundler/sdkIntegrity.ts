/*
 * SDK artifact integrity verification (SDK_PACKAGING_SPEC §5.2 / SPEC_REVIEW
 * SP-2, T1).
 *
 * The SDK is fetched from a self-hosted gh-pages origin. "Pinned versions are
 * immutable" must be an ENFORCED property, not an assumption about that origin:
 * the host (site-main, the TCB) pins a per-version SHA-384 of every SDK file and
 * delivers it to the sandbox on the register-frame handshake (IInitConfig). The
 * bundler verifies fetched bytes against the pin BEFORE evaluation; a mismatch
 * fails the boot closed.
 *
 * The pin must come from the HOST — fetching the origin's own integrity.json and
 * checking against it is self-attesting (a compromised origin serves a matching
 * manifest). So when no host pin is present, verification is skipped (and the
 * guarantee is inactive) rather than giving false assurance.
 */

/** Per-version, per-file expected hashes for one module: `{ rel: 'sha384-<b64>' }`. */
export type FileHashes = Record<string, string>;
/** Host-pinned SDK integrity, keyed by module then concrete version. */
export type SdkIntegrity = Record<string, Record<string, FileHashes>>;

/** SHA-384 of a UTF-8 string, formatted `sha384-<base64>` (SRI style). */
export const sha384 = async (content: string): Promise<string> => {
  const bytes = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest('SHA-384', bytes);
  // base64 of the raw digest bytes.
  let bin = '';
  const view = new Uint8Array(digest);
  for (let i = 0; i < view.length; i++) bin += String.fromCharCode(view[i]);
  return `sha384-${btoa(bin)}`;
};

export interface IntegrityVerifyResult {
  ok: boolean;
  /** Files whose computed hash != the pinned hash. */
  mismatches: string[];
  /** Pinned files the fetched set did not include (a truncated/forged artifact). */
  missing: string[];
}

/**
 * Verify fetched SDK files against the host-pinned hashes for that version.
 * EVERY pinned file must be present and match (no silent omission), and no
 * fetched file may differ. Pure but for the injected hasher.
 */
export const verifyVendoredFiles = async (
  files: ReadonlyArray<{ rel: string; content: string }>,
  expected: FileHashes,
  hash: (content: string) => Promise<string> = sha384,
): Promise<IntegrityVerifyResult> => {
  const byRel = new Map(files.map((f) => [f.rel, f.content]));
  const mismatches: string[] = [];
  const missing: string[] = [];
  for (const [rel, want] of Object.entries(expected)) {
    const content = byRel.get(rel);
    if (content === undefined) {
      missing.push(rel);
      continue;
    }
    const got = await hash(content);
    if (got !== want) mismatches.push(rel);
  }
  return { ok: mismatches.length === 0 && missing.length === 0, mismatches, missing };
};

/** The pinned hashes for a resolved module@version, or undefined if the host
 *  delivered no pin (verification then skipped — see module note). */
export const pinnedHashesFor = (
  integrity: SdkIntegrity | undefined,
  moduleName: string,
  version: string,
): FileHashes | undefined => integrity?.[moduleName]?.[version];

/** What the bundler should do with a resolved self-hosted module version:
 *  - `verify`: the host pinned this version — check fetched bytes against `hashes`.
 *  - `fail-closed`: the host wired integrity but did NOT pin THIS version (§5.2:
 *    a missing manifest entry fails closed, like a mismatch).
 *  - `skip`: no host pin at all — verification is inactive (the guarantee is off;
 *    see the module note). */
export type IntegrityDecision =
  | { action: 'verify'; hashes: FileHashes }
  | { action: 'fail-closed' }
  | { action: 'skip' };

/**
 * Decide how to treat a resolved `moduleName@version` against the host pin.
 * Pure, so the fail-closed-on-missing-version policy (§5.2) is unit-testable
 * without spinning up the bundler's fetch/fs.
 */
export const decideIntegrity = (
  integrity: SdkIntegrity | undefined,
  moduleName: string,
  version: string,
): IntegrityDecision => {
  const hashes = pinnedHashesFor(integrity, moduleName, version);
  if (hashes) return { action: 'verify', hashes };
  // Host wired a manifest but it lacks this version → fail closed (do not let an
  // unpinned version slip through unverified). No manifest at all → skip.
  return integrity ? { action: 'fail-closed' } : { action: 'skip' };
};
