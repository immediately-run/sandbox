// Which files the frontmatter metadata store indexes: MDX entries and plain Markdown.
//
// Plain `.md` is here because content bundles written outside immediately.run keep their
// pages as `.md` — an Open Knowledge Format bundle is a folder of `.md` files with YAML
// frontmatter — and those pages were transpiled and rendered but never indexed, so a
// collection mixing the two showed metadata for its `.mdx` half only.
//
// Case-sensitive on purpose, matching the CLI's cache-zip sidecar emitter: transpile
// coverage (`isTransformable`, case-insensitive) is a different question from which
// files the store indexes, and the cached and live scans must agree on the set.
const FRONTMATTER_SOURCE_EXTENSIONS = ['.mdx', '.md'] as const;

/** True when the metadata store indexes this path's frontmatter. */
export const isFrontmatterSource = (path: string): boolean =>
  FRONTMATTER_SOURCE_EXTENSIONS.some((ext) => path.endsWith(ext));
