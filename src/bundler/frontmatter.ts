// `parseFrontmatter` now lives in @immediately-run/transpiler so the runtime live
// scan (`Bundler.extractMetadata`) and the CLI's cache-zip frontmatter sidecar
// derive byte-identical values from one shared parser
// (MDX_CONTENT_COLLECTIONS_SPEC §1.1). Re-exported here so existing sandbox
// imports (`./frontmatter`) — `bundler.ts`, `transforms/mdx`, and
// `frontmatter.test.ts` — are unchanged.
export { parseFrontmatter } from '@immediately-run/transpiler';
export type { FrontmatterParseResult } from '@immediately-run/transpiler';
