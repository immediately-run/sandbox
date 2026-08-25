import { metadataKeyFor, stripAppRoot } from '@immediately-run/platform-constants';

import { createBundlerHarness, type BundlerHarness } from './testHarness/bundlerHarness';

// Regression guard for the path-space fix: MDX frontmatter metadata must be keyed
// by the file's ABSOLUTE module/fs path (`/app/...`) — the same identifier
// `module.dynamicImport`, `fs`, and the SDK `<Include>` use — NOT the
// APP_ROOT-stripped URL-space path (`/content/...`). Keeping metadata in the file
// space lets an app read a file's metadata and render it with the same path.
describe('MDX metadata is keyed by the absolute /app module path', () => {
  let h: BundlerHarness;

  afterEach(async () => {
    if (h) await h.teardown();
  });

  it('keys preloaded MDX metadata by /app/<path>, not the stripped path', async () => {
    h = await createBundlerHarness({
      'package.json': JSON.stringify({ name: 'meta-fixture', main: 'src/index.ts' }),
      'index.html': '<!doctype html><div id="root"></div>',
      'src/index.ts': 'export default 1;\n',
      'content/post.mdx': '---\ntitle: Hello\n---\n\n# Hi\n',
    });

    await h.bundler.preloadMDXMetadata();

    const lastMetadata = (h.bundler as unknown as { lastMetadata: Map<string, Record<string, unknown>> }).lastMetadata;

    // Asserted THROUGH the shared helper (R3-275): the sandbox and the SDK derive
    // this key space from one definition now, so the two sides can no longer diverge
    // while this test stays green. The literals are kept alongside so the test still
    // says out loud what the key looks like.
    expect(metadataKeyFor('content/post.mdx')).toBe('/app/content/post.mdx');
    expect(lastMetadata.has(metadataKeyFor('content/post.mdx'))).toBe(true);
    expect(lastMetadata.has(stripAppRoot(metadataKeyFor('content/post.mdx')))).toBe(false);
    expect(lastMetadata.get(metadataKeyFor('content/post.mdx'))).toMatchObject({
      title: 'Hello',
    });
  });
});
