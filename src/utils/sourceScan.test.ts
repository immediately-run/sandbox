import {
  identifierEnd,
  isIdentPart,
  isIdentStart,
  nextSignificantIndex,
  skipCommentFrom,
  skipStringFrom,
} from './sourceScan';

// The two production consumers (`extractSideEffectImports`, `scanCjsModule`) drive
// these through whole files; the cases below pin the edges those files only reach
// occasionally — an escape before the closing quote, an unterminated literal, a
// comment sitting between a keyword and its argument.

describe('isIdentStart / isIdentPart', () => {
  it('accepts the JS identifier-start set (letters, _ and $) and rejects digits', () => {
    for (const c of ['a', 'z', 'A', 'Z', '_', '$']) expect(isIdentStart(c)).toBe(true);
    for (const c of ['0', '9', '.', '-', ' ', '/']) expect(isIdentStart(c)).toBe(false);
  });

  it('accepts digits as identifier CONTINUATIONS but not as starts', () => {
    for (const c of ['0', '5', '9']) {
      expect(isIdentPart(c)).toBe(true);
      expect(isIdentStart(c)).toBe(false);
    }
    expect(isIdentPart('-')).toBe(false);
  });
});

describe('identifierEnd', () => {
  it('stops at the first non-identifier character', () => {
    const src = 'require("dep")';
    expect(identifierEnd(src, 0)).toBe('require'.length);
    expect(src.slice(0, identifierEnd(src, 0))).toBe('require');
  });

  it('includes digits and $/_ inside the word', () => {
    const src = '$a_1b = 2';
    expect(src.slice(0, identifierEnd(src, 0))).toBe('$a_1b');
  });

  it('returns the source length for a word that runs to the end', () => {
    expect(identifierEnd('export', 0)).toBe(6);
  });
});

describe('skipStringFrom', () => {
  it('returns the index just past the closing quote', () => {
    const src = `import './a.css';`;
    const start = src.indexOf("'");
    const end = skipStringFrom(src, start, "'");
    expect(src.slice(start + 1, end - 1)).toBe('./a.css');
    expect(src[end]).toBe(';');
  });

  it('does not end on an ESCAPED quote', () => {
    const src = `'a\\'b' rest`;
    const end = skipStringFrom(src, 0, "'");
    expect(src.slice(0, end)).toBe(`'a\\'b'`);
  });

  it('treats a backslash as consuming the next character, so \\\\ does not escape the quote', () => {
    const src = `'a\\\\' rest`;
    const end = skipStringFrom(src, 0, "'");
    expect(src.slice(0, end)).toBe(`'a\\\\'`);
  });

  it('consumes the rest of the source when the literal is unterminated', () => {
    const src = `'never closed`;
    expect(skipStringFrom(src, 0, "'")).toBe(src.length);
  });

  it('skips a template literal whole, without descending into ${...}', () => {
    const src = '`a ${ "x" } b` after';
    const end = skipStringFrom(src, 0, '`');
    expect(src.slice(0, end)).toBe('`a ${ "x" } b`');
  });
});

describe('skipCommentFrom', () => {
  it('returns -1 when no comment opens at the index', () => {
    expect(skipCommentFrom('a / b', 2)).toBe(-1);
    expect(skipCommentFrom('const a = 1;', 0)).toBe(-1);
  });

  it('ends a line comment ON its newline, leaving the newline unconsumed', () => {
    const src = '// note\nimport';
    const end = skipCommentFrom(src, 0);
    expect(src[end]).toBe('\n');
  });

  it('ends a line comment at the source end when there is no newline', () => {
    const src = '// last line';
    expect(skipCommentFrom(src, 0)).toBe(src.length);
  });

  it('returns the index just past a block comment', () => {
    const src = '/* a */x';
    expect(src[skipCommentFrom(src, 0)]).toBe('x');
  });

  it('does not end a block comment on a lone * or /', () => {
    const src = '/* a * b / c */x';
    expect(src[skipCommentFrom(src, 0)]).toBe('x');
  });

  it('consumes past the source end for an unterminated block comment', () => {
    const src = '/* never closed';
    expect(skipCommentFrom(src, 0)).toBeGreaterThanOrEqual(src.length);
  });
});

describe('nextSignificantIndex', () => {
  it('is the identity on a character that is already significant', () => {
    expect(nextSignificantIndex('x', 0)).toBe(0);
  });

  it('skips whitespace of every flavour', () => {
    const src = 'import \t\r\n"./a.css"';
    const k = nextSignificantIndex(src, 'import'.length);
    expect(src[k]).toBe('"');
  });

  it('skips comments between a keyword and its argument', () => {
    const src = "import /* why */ // and why not\n './a.css'";
    const k = nextSignificantIndex(src, 'import'.length);
    expect(src[k]).toBe("'");
  });

  it('returns the source length when only whitespace and comments remain', () => {
    const src = 'import  // trailing';
    expect(nextSignificantIndex(src, 'import'.length)).toBe(src.length);
  });

  it('does not skip a division slash', () => {
    const src = 'a / b';
    expect(nextSignificantIndex(src, 1)).toBe(2);
  });
});
