# An Open Knowledge Format page (R3-1368)

`events_.md` is `ga4/tables/events_.md` from Google's Open Knowledge Format sample bundles
(`GoogleCloudPlatform/open-knowledge-format`), copied verbatim through the probe commit
`123b3fe` in `immediately-run/grove`. It is licensed under the Apache License 2.0, included
here as `LICENSE.txt`.

It is a real plain-Markdown content page: YAML frontmatter with nested maps
(`generated: {by, at}`) and lists of maps (`sources`), and a body with GFM tables and
footnotes. `src/bundler/frontmatterSource.test.ts` reads it. Frozen: the point is those
exact bytes, not the bundle's current file.
