/**
 * `sideEffectImports` — the static, no-execute extraction used to apply
 * `main.tsx`'s CSS/polyfill imports without running its render call
 * (DESIGN_TO §6a decision #27 / roadmap R3-53). The headline case is the
 * **double-render guard**: a real Vite `main.tsx` carries both
 * `import './index.css'` and `createRoot(...).render(...)`; we must return the
 * CSS and NOTHING that would re-execute render.
 */
import { sideEffectImports } from './sideEffectImports';

describe('sideEffectImports', () => {
  it('extracts a bare side-effect import', () => {
    expect(sideEffectImports(`import './index.css';`)).toEqual(['./index.css']);
  });

  it('double-render guard: a real main.tsx yields only its CSS, never render', () => {
    const mainTsx = `
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
`;
    // Only the side-effect CSS import — the binding imports (react, react-dom,
    // App) and the createRoot().render() body are excluded, so wiring this into
    // evaluation cannot double-mount the app.
    expect(sideEffectImports(mainTsx)).toEqual(['./index.css']);
  });

  it('excludes default, named, and namespace imports', () => {
    const src = `
import App from './App'
import { useState } from 'react'
import * as ns from './ns'
import './polyfills'
import "./theme.css"
`;
    expect(sideEffectImports(src)).toEqual(['./polyfills', './theme.css']);
  });

  it('handles single and double quotes and no-space/no-semicolon forms', () => {
    expect(sideEffectImports(`import"./a.css"\nimport './b.css'`)).toEqual([
      './a.css',
      './b.css',
    ]);
  });

  it('ignores commented-out imports', () => {
    const src = `
// import './old.css'
/* import './block.css' */
import './live.css'
`;
    expect(sideEffectImports(src)).toEqual(['./live.css']);
  });

  it('dedupes while preserving first-seen order', () => {
    const src = `import './a.css'\nimport './b.css'\nimport './a.css'`;
    expect(sideEffectImports(src)).toEqual(['./a.css', './b.css']);
  });

  it('does not match the word import inside other identifiers/strings', () => {
    const src = `const importMap = './nope.css'\nconst x = "import './nope2.css'"`;
    expect(sideEffectImports(src)).toEqual([]);
  });

  it('returns empty for a module with no side-effect imports', () => {
    expect(sideEffectImports(`import App from './App'\nexport default App`)).toEqual([]);
  });
});
