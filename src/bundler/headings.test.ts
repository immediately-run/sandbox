// The bundler-side headings collector (GROVE_AGENT_SPEC §4): its ids come from the
// SAME mdx-plugins canon the render path emits, with the remark pass's duplicate
// counter — asserted directly against `SLUG_PARITY_FIXTURE`, the fixture the canon
// ships for exactly this parity claim. This mirrors the SDK's
// `collectHeadings.test.ts`; the two repos pin the same canon by importing the same
// `headingId`, and the same fixture set keeps the WALKS honest on both sides.
import { collectHeadings, withHeadings } from './headings';
import { headingId, SLUG_PARITY_FIXTURE } from '@immediately-run/mdx-plugins';

const BODY = `# Intro

Prose.

## The **bold** heading

## Getting started

## Getting started

### A \`code\` heading

## 8. Capability model

~~~
## not a heading (tilde fence)
~~~

\`\`\`js
// ## not a heading either (backtick fence)
\`\`\`
`;

describe('collectHeadings — G-GA-7 (bundler side)', () => {
  it('every canon fixture text produces the canon id', () => {
    for (const c of SLUG_PARITY_FIXTURE) {
      const heads = collectHeadings(`## ${c.text}\n`);
      expect(heads[0].id).toBe(c.id);
      expect(heads[0].text).toBe(c.text.trim());
    }
  });

  it('depths, duplicate counters, fences, inline flattening', () => {
    expect(collectHeadings(BODY)).toEqual([
      { id: 'intro', text: 'Intro', depth: 1 },
      { id: 'the-bold-heading', text: 'The bold heading', depth: 2 },
      { id: 'getting-started', text: 'Getting started', depth: 2 },
      { id: 'getting-started-1', text: 'Getting started', depth: 2 },
      { id: 'a-code-heading', text: 'A code heading', depth: 3 },
      { id: 'sec-8', text: '8. Capability model', depth: 2 },
    ]);
  });

  it('matches headingId per extracted text (the canon, called directly)', () => {
    for (const h of collectHeadings(BODY)) {
      expect(h.id.startsWith(headingId(h.text))).toBe(true);
    }
  });

  it('a punctuation-only heading takes the canon "section" fallback (composed slugs would get this wrong)', () => {
    expect(collectHeadings('## ?!?\n')[0].id).toBe('section');
  });
});

describe('withHeadings — the additive row extension', () => {
  it('attaches computed headings under the reserved-by-convention key', () => {
    const row = withHeadings({ title: 'A' }, '## One\n\n## Two\n');
    expect(row).toEqual({
      title: 'A',
      headings: [
        { id: 'one', text: 'One', depth: 2 },
        { id: 'two', text: 'Two', depth: 2 },
      ],
    });
  });

  it('the author own `headings` frontmatter key wins (their row, their data)', () => {
    const authored = { title: 'A', headings: 'an author string, oddly' };
    expect(withHeadings(authored, '## One\n')).toBe(authored);
  });

  it('a heading-less body leaves the row untouched (no empty array noise)', () => {
    expect(withHeadings({ title: 'A' }, 'Just prose.\n')).toEqual({ title: 'A' });
  });
});
