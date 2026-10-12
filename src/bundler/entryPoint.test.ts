import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BundlerError } from '../errors/BundlerError';
import { underAppRoot } from '../fsLayout';
import { BOOT_DISPATCH_CANDIDATES, classifyDeclaredEntry } from './entryPoint';
import { createBundlerHarness, type BundlerHarness } from './testHarness/bundlerHarness';

// The real producer, vendored byte-for-byte: the standing drill's self bundle
// manifest as `r3-775-drill@dae3d4e` `src/App.tsx` writes it (its BUNDLE_PKG is
// `JSON.stringify(pkg, null, 2) + '\n'`, fetched 2026-10-12) — the manifest whose
// `main: src/App.tsx` used to blank the self-run stage. The file is the producer's
// recorded output, not a hand-typed literal; it lives under /test-fixtures (frozen
// producer data, outside the src logic paths) and this suite must not re-type it.
const DRILL_BUNDLE_PKG = readFileSync(
  join(__dirname, '..', '..', 'test-fixtures', 'r3-775-drill.bundle-package.json'),
  'utf-8',
);

const APP_TSX = 'export default function App() {\n  return <h1>SELF-RUN-OK v1</h1>;\n}\n';
const BOOT_INDEX = "import { boot } from '@immediately-run/sdk/boot';\nboot();";

describe('classifyDeclaredEntry (BOOT_SCAFFOLDING_SPEC §4.1)', () => {
  it('dispatches every boot-dispatched candidate path', () => {
    for (const candidate of BOOT_DISPATCH_CANDIDATES) {
      expect(classifyDeclaredEntry(underAppRoot(candidate), APP_TSX)).toBe('dispatch');
    }
  });

  it('keeps a module that calls a render API as the entry', () => {
    const vite =
      "import { createRoot } from 'react-dom/client';\n" +
      "createRoot(document.getElementById('root')!).render(<App />);\n";
    expect(classifyDeclaredEntry('/app/src/main.tsx', vite)).toBe('entry');
    expect(classifyDeclaredEntry('/app/index.tsx', BOOT_INDEX)).toBe('entry');
    expect(classifyDeclaredEntry('/app/src/legacy.tsx', 'hydrateRoot(el, <App />);')).toBe('entry');
    expect(classifyDeclaredEntry('/app/src/legacy.tsx', 'const el = hydrateRoot /* pinned */ (container);')).toBe(
      'entry',
    );
  });

  it('does not count a leftover createRoot import binding as a render call', () => {
    // The binding without a call site is the exact leftover a refactor leaves
    // behind — the file still renders nothing as an entry.
    expect(
      classifyDeclaredEntry(
        '/app/src/pages/Widget.tsx',
        "import { createRoot } from 'react-dom/client';\nexport default function Widget() {\n  return <p />;\n}\n",
      ),
    ).toBe('refuse');
  });

  it('does not count a leftover boot import as a render call, only a boot() call site', () => {
    expect(
      classifyDeclaredEntry(
        '/app/src/pages/Widget.tsx',
        "import { boot } from '@immediately-run/sdk/boot';\nexport default function Widget() {\n  return <p />;\n}\n",
      ),
    ).toBe('refuse');
    expect(
      classifyDeclaredEntry(
        '/app/src/pages/Widget.tsx',
        "import { boot } from '@immediately-run/sdk/boot';\nboot();\n",
      ),
    ).toBe('entry');
  });

  it('does not mistake a render API in a comment or a string for a call', () => {
    expect(
      classifyDeclaredEntry(
        '/app/src/pages/Widget.tsx',
        '// TODO: createRoot here\nexport default function Widget() {\n  return <p />;\n}\n',
      ),
    ).toBe('refuse');
    expect(
      classifyDeclaredEntry(
        '/app/src/pages/Widget.tsx',
        'const hint = "call createRoot";\nexport default function Widget() {\n  return <p />;\n}\n',
      ),
    ).toBe('refuse');
  });

  it('refuses a default-exported named component with no render call', () => {
    expect(
      classifyDeclaredEntry(
        '/app/src/pages/Custom.tsx',
        'export default function Custom() {\n  return <p>hi</p>;\n}\n',
      ),
    ).toBe('refuse');
    expect(
      classifyDeclaredEntry(
        '/app/src/pages/Custom.tsx',
        'export default class Custom {\n  render() {\n    return <p />;\n  }\n}\n',
      ),
    ).toBe('refuse');
    expect(
      classifyDeclaredEntry('/app/src/pages/Custom.tsx', 'const Custom = () => <p />;\nexport default Custom;\n'),
    ).toBe('refuse');
    // The async modifier is transparent: an async component default is still a
    // component default, not an indeterminate expression.
    expect(
      classifyDeclaredEntry(
        '/app/src/pages/Custom.tsx',
        'export default async function Custom() {\n  return <p />;\n}\n',
      ),
    ).toBe('refuse');
  });

  it('does not let a comparison pair straddling a comment pose as a JSX tag', () => {
    // `<` ... comment ... `/` is division after a comparison, not a self-closing
    // tag — an uppercase default in such a file is a constant, not a component.
    expect(
      classifyDeclaredEntry('/app/src/lib.ts', 'if (a < /* max */ b / 2) {\n  limit();\n}\nexport default TITLE;\n'),
    ).toBe('entry');
  });

  it('keeps everything the component heuristic cannot clearly claim', () => {
    // An expression default, an anonymous function, an arrow: indeterminate —
    // the heuristic refuses only the clear case.
    expect(classifyDeclaredEntry('/app/src/lib.ts', 'export default answer + 1;\n')).toBe('entry');
    expect(classifyDeclaredEntry('/app/src/main.tsx', 'export default function () { sideEffect(); }\n')).toBe('entry');
    expect(classifyDeclaredEntry('/app/src/main.tsx', 'export default () => <div />;\n')).toBe('entry');
    // An uppercase default WITHOUT JSX is a constant, not a component (the
    // R3-899 guard fixture's src/main.ts shape) — it resolves as before.
    expect(
      classifyDeclaredEntry('/app/src/main.ts', "import { TITLE } from './data/movies';\nexport default TITLE;\n"),
    ).toBe('entry');
    // JSX only inside a string does not make the file a component module.
    expect(classifyDeclaredEntry('/app/src/main.tsx', 'export default TITLE;\nconst tpl = `<p />`;\n')).toBe('entry');
    // `export` as a member access is not the keyword — the `.` test reads the
    // PREVIOUS significant character, and `obj.export` in a JSX-bearing file
    // must not hijack the state machine ahead of the real default.
    expect(
      classifyDeclaredEntry(
        '/app/src/x.tsx',
        'obj.export = compute();\nexport default function Custom() {\n  return <p />;\n}\n',
      ),
    ).toBe('refuse');
    expect(classifyDeclaredEntry('/app/src/x.ts', 'mod.export = 1;\n')).toBe('entry');
    // An unreadable module keeps the historical behaviour rather than refusing.
    expect(classifyDeclaredEntry('/app/src/x.ts', undefined)).toBe('entry');
  });
});

describe('resolveEntryPoint with a manifest-declared entry', () => {
  let h: BundlerHarness;

  afterEach(() => h.teardown());

  const harnessWith = async (pkg: Record<string, unknown>, files: Record<string, string> = {}) => {
    h = await createBundlerHarness(
      { 'package.json': JSON.stringify(pkg), 'index.tsx': BOOT_INDEX, 'src/App.tsx': APP_TSX, ...files },
      { forCompile: true },
    );
    await h.bundler.processPackageJSON();
    return h;
  };

  it('resolves the boot-defaults entry for the drill manifest (main: src/App.tsx)', async () => {
    await harnessWith(JSON.parse(DRILL_BUNDLE_PKG));
    await expect(h.bundler.resolveEntryPoint()).resolves.toBe('/app/index.tsx');
  });

  it('resolves the boot entry for an extensionless main pointing at the component', async () => {
    await harnessWith({ name: 'extless', main: 'src/App' });
    await expect(h.bundler.resolveEntryPoint()).resolves.toBe('/app/index.tsx');
  });

  it('keeps a repository that ships its own render entry (main: src/main.tsx with createRoot)', async () => {
    await harnessWith(
      { name: 'vite-ish', main: 'src/main.tsx' },
      {
        'src/main.tsx':
          "import { createRoot } from 'react-dom/client';\n" +
          "import App from './App';\n" +
          "createRoot(document.getElementById('root')!).render(<App />);\n",
      },
    );
    await expect(h.bundler.resolveEntryPoint()).resolves.toBe('/app/src/main.tsx');
  });

  it('resolves what it did before when the manifest declares no entry', async () => {
    await harnessWith({ name: 'no-main', dependencies: {} });
    await expect(h.bundler.resolveEntryPoint()).resolves.toBe('/app/index.tsx');
  });

  it('resolves a plain-module main unchanged (no component shape, no render call)', async () => {
    await harnessWith(
      { name: 'vanilla', main: 'src/lib.ts' },
      {
        'src/lib.ts': "import answer from './answer';\nexport default answer + 1;\n",
        'src/answer.ts': 'export default 41;\n',
      },
    );
    await expect(h.bundler.resolveEntryPoint()).resolves.toBe('/app/src/lib.ts');
  });

  it('refuses loudly when the declared entry default-exports a component it cannot render', async () => {
    await harnessWith(
      { name: 'misdeclared', main: 'src/pages/Custom.tsx' },
      { 'src/pages/Custom.tsx': 'export default function Custom() {\n  return <p>hi</p>;\n}\n' },
    );
    await expect(h.bundler.resolveEntryPoint()).rejects.toBeInstanceOf(BundlerError);
    await expect(h.bundler.resolveEntryPoint()).rejects.toThrow(/src\/App\.tsx/);
  });

  it('falls through to the preset default when the declared component path does not exist', async () => {
    await harnessWith({ name: 'dangling', main: 'src/pages/Custom.tsx' });
    await expect(h.bundler.resolveEntryPoint()).resolves.toBe('/app/index.tsx');
  });
});
