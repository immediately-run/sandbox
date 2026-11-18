# grove `hero.mdx` at two commits (R3-1349)

grove's `content/_layouts/hero.mdx`, copied verbatim from `immediately-run/grove`:

- `hero-33391ef.mdx`: the shipped starter. Its unquoted `description:` holds `nav: top`
  and `cover: lands` mid-line, which is a YAML error, so the live scan writes no row.
- `hero-e017647.mdx`: the same file with the `description:` quoted. It parses to
  `layoutRole: root`, `nav: top`.

`src/bundler/frontmatterAdoption.test.ts` reads them. Frozen: the point is those exact
bytes, not grove's current file.
