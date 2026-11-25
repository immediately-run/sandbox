import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

// The submodule, not the package index: the index opens a host transport at import.
import { DEFAULT_MDX_COMPONENTS } from '@immediately-run/sdk/components/MDXComponents';

import { DEFAULT_SDK_VERSION, SELF_HOST_FLOORS } from './bundler';
import { compareSemver } from './registryResolvedModules';

// The SDK an app with no SDK declaration gets (SDK_PACKAGING_SPEC §5.1(c)) must
// define every component the current transpiler's Markdown output references. On
// 2026-11-23 it did not: the default was 0.16.0, the transpiler emitted
// `<HeadingAnchor>` for every heading (R3-186, SDK 0.29.0+), and every README in a
// repo with no SDK pin failed with "Expected component `HeadingAnchor` to be defined".
//
// The chain held here, both links from the real producers:
//   1. every component the installed transpiler emits is in the installed SDK's
//      DEFAULT_MDX_COMPONENTS (the phantom defaults, MARKDOWN_SYNTAX_SPEC §11.2), and
//   2. DEFAULT_SDK_VERSION is no older than that installed SDK.
// Bumping the transpiler past the SDK, or the SDK devDependency past the default,
// fails one of them.
//
// The same holds for the FLOOR (SDK_PACKAGING_SPEC §5.1(b)): an app may pin any SDK at
// or above it, so the floor SDK must define every emitted component too. The floor's
// default components are a recorded fixture (fixtures/sdk-selfhost/), because the
// floor version is not installed here. Raising the floor means re-recording it; a
// transpiler that emits a new component fails until the floor is raised to an SDK
// that defines it.

const ROOT = join(__dirname, '..', '..');

/** One Markdown file using every construct the transpiler rewrites into a component:
 *  headings (HeadingAnchor), a GitHub alert (Admonition) and a wikilink (WikiLink). */
const MARKDOWN = [
  '# Title',
  '',
  '> [!NOTE]',
  '> Useful information.',
  '',
  'See [[Other page]].',
  '',
  '## Section two',
  '',
].join('\n');

/** The components the compiled file reports missing when the provider lacks them.
 *  `compileMdx` dynamically imports the ESM-only `@mdx-js/mdx`, which jest's CJS vm
 *  rejects (see mdxChain.test.ts), so the compile runs in a child node process. */
function componentsTheTranspilerEmits(): string[] {
  const script = `
    import { compileMdx } from '@immediately-run/transpiler';
    const out = await compileMdx(${JSON.stringify(MARKDOWN)}, '/app/README.md');
    const names = [...out.matchAll(/_missingMdxReference\\("(\\w+)"/g)].map((m) => m[1]);
    process.stdout.write(JSON.stringify([...new Set(names)].sort()));
  `;
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: ROOT,
    encoding: 'utf-8',
  });
  return JSON.parse(stdout);
}

describe('DEFAULT_SDK_VERSION covers what the transpiler emits', () => {
  it('every component the transpiler emits is a default MDX component of the installed SDK', () => {
    const emitted = componentsTheTranspilerEmits();
    // Guard against a vacuous pass: the probe must actually see the rewritten constructs.
    expect(emitted).toEqual(expect.arrayContaining(['Admonition', 'HeadingAnchor', 'WikiLink']));
    const missing = emitted.filter((name) => !(name in DEFAULT_MDX_COMPONENTS));
    expect(missing).toEqual([]);
  });

  it('DEFAULT_SDK_VERSION is no older than the SDK this sandbox is tested against', () => {
    const installed = JSON.parse(
      readFileSync(join(ROOT, 'node_modules', '@immediately-run', 'sdk', 'package.json'), 'utf-8'),
    ).version as string;
    expect(compareSemver(DEFAULT_SDK_VERSION, installed)).toBeGreaterThanOrEqual(0);
  });

  it('the SDK floor defines every component the transpiler emits', () => {
    const floor = SELF_HOST_FLOORS['@immediately-run/sdk'];
    const recorded = JSON.parse(
      readFileSync(join(__dirname, 'testHarness', 'fixtures', 'sdk-selfhost', `v${floor}.mdx-defaults.json`), 'utf-8'),
    ) as { version: string; components: string[] };
    expect(recorded.version).toBe(floor);
    const missing = componentsTheTranspilerEmits().filter((name) => !recorded.components.includes(name));
    expect(missing).toEqual([]);
  });
});
