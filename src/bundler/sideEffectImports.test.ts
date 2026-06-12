import { LOCAL_ENTRY_CANDIDATES, collectLocalEntrySideEffects, extractSideEffectImports } from './sideEffectImports';

describe('extractSideEffectImports', () => {
  it('captures a bare side-effect import', () => {
    expect(extractSideEffectImports(`import './index.css';`)).toEqual(['./index.css']);
  });

  it('handles single and double quotes and a missing semicolon', () => {
    expect(extractSideEffectImports(`import "./a.css"\nimport './b.css'`)).toEqual(['./a.css', './b.css']);
  });

  it('captures bare-package (polyfill) side-effect imports', () => {
    expect(extractSideEffectImports(`import 'core-js/stable';`)).toEqual(['core-js/stable']);
  });

  it('excludes default, named, namespace and aliased imports', () => {
    const src = `
      import App from './App.tsx';
      import { StrictMode } from 'react';
      import * as ReactDOM from 'react-dom/client';
      import Default, { named } from './mix';
    `;
    expect(extractSideEffectImports(src)).toEqual([]);
  });

  it('excludes dynamic import() calls', () => {
    expect(extractSideEffectImports(`const m = await import('./lazy.css');`)).toEqual([]);
    // `import ('x')` with a space before the paren is still a dynamic import.
    expect(extractSideEffectImports(`import ('./lazy.css');`)).toEqual([]);
  });

  it('ignores imports inside line and block comments', () => {
    const src = `
      // import './commented.css';
      /* import './block.css'; */
      import './real.css';
    `;
    expect(extractSideEffectImports(src)).toEqual(['./real.css']);
  });

  it('ignores import-like text inside strings and templates', () => {
    const src = `
      const a = "import './fake.css'";
      const b = \`import './also-fake.css'\`;
      import './real.css';
    `;
    expect(extractSideEffectImports(src)).toEqual(['./real.css']);
  });

  it('ignores .import member access', () => {
    expect(extractSideEffectImports(`thing.import './nope.css';`)).toEqual([]);
  });

  it('preserves a `from`-bearing statement that is not a side effect', () => {
    expect(extractSideEffectImports(`import x from './x';`)).toEqual([]);
  });

  // The canonical `create-vite` React + TS scaffold `src/main.tsx`. Proves both
  // exit-criteria mechanics at once: the global CSS import is harvested (→ the
  // app renders STYLED on the platform), while the `App` import and the
  // `createRoot(...).render(...)` call are NOT (→ the app is never
  // double-rendered).
  it('on a default create-vite main.tsx, returns only the global CSS', () => {
    const viteMain = `
      import { StrictMode } from 'react'
      import { createRoot } from 'react-dom/client'
      import './index.css'
      import App from './App.tsx'

      createRoot(document.getElementById('root')!).render(
        <StrictMode>
          <App />
        </StrictMode>,
      )
    `;
    expect(extractSideEffectImports(viteMain)).toEqual(['./index.css']);
  });

  it('keeps multiple side-effect imports in source order, including CSS + polyfill', () => {
    const src = `
      import 'core-js/stable';
      import './reset.css';
      import App from './App';
      import './theme.css';
    `;
    expect(extractSideEffectImports(src)).toEqual(['core-js/stable', './reset.css', './theme.css']);
  });
});

describe('collectLocalEntrySideEffects', () => {
  const ENTRY = '/app/src/App.tsx';

  // A fake module resolver over a small virtual tree. `resolve('./x', from)`
  // joins against `from`'s directory; bare paths in `files` resolve directly.
  const makeResolve =
    (files: Record<string, string>) =>
    async (specifier: string, from: string): Promise<string> => {
      let resolved: string;
      if (specifier.startsWith('.')) {
        const dir = from.slice(0, from.lastIndexOf('/'));
        const parts = `${dir}/${specifier}`.split('/');
        const stack: string[] = [];
        for (const part of parts) {
          if (part === '' || part === '.') continue;
          if (part === '..') stack.pop();
          else stack.push(part);
        }
        resolved = '/' + stack.join('/');
      } else {
        resolved = `/node_modules/${specifier}`;
      }
      // Try the path as-is, then with conventional extensions.
      for (const cand of [resolved, `${resolved}.tsx`, `${resolved}.ts`, `${resolved}.js`]) {
        if (cand in files) return cand;
      }
      throw new Error(`Cannot resolve ${specifier} from ${from}`);
    };

  it('harvests side-effect imports from a conventional src/main.tsx', async () => {
    const files: Record<string, string> = {
      '/app/src/main.tsx': `
        import { createRoot } from 'react-dom/client'
        import './index.css'
        import 'core-js/stable'
        import App from './App.tsx'
        createRoot(document.getElementById('root')!).render(<App />)
      `,
      '/app/src/App.tsx': 'export default function App() { return null }',
      '/app/src/index.css': 'body{}',
      '/node_modules/core-js/stable': '',
    };
    const result = await collectLocalEntrySideEffects({
      entryPoint: ENTRY,
      resolve: makeResolve(files),
      readFile: async (p) => files[p],
    });
    expect(result.localEntry).toBe('/app/src/main.tsx');
    expect(result.sideEffectModules).toEqual(['/app/src/index.css', '/node_modules/core-js/stable']);
  });

  it('returns nothing when no local entry exists', async () => {
    const files: Record<string, string> = {
      '/app/src/App.tsx': 'export default function App() { return null }',
    };
    const result = await collectLocalEntrySideEffects({
      entryPoint: ENTRY,
      resolve: makeResolve(files),
      readFile: async (p) => files[p],
    });
    expect(result.localEntry).toBeUndefined();
    expect(result.sideEffectModules).toEqual([]);
  });

  it('never re-pulls the render entry as a side-effect module', async () => {
    const files: Record<string, string> = {
      '/app/src/main.tsx': `
        import './App.tsx'
        import './index.css'
      `,
      '/app/src/App.tsx': 'export default function App() { return null }',
      '/app/src/index.css': 'body{}',
    };
    const result = await collectLocalEntrySideEffects({
      entryPoint: ENTRY,
      resolve: makeResolve(files),
      readFile: async (p) => files[p],
    });
    expect(result.sideEffectModules).toEqual(['/app/src/index.css']);
  });

  it('bails out when the local-entry convention file IS the render entry', async () => {
    const files: Record<string, string> = {
      '/app/src/main.tsx': `import './index.css'`,
      '/app/src/index.css': 'body{}',
    };
    // entryPoint resolves to the same src/main.tsx file.
    const result = await collectLocalEntrySideEffects({
      entryPoint: '/app/src/main.tsx',
      resolve: makeResolve(files),
      readFile: async (p) => files[p],
    });
    expect(result.sideEffectModules).toEqual([]);
  });

  it('de-duplicates repeated side-effect imports', async () => {
    const files: Record<string, string> = {
      '/app/src/main.tsx': `
        import './index.css'
        import './index.css'
      `,
      '/app/src/App.tsx': 'export default function App() { return null }',
      '/app/src/index.css': 'body{}',
    };
    const result = await collectLocalEntrySideEffects({
      entryPoint: ENTRY,
      resolve: makeResolve(files),
      readFile: async (p) => files[p],
    });
    expect(result.sideEffectModules).toEqual(['/app/src/index.css']);
  });

  it('skips (and warns about) an unresolvable side-effect import without throwing', async () => {
    const files: Record<string, string> = {
      '/app/src/main.tsx': `
        import './missing.css'
        import './index.css'
      `,
      '/app/src/App.tsx': 'export default function App() { return null }',
      '/app/src/index.css': 'body{}',
    };
    const warnings: string[] = [];
    const result = await collectLocalEntrySideEffects({
      entryPoint: ENTRY,
      resolve: makeResolve(files),
      readFile: async (p) => files[p],
      onWarn: (m) => warnings.push(m),
    });
    expect(result.sideEffectModules).toEqual(['/app/src/index.css']);
    expect(warnings.some((w) => w.includes('missing.css'))).toBe(true);
  });

  it('prefers src/main over a root-level main', async () => {
    const files: Record<string, string> = {
      '/app/src/main.tsx': `import './scoped.css'`,
      '/app/main.tsx': `import './root.css'`,
      '/app/src/App.tsx': 'export default function App() { return null }',
      '/app/src/scoped.css': 'body{}',
    };
    const result = await collectLocalEntrySideEffects({
      entryPoint: ENTRY,
      resolve: makeResolve(files),
      readFile: async (p) => files[p],
    });
    expect(result.localEntry).toBe('/app/src/main.tsx');
    expect(LOCAL_ENTRY_CANDIDATES[0]).toBe('src/main');
  });
});
