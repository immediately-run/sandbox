import { createBundlerHarness, type BundlerHarness } from '../testHarness/bundlerHarness';

// G2-5 [harness]: the §5.3 MISS → live transpile → write-through path. Kept in its
// own file because the in-process babel loopback is one-per-file (its connect
// handshake self-removes after the first harness), and this is the only G2-5 test
// that transpiles live.

const FIXTURE: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'g25-wt', main: 'src/index.ts' }),
  'src/index.ts': `import { x } from './util';\nexport const y = x + 1;\n`,
  'src/util.ts': `export const x = 42;\n`,
};

describe('G2-5 write-through', () => {
  let h: BundlerHarness;
  afterEach(() => h?.teardown());

  it('a MISS transpiles live, then writes through so a later consult hits', async () => {
    h = await createBundlerHarness(FIXTURE, { forCompile: true });

    // Nothing seeded → no /transpiled entry yet.
    expect(await h.bundler.artifactStore.consult('/app/src/index.ts')).toBeNull();

    // First transform: a MISS → live Babel transpile (recorded by the spy).
    const mod = await h.bundler.transformModule('/app/src/index.ts');
    expect(h.babel.transformRequests).toContain('/app/src/index.ts');

    // Write-through: the compiled output is now in the store, byte-for-byte.
    const hit = await h.bundler.artifactStore.consult('/app/src/index.ts');
    expect(hit).not.toBeNull();
    expect(hit?.content).toBe(mod.compiled);
    // its deps were recorded too (the local `./util` specifier).
    expect(hit?.deps).toContain('./util');
  });
});
