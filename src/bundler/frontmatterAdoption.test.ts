import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { metadataKeyFor } from '@immediately-run/platform-constants';
import { parseFrontmatter } from '@immediately-run/transpiler';

import { extractMetadata } from './bundler';
import { createBundlerHarness, type BundlerHarness } from './testHarness/bundlerHarness';

// R3-1349 — transpiler 0.10.0 parses frontmatter through mdx-plugins' YAML canon
// (R3-1347/R3-1348). The input is grove's real layout starter, copied verbatim at two
// grove commits into /test-fixtures/grove-hero (frozen producer data):
//  - 33391ef: the unquoted `description:` holds `nav: top` and `cover: lands` mid-line,
//    a YAML error. The live scan must write NO row, and its warning must name the file
//    and carry the parser's message.
//  - e017647: the same file, quoted. The row carries `layoutRole: root`, `nav: top`.
// The CLI's cache-zip sidecar is held to the same two outcomes over the same bytes
// (immediately-run-cli test/artifacts.test.mjs).
const fixture = (name: string): string =>
  readFileSync(join(__dirname, '..', '..', 'test-fixtures', 'grove-hero', name), 'utf-8');
const UNQUOTED = fixture('hero-33391ef.mdx');
const QUOTED = fixture('hero-e017647.mdx');

/** The parser's own message for the unquoted starter: what the warning must carry. */
function yamlMessage(): string {
  try {
    parseFrontmatter(UNQUOTED);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('the shared parser accepted the unquoted starter');
}

describe('frontmatter through transpiler 0.10.0 (R3-1349)', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  it('extractMetadata: an unparseable block writes no row and warns with the file and the YAML error', () => {
    expect(yamlMessage()).toMatch(/^frontmatter \(line 4, column \d+\): /);
    expect(extractMetadata({ path: '/app/content/_layouts/hero.mdx', code: UNQUOTED })).toBeNull();
    const [text, err] = warn.mock.calls.find((c) => String(c[0]).includes('hero.mdx')) ?? [];
    expect(text).toContain('/app/content/_layouts/hero.mdx');
    expect((err as Error).message).toBe(yamlMessage());
  });

  it('extractMetadata: the quoted starter parses to its layout role and nav', () => {
    expect(extractMetadata({ path: '/app/content/_layouts/hero.mdx', code: QUOTED })?.data).toMatchObject({
      layoutRole: 'root',
      nav: 'top',
    });
    expect(warn).not.toHaveBeenCalled();
  });

  // The canon also rejects blocks that ARE valid YAML (review 1-A-0): a value JSON cannot
  // carry and a block that is not a map. Under 0.9.1 these wrote a row (`weight: Infinity`,
  // a Set, or an `{ excerpt }`-only row for a list block with `<More />`); under 0.10.0
  // they write none and warn, like the YAML error above. Declared in sandbox#145.
  it.each([
    ['a non-finite number', '---\ntitle: A\nweight: .inf\n---\nbody\n', /`weight` is Infinity/],
    ['an explicit YAML tag', '---\ntitle: A\ns: !!set {a, b}\n---\nbody\n', /`s` is a Set/],
    [
      'a list block with an excerpt',
      '---\n- a\n- b\n---\nintro\n<More />\nrest\n',
      /must be a map of keys, not a list/,
    ],
  ])('extractMetadata: %s writes no row and warns with the file and the reason', (_name, code, reason) => {
    expect(extractMetadata({ path: '/app/content/odd.mdx', code })).toBeNull();
    const [text, err] = warn.mock.calls.find((c) => String(c[0]).includes('odd.mdx')) ?? [];
    expect(text).toContain('/app/content/odd.mdx');
    expect((err as Error).message).toMatch(reason);
  });

  describe('through the Bundler scan', () => {
    let h: BundlerHarness;
    afterEach(async () => {
      if (h) await h.teardown();
    });

    it('stores the quoted row and none for the unquoted one', async () => {
      h = await createBundlerHarness({
        'package.json': JSON.stringify({ name: 'hero-fixture', main: 'src/index.ts' }),
        'index.html': '<!doctype html><div id="root"></div>',
        'src/index.ts': 'export default 1;\n',
        'content/_layouts/hero.mdx': UNQUOTED,
        'content/_layouts/hero-quoted.mdx': QUOTED,
      });
      await h.bundler.preloadMDXMetadata();
      const lastMetadata = (h.bundler as unknown as { lastMetadata: Map<string, Record<string, unknown>> })
        .lastMetadata;
      expect(lastMetadata.has(metadataKeyFor('content/_layouts/hero.mdx'))).toBe(false);
      expect(lastMetadata.get(metadataKeyFor('content/_layouts/hero-quoted.mdx'))).toMatchObject({
        layoutRole: 'root',
        nav: 'top',
      });
      expect(warn.mock.calls.some((c) => String(c[0]).includes('content/_layouts/hero.mdx'))).toBe(true);
    });
  });
});
