import { parseFrontmatter } from './frontmatter';

describe('parseFrontmatter', () => {
  it('returns empty data and the original content when there is no frontmatter', () => {
    const { data, content } = parseFrontmatter('# Hello\n\nbody');
    expect(data).toEqual({});
    expect(content).toBe('# Hello\n\nbody');
  });

  it('parses a simple key/value block and strips it from content', () => {
    const { data, content } = parseFrontmatter('---\ntitle: Hi\n---\n# Body');
    expect(data).toEqual({ title: 'Hi' });
    expect(content).toBe('# Body');
  });

  it('reads COMPLEX yaml: nested maps, block + flow sequences, block scalars, quoted colons', () => {
    const code = [
      '---',
      'title: Complex Doc',
      'tags: [alpha, beta]',
      'meta:',
      '  author:',
      '    name: Ada',
      '    roles: [admin, editor]',
      '  published: true',
      '  rating: 4.5',
      'description: |',
      '  line one',
      '  line two',
      'quoted: "colon: inside"',
      'nested:',
      '  - id: 1',
      '    label: one',
      '  - id: 2',
      '    label: two',
      '---',
      '# Body',
    ].join('\n');

    const { data } = parseFrontmatter(code);
    expect(data).toEqual({
      title: 'Complex Doc',
      tags: ['alpha', 'beta'],
      meta: {
        author: { name: 'Ada', roles: ['admin', 'editor'] },
        published: true,
        rating: 4.5,
      },
      description: 'line one\nline two\n',
      quoted: 'colon: inside',
      nested: [
        { id: 1, label: 'one' },
        { id: 2, label: 'two' },
      ],
    });
  });

  it('uses YAML 1.2 semantics — no "Norway problem" (`no` stays a string, not false)', () => {
    const { data } = parseFrontmatter('---\ncountry: no\nenabled: yes\nflag: true\n---\nx');
    expect(data.country).toBe('no');
    expect(data.enabled).toBe('yes');
    expect(data.flag).toBe(true); // real booleans still parse
  });

  it('lifts a <More /> excerpt onto data and strips it (with following whitespace) from content', () => {
    const code = '---\ntitle: T\n---\nIntro paragraph.\n<More />\n\nRest of the body.';
    const { data, content } = parseFrontmatter(code);
    expect(data.title).toBe('T');
    expect(data.excerpt).toBe('Intro paragraph.\n');
    expect(content).toBe('Rest of the body.');
  });

  it('supports an excerpt with no frontmatter', () => {
    const { data, content } = parseFrontmatter('Teaser.\n<More />\nBody');
    expect(data.excerpt).toBe('Teaser.\n');
    expect(content).toBe('Body');
  });

  it('does not set an excerpt when the marker is at offset 0 (empty prefix)', () => {
    const { data, content } = parseFrontmatter('<More />\nBody');
    expect(data.excerpt).toBeUndefined();
    expect(content).toBe('<More />\nBody');
  });

  it('treats empty frontmatter as no data', () => {
    const { data, content } = parseFrontmatter('---\n---\nbody');
    expect(data).toEqual({});
    expect(content).toBe('body');
  });

  it('ignores a non-map document (scalar/array) — data stays a record', () => {
    expect(parseFrontmatter('---\n42\n---\nx').data).toEqual({});
    expect(parseFrontmatter('---\n- a\n- b\n---\nx').data).toEqual({});
  });

  it('tolerates CRLF line endings and a leading BOM', () => {
    const { data, content } = parseFrontmatter('﻿---\r\ntitle: T\r\n---\r\n# Body');
    expect(data).toEqual({ title: 'T' });
    expect(content).toBe('# Body');
  });

  it('throws on malformed YAML (parity with the previous parser; callers guard)', () => {
    expect(() => parseFrontmatter('---\na: [1, 2\nb: : :\n---\nx')).toThrow();
  });
});
