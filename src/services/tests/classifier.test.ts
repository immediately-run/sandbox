// R3-222 exit (c) — "an unsupported suite returns an explicit `unsupported`, NOT a
// false pass". This is the honesty test: the failure mode it guards is a green result
// the agent and the user read as "everything passed" when half the suite never ran.

import { bareSpecifier, classifySuite, coverageNote, importsOf } from './classifier';

describe('importsOf', () => {
  it('finds static, dynamic, require and re-export specifiers', () => {
    const src = `
      import fs from 'fs';
      import { a as b } from "./a";
      const x = await import('sharp');
      const y = require('node:path');
      export * from './c';
      export { d } from "vitest";
    `;
    expect(importsOf(src).sort()).toEqual(['./a', './c', 'fs', 'node:path', 'sharp', 'vitest'].sort());
  });

  it('reduces a specifier to its package, keeping the scope', () => {
    expect(bareSpecifier('fs/promises')).toBe('fs');
    expect(bareSpecifier('node:child_process')).toBe('child_process');
    expect(bareSpecifier('@immediately-run/sdk/fs')).toBe('@immediately-run/sdk');
    expect(bareSpecifier('./local')).toBeNull();
    expect(bareSpecifier('/abs')).toBeNull();
  });
});

describe('classifySuite — what the realm can honestly run', () => {
  it('supports a plain unit test over app modules', () => {
    const v = classifySuite(`
      import { add } from './math';
      describe('add', () => { it('adds', () => { expect(add(1,2)).toBe(3); }); });
    `);
    expect(v).toEqual({ supported: true });
  });

  it('supports a DOM test — the realm document is a real DOM', () => {
    expect(classifySuite(`it('renders', () => { document.createElement('div'); });`).supported).toBe(true);
  });

  it('refuses a Node-runtime suite, naming the import', () => {
    const v = classifySuite(`import { readFile } from 'node:fs/promises';`);
    expect(v.supported).toBe(false);
    expect(v.reason).toBe('node-runtime');
    expect(v.detail).toContain('"fs"');
    expect(v.detail).toContain('will not get');
  });

  it('refuses a native/postinstall dep, and says why it can never resolve', () => {
    const v = classifySuite(`import sharp from 'sharp';`);
    expect(v.reason).toBe('native-dep');
    expect(v.detail).toContain('add_dependency is declare-only');
  });

  it('refuses a network test, and says the denial is BY DESIGN', () => {
    const v = classifySuite(`it('fetches', async () => { await fetch('https://api.example.com'); });`);
    expect(v.reason).toBe('network');
    expect(v.detail).toContain("connect-src 'none'");
  });

  it('refuses on-disk snapshots but not inline ones', () => {
    expect(classifySuite(`it('x', () => expect(a).toMatchSnapshot())`).reason).toBe('snapshot-fs');
    expect(classifySuite(`it('x', () => expect(a).toMatchInlineSnapshot('1'))`).supported).toBe(true);
  });

  it('refuses a Node harness import, and points at the globals that DO exist', () => {
    const v = classifySuite(`import { describe, it, expect } from 'vitest';`);
    expect(v.reason).toBe('node-runtime');
    // "Unsupported" alone reads as "rewrite everything" — name the way through.
    expect(v.detail).toContain('describe/it/expect');
  });

  it('ranks the most structural impossibility first', () => {
    // Both a native dep and a Node builtin: the native dep is the one the author
    // cannot work around at all, so that is the reason they are given.
    expect(classifySuite(`import fs from 'fs'; import sharp from 'sharp';`).reason).toBe('native-dep');
  });

  it('does NOT refuse on suspicion — an unknown import runs and may fail honestly', () => {
    // Refusing anything unfamiliar would make the runner useless; a runtime failure is
    // at least visible, and this classifier only exists to prevent a FALSE PASS.
    expect(classifySuite(`import { x } from 'some-unknown-pkg';`).supported).toBe(true);
  });
});

describe('coverageNote — the honesty guarantee, made legible', () => {
  it('leads with NOTHING RAN when every suite was skipped', () => {
    const note = coverageNote([], [{ file: 'a.test.ts', detail: 'needs a Node runtime.' }]);
    expect(note.startsWith('NOTHING RAN.')).toBe(true);
    expect(note).toContain('NOT a passing result');
  });

  it('enumerates what ran and what did not, with reasons', () => {
    const note = coverageNote(['a.test.ts', 'b.test.ts'], [{ file: 'c.test.ts', detail: 'calls the network.' }]);
    expect(note).toContain('Ran 2 suite(s)');
    expect(note).toContain('1 suite(s) could not run here');
    expect(note).toContain('c.test.ts — calls the network.');
  });

  it("always warns that this is not the app's Node harness", () => {
    expect(coverageNote(['a.test.ts'], [])).toContain('not your Node test harness');
  });
});
