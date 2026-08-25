// R3-222 Phase 1 — the realm policy is the one we meant to write, and the document
// carries exactly it.
//
// This is the `m3Csp.test.ts` discipline applied to the test realm: a policy that
// quietly stops matching the code is WORSE than no policy, because it still reads like
// containment. What it cannot prove is that the browser enforces it — that is the live
// drill (`scripts/test-realm-drill.mjs`), and it is deliberately a separate artifact.

import { readFileSync } from 'fs';
import { join } from 'path';

import { TEST_REALM_CSP_DIRECTIVES, TEST_REALM_SANDBOX_ATTR, buildTestRealmCsp } from './testRealmCsp';

const csp = buildTestRealmCsp();
const directive = (name: string): string[] => (TEST_REALM_CSP_DIRECTIVES.find(([n]) => n === name)?.[1] ?? []).slice();

describe('the test-realm policy', () => {
  it('denies the network outright — the claim the whole realm rests on', () => {
    // Unlike M3, this document never bundles anything: it is seeded with modules the
    // kernel already transpiled. So `connect-src` can be, and is, a literal 'none'.
    expect(directive('connect-src')).toEqual(["'none'"]);
    expect(csp).toContain("connect-src 'none'");
  });

  it('closes every other egress channel a browser hands code for free', () => {
    // Each is stated explicitly rather than left to `default-src`, so the intent
    // survives someone adding a directive above.
    for (const name of ['img-src', 'media-src', 'font-src', 'frame-src', 'object-src', 'form-action', 'base-uri']) {
      expect(directive(name)).toEqual(["'none'"]);
    }
    expect(directive('default-src')).toEqual(["'none'"]);
  });

  it('allows NO data: script URL — the shortest path to smuggling un-seeded code', () => {
    expect(directive('script-src')).not.toContain('data:');
    expect(directive('script-src')).toContain('blob:');
  });

  it('permits an inner worker, so a runaway test spins a thread that can be terminated', () => {
    // MEASURED (the Phase-0 drill): an opaque-origin iframe alone does NOT bound a
    // runaway — a `for(;;)` in the frame wedges the parent, so the inner Worker is
    // required rather than an optimisation.
    expect(directive('worker-src')).toEqual(["'self'", 'blob:']);
    expect(directive('child-src')).toEqual(["'self'", 'blob:']);
  });

  it("allows 'self' scripts — without it the realm cannot load its own entry", () => {
    // Found by running the drill, not by reading the spec: an opaque-origin document
    // still resolves `'self'` against its own URL in Chrome (the posture `m3.html` has
    // run in production since R3-234), and without it the bundled entry is blocked and
    // the realm answers nothing at all.
    expect(directive('script-src')).toContain("'self'");
  });

  it('is an EGRESS control, not a code-execution control — and says so by allowing eval', () => {
    // The code-execution containment is the opaque origin and the absence of any
    // handle. Pretending the CSP does that job would be the dangerous confusion.
    expect(directive('script-src')).toContain("'unsafe-eval'");
  });
});

describe('the realm document carries exactly this policy', () => {
  const html = readFileSync(join(__dirname, '..', 'test-realm.html'), 'utf8');

  it('embeds the generated string verbatim', () => {
    expect(html).toContain(`content="${csp}"`);
  });

  it('loads the realm entry and NOTHING else — no bundler, no import map, no CDN', () => {
    expect(html).toContain('./services/tests/realm-main.ts');
    expect(html).not.toContain('importmap');
    expect(html).not.toMatch(/https?:\/\/[a-z]/i);
  });
});

describe('the sandbox attribute the host must set', () => {
  it('is allow-scripts and nothing else', () => {
    expect(TEST_REALM_SANDBOX_ATTR).toBe('allow-scripts');
  });

  it('never grants same-origin — that absence IS the opaque origin', () => {
    // With `allow-same-origin` the realm would share the sandbox origin's storage and
    // could read the host through `window.parent`. Every other guarantee here assumes
    // this one flag stays off.
    expect(TEST_REALM_SANDBOX_ATTR).not.toContain('allow-same-origin');
    for (const flag of ['allow-forms', 'allow-popups', 'allow-top-navigation', 'allow-modals']) {
      expect(TEST_REALM_SANDBOX_ATTR).not.toContain(flag);
    }
  });
});
