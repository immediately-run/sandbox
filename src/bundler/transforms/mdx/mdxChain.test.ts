import { isTransformable, selectReactChain } from '@immediately-run/transpiler';

import { ReactPreset } from '../../presets/react/ReactPreset';
import type { Module } from '../../module/Module';

// G-MDX-1 wiring guard. The `.mdx` MDX-COMPILE byte-identity (compileMdx == the
// CLI's `transformFile` MDX stage) is proven in the transpiler's own golden suite
// (`node --test`) — it CANNOT run here: `compileMdx` dynamically `import()`s the
// ESM-only `@mdx-js/mdx`, which jest's CJS vm rejects
// (ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG). In the browser iframe (parcel)
// and under `node --test` that dynamic import resolves normally. So here we assert
// the SANDBOX-side wiring that routes `.mdx` into the shared chain, not the compile.

describe('G-MDX-1 — `.mdx` is routed into the shared package chain', () => {
  it('`isTransformable` now covers app-root `.mdx`/`.md` (atomic coverage switch, 0.3.0)', () => {
    expect(isTransformable('/app/content/post.mdx')).toBe(true);
    expect(isTransformable('/app/content/post.md')).toBe(true);
    // …still app-root-scoped: a node_modules `.mdx` is owned by no branch.
    expect(isTransformable('/node_modules/pkg/readme.md')).toBe(false);
  });

  it('the package selects the MDX variant for `.mdx` (mdx→babel(react-refresh)→wrap)', () => {
    const chain = selectReactChain('/app/content/post.mdx');
    expect(chain).toMatchObject({ variant: 'react-refresh', mdx: true });
  });

  it('ReactPreset chains mdx-transformer FIRST, then babel + react-refresh', () => {
    const preset = new ReactPreset();
    const ids = preset.mapTransformers({ filepath: '/app/content/post.mdx' } as Module).map(([id]) => id);
    expect(ids).toEqual(['mdx-transformer', 'babel-transformer', 'react-refresh-transformer']);

    // A `.tsx` gets the same tail WITHOUT the mdx stage.
    const tsxIds = preset.mapTransformers({ filepath: '/app/src/App.tsx' } as Module).map(([id]) => id);
    expect(tsxIds).toEqual(['babel-transformer', 'react-refresh-transformer']);
  });
});
