import { readFileSync } from 'fs';
import { join } from 'path';

import { CDN_ROOT, ESM_ORIGIN, SELF_HOST_BASES, UNPKG_ROOT } from '../bundler/moduleOrigins';
import { M3_CONNECT_SOURCES, M3_CSP_DIRECTIVES, M3_PERMISSIONS_POLICY, buildM3Csp } from './m3Csp';

const SRC = join(__dirname, '..');

const readMetaCsp = (html: string): string | null => {
  const meta = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i.exec(html);
  return meta ? meta[1] : null;
};

const directive = (csp: string, name: string): string[] => {
  const found = csp
    .split(';')
    .map((d) => d.trim())
    .find((d) => d === name || d.startsWith(`${name} `));
  if (!found) throw new Error(`no ${name} directive in policy`);
  return found.slice(name.length).trim().split(/\s+/).filter(Boolean);
};

describe('M3 per-frame CSP (UI_AS_APPS §G1a / R3-234)', () => {
  const policy = buildM3Csp();

  describe('the document carries the policy', () => {
    it('m3.html embeds exactly the generated policy (drift gate)', () => {
      // The policy has ONE source of truth. A hand-edit to either side — or a
      // changed module origin that only `m3Csp.ts` learns about — fails here
      // rather than silently breaking every M3 app in production.
      const html = readFileSync(join(SRC, 'm3.html'), 'utf8');
      expect(readMetaCsp(html)).toBe(policy);
    });

    it('index.html carries NO CSP — M0-M2 frames stay byte-identical', () => {
      // §G1a: containment is M3-only. A policy leaking onto the baseline
      // document would break trusted-author apps (product value 3).
      const html = readFileSync(join(SRC, 'index.html'), 'utf8');
      expect(readMetaCsp(html)).toBeNull();
      expect(html).not.toMatch(/Content-Security-Policy/i);
    });

    it('m3.html loads the SAME bundler entry point as index.html', () => {
      // The two documents must differ ONLY in the policy: an M3 app has to run
      // the same bundler, or "M3" quietly becomes a different product.
      const strip = (html: string) =>
        html.replace(/<!--[\s\S]*?-->/g, '').replace(/<meta[^>]*Content-Security-Policy[\s\S]*?\/>/i, '');
      const normalize = (html: string) => strip(html).replace(/\s+/g, ' ').trim();
      expect(normalize(readFileSync(join(SRC, 'm3.html'), 'utf8'))).toBe(
        normalize(readFileSync(join(SRC, 'index.html'), 'utf8'))
      );
    });
  });

  describe('the bulk-egress channels §G1a names are closed', () => {
    it('starts from default-src none', () => {
      expect(directive(policy, 'default-src')).toEqual(["'none'"]);
    });

    it.each([
      ['form-action', 'native form POST'],
      ['frame-src', 'nested-frame GET'],
      ['child-src', 'nested browsing contexts'],
      ['object-src', 'plugin content'],
      ['base-uri', 'base-tag retargeting'],
    ])('%s is none (%s)', (name) => {
      expect(directive(policy, name)).toEqual(["'none'"]);
    });

    it.each(['img-src', 'media-src', 'font-src'])('%s admits no external origin (pixel exfil)', (name) => {
      // Only the frame's own origin plus the blob:/data: URLs the bundler mints
      // for in-mount assets (the asset transformer emits base64 data: URLs).
      expect(directive(policy, name).sort()).toEqual(["'self'", 'blob:', 'data:']);
    });

    it('connect-src admits no attacker-choosable origin', () => {
      const external = directive(policy, 'connect-src').filter((s) => s.startsWith('http'));
      expect(external).not.toHaveLength(0);
      for (const source of external) {
        // Every entry is a fully-qualified https origin (never a scheme-only or
        // wildcard source, which would re-open arbitrary egress).
        expect(source).toMatch(/^https:\/\/[a-z0-9.-]+\//);
        expect(source).not.toContain('*');
      }
    });
  });

  describe('connect-src is exactly the origins the bundler itself fetches', () => {
    // The R3-234 finding: the app shares this document with the bundler, so
    // `connect-src 'none'` (as §G1a writes it) would break module loading
    // rather than contain egress. The deviation is bounded by this test — the
    // allowlist may hold the bundler's own origins and NOTHING else, read out
    // of the fetching modules rather than restated here.
    const sources = new Set(M3_CONNECT_SOURCES);

    const covers = (url: string): boolean => [...sources].some((s) => s.startsWith('http') && url.startsWith(s));

    it('covers dependency resolution (/dep_tree/, not parent-mediated)', () => {
      expect(covers(`${CDN_ROOT}dep_tree/abc`)).toBe(true);
    });

    it('covers the package-bundle direct-fetch fallback', () => {
      expect(covers(`${CDN_ROOT}package/abc`)).toBe(true);
    });

    it('covers the unpkg registry reads', () => {
      expect(covers(`${UNPKG_ROOT}react@19.1.0/index.js`)).toBe(true);
    });

    it('covers the esm.sh fallback', () => {
      expect(covers(`${ESM_ORIGIN}/lucide-react@1.21.0?target=es2022`)).toBe(true);
    });

    it('covers every self-hosted module base', () => {
      for (const base of Object.values(SELF_HOST_BASES)) {
        expect(covers(`${base}/v/0.16.0/index.js`)).toBe(true);
      }
    });

    it('does NOT cover an arbitrary origin', () => {
      expect(covers('https://attacker.example/?d=secret')).toBe(false);
      expect(covers('https://sandpack-cdn-staging.blazingly.io.attacker.example/x')).toBe(false);
    });

    it('scopes the module CDN by path, so only its two endpoints are reachable', () => {
      expect(covers(`${CDN_ROOT}?d=secret`)).toBe(false);
    });
  });

  describe('the prod hosting config reinforces the document policy', () => {
    // Defence in depth only: Hosting headers are prod-only, so the <meta> above
    // is the delivery (it is what makes this verifiable on local.immediately.run
    // at all). This block must not DRIFT from it, though — a header that
    // contradicts the meta would apply BOTH policies, i.e. their intersection,
    // and quietly break M3 apps in prod and nowhere else.
    const hosting = JSON.parse(readFileSync(join(SRC, '..', 'firebase.json'), 'utf8')).hosting[0];
    const m3Block = hosting.headers.find((h: { source: string }) => h.source === '/m3.html');
    const header = (key: string): string | undefined =>
      m3Block?.headers.find((h: { key: string }) => h.key === key)?.value;

    it('serves the identical CSP on /m3.html', () => {
      expect(header('Content-Security-Policy')).toBe(policy);
    });

    it('serves the Permissions-Policy the <meta> form cannot carry', () => {
      expect(header('Permissions-Policy')).toBe(M3_PERMISSIONS_POLICY);
    });

    it('sets no policy on any other path — M0-M2 keep index.html untouched', () => {
      const others = hosting.headers.filter((h: { source: string }) => h.source !== '/m3.html');
      for (const block of others) {
        for (const h of block.headers) {
          expect(h.key).not.toMatch(/^(Content-Security-Policy|Permissions-Policy)$/i);
        }
      }
    });

    it('keeps m3.html out of the SPA rewrite (it is a real emitted document)', () => {
      // Hosting serves a matching static file before consulting rewrites, and
      // parcel emits dist/m3.html as a second entry — but if that entry ever
      // stopped being emitted, the `**/!(*.js…)` rewrite would silently serve
      // index.html (NO CSP) in its place. Fail closed on the rewrite shape.
      expect(hosting.rewrites).toEqual([{ source: '**/!(*.@(js|js.map))', destination: '/index.html' }]);
    });
  });

  it('serializes one directive per entry, semicolon-separated', () => {
    expect(policy.split('; ')).toHaveLength(M3_CSP_DIRECTIVES.length);
    expect(policy).not.toContain(';;');
  });
});
