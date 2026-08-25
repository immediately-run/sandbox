// Typecheck against the BUNDLED host — the one production actually uses (R3-329).
//
// The pre-existing typecheck.test.ts drives the DEFAULT on-disk host, which resolves
// the repo's real node_modules. That is why the missing `@types` set went unnoticed
// for a release: under jest `import 'react'` resolved, and in the Worker it never
// could. Every assertion here goes through `createBundledLibHost`, so a regression in
// the bundled set fails here rather than in a browser.
import ts from 'typescript';
import { createBundledLibHost } from './worker-lib-host';
import { BUNDLED_TYPE_SPECIFIERS } from './bundled-types.generated';
import { Diag, runTypecheck } from './typecheck';
import { ServiceInputError } from './format';

const check = (files: { path: string; content: string }[]): Diag[] =>
  runTypecheck({ files }, { createBaseHost: createBundledLibHost }).diagnostics;

const errors = (d: Diag[]): Diag[] => d.filter((x) => x.category === 'error');

describe('bundled typecheck: React', () => {
  // The exact reproduction from R3-329: this returned 2307 + 2875 + 7026.
  it('type-checks a plain React component with no diagnostics at all', () => {
    expect(
      check([
        {
          path: '/App.tsx',
          content: "import React from 'react';\nexport default function App() { return <div />; }\n",
        },
      ]),
    ).toEqual([]);
  });

  it('resolves the automatic JSX runtime without a React import', () => {
    expect(check([{ path: '/A.tsx', content: 'export default () => <span>hi</span>;\n' }])).toEqual([]);
  });

  it('checks intrinsic element props', () => {
    const d = errors(check([{ path: '/A.tsx', content: 'export default () => <div className={42} />;\n' }]));
    expect(d).toHaveLength(1);
    expect(d[0].messageText).toMatch(/not assignable to type 'string'/);
  });

  it('checks the style prop against csstype', () => {
    const d = errors(check([{ path: '/A.tsx', content: "export default () => <div style={{ colour: 'red' }} />;\n" }]));
    expect(d.length).toBeGreaterThanOrEqual(1);
  });

  it('checks hook generics', () => {
    const d = errors(
      check([
        {
          path: '/A.tsx',
          content:
            "import { useState } from 'react';\n" +
            'export default function A() { const [n, setN] = useState<number>(0); setN("x"); return <b>{n}</b>; }\n',
        },
      ]),
    );
    expect(d).toHaveLength(1);
    expect(d[0].messageText).toMatch(/'string' is not assignable/);
  });

  it('resolves react-dom subpaths', () => {
    expect(
      check([
        {
          path: '/main.ts',
          content: "import { createRoot } from 'react-dom/client';\nexport const r = createRoot(document.body);\n",
        },
      ]),
    ).toEqual([]);
  });
});

describe('bundled typecheck: the immediately.run SDK', () => {
  it('advertises the SDK in the bundled specifier set', () => {
    expect(BUNDLED_TYPE_SPECIFIERS).toContain('@immediately-run/sdk');
    expect(BUNDLED_TYPE_SPECIFIERS).toContain('react');
  });

  // Exit criterion (2): the SDK types must be IN the program, not merely in the
  // bundle — a misuse has to be caught, or "bundled" means nothing.
  it('catches a name that the SDK does not export', () => {
    const d = errors(
      check([
        {
          path: '/a.ts',
          content:
            "import { definitelyNotAnExport } from '@immediately-run/sdk';\nexport const x = definitelyNotAnExport;\n",
        },
      ]),
    );
    expect(d.length).toBeGreaterThanOrEqual(1);
    expect(d[0].messageText).toMatch(/has no exported member/);
  });

  it('resolves a real SDK export and its subpath entry', () => {
    expect(
      check([
        {
          path: '/a.ts',
          content: "import { getCatalog } from '@immediately-run/sdk';\nexport const c = getCatalog;\n",
        },
      ]),
    ).toEqual([]);
  });
});

describe('bundled typecheck: unresolved imports are a coverage note, not an error', () => {
  it('reports an unbundled package at message severity, naming it', () => {
    const d = check([{ path: '/a.ts', content: "import { z } from 'zod';\nexport const s = z;\n" }]);
    expect(errors(d)).toEqual([]);
    expect(d).toHaveLength(1);
    expect(d[0].category).toBe('message');
    expect(d[0].messageText).toMatch(/No bundled type declarations for 'zod'/);
    expect(d[0].messageText).toMatch(/not an error/);
  });

  it('reports a sibling file left out of the request at message severity', () => {
    const d = check([{ path: '/a.ts', content: "import { helper } from './helper';\nexport const h = helper;\n" }]);
    expect(errors(d)).toEqual([]);
    expect(d).toHaveLength(1);
    expect(d[0].category).toBe('message');
    expect(d[0].messageText).toMatch(/'\.\/helper' was not included in this typecheck request/);
  });

  it('checks a sibling normally when it IS included', () => {
    expect(
      check([
        { path: '/a.ts', content: "import { helper } from './helper';\nexport const h: number = helper();\n" },
        { path: '/helper.ts', content: 'export const helper = (): string => "s";\n' },
      ]).filter((x) => x.category === 'error'),
    ).toHaveLength(1);
  });

  it('still reports a genuine type error in a file that also has an unbundled import', () => {
    const d = check([
      { path: '/a.ts', content: "import 'zod';\nconst n: number = 'not a number';\nexport default n;\n" },
    ]);
    expect(errors(d)).toHaveLength(1);
    expect(errors(d)[0].messageText).toMatch(/not assignable/);
  });
});

describe('bundled typecheck: CS-1 input trust', () => {
  // The type set is kernel-owned. A caller must not be able to name, add, shadow or
  // redirect it — the whole reason it is a build-time table and not a resolver.
  it('ignores caller-supplied types/typeRoots/paths fields', () => {
    const d = runTypecheck(
      {
        files: [{ path: '/a.ts', content: "import { z } from 'zod';\nexport const s = z;\n" }],
        ...({
          types: ['zod'],
          typeRoots: ['/evil'],
          paths: { zod: ['/evil/zod.d.ts'] },
          compilerOptions: { strict: false },
        } as object),
      } as Parameters<typeof runTypecheck>[0],
      { createBaseHost: createBundledLibHost },
    ).diagnostics;
    // still unresolved — the caller's `paths`/`typeRoots` bought nothing
    expect(d.some((x) => /No bundled type declarations for 'zod'/.test(x.messageText))).toBe(true);
  });

  // Mounting the type set at VFS paths created a new way for a caller to reach a
  // kernel-owned input: `inMemoryHost` layers caller files OVER the base host, so a
  // file at a bundled path would redefine what `react` means for that request.
  it('refuses a caller file under node_modules rather than letting it shadow the type set', () => {
    expect(() =>
      runTypecheck(
        {
          files: [
            {
              path: '/node_modules/@types/react/index.d.ts',
              content: 'export declare const useState: (x: string) => void;\n',
            },
            { path: '/a.ts', content: "import { useState } from 'react';\nexport const s = useState<number>(0);\n" },
          ],
        },
        { createBaseHost: createBundledLibHost },
      ),
    ).toThrow(ServiceInputError);
    expect(() => runTypecheck({ files: [{ path: 'node_modules/x.d.ts', content: '' }] })).toThrow(
      /reserved for the kernel type set/,
    );
  });

  it('still resolves the real declarations after that refusal', () => {
    expect(
      check([{ path: '/a.ts', content: "import { useState } from 'react';\nexport const s = useState<number>(0);\n" }]),
    ).toEqual([]);
  });

  it('serves no bundled declaration outside the kernel set', () => {
    const host = createBundledLibHost({} as ts.CompilerOptions);
    expect(host.fileExists('/node_modules/zod/index.d.ts')).toBe(false);
    expect(host.fileExists('/etc/passwd')).toBe(false);
    expect(host.readFile('/node_modules/@types/react/../../../etc/passwd')).toBeUndefined();
  });
});
