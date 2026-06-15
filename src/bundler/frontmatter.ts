import { parse as parseYaml } from 'yaml';

export type FrontmatterParseResult = {
  data: Record<string, any>;
  content: string;
};

const EXCERPT_SEPARATOR = '<More />';

// A leading `---` fenced block (tolerating a BOM and trailing spaces on the
// fences), closed by a line that is just `---`. Mirrors gray-matter's delimiter
// handling so existing `.mdx` frontmatter parses the same — we only swap the YAML
// engine underneath.
const FRONTMATTER_RE = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

/**
 * Parse leading `---` YAML frontmatter out of an MDX/Markdown source.
 *
 * Uses the pure-ESM `yaml` package (YAML 1.2) rather than gray-matter (which pulls
 * in Node-only `fs`/`Buffer` and an older js-yaml 1.1 — fragile to bundle for the
 * opaque-origin sandbox, and wrong on edge cases like the "Norway problem" where
 * `no` parses to `false`). Complex YAML — nested maps, flow/block sequences, block
 * scalars, quoted strings — is read correctly.
 *
 * Behaviour preserved from the previous gray-matter wrapper:
 *  - returns `{ data, content }`; `data` is `{}` when there is no frontmatter;
 *  - the `<More />` excerpt marker, when present after a non-empty prefix, is
 *    lifted onto `data.excerpt` and stripped (with the following whitespace) from
 *    `content`.
 *
 * Throws on malformed YAML (as gray-matter did); callers that must not fail —
 * `Bundler.extractMetadata` — already guard with try/catch.
 */
export const parseFrontmatter = (code: string): FrontmatterParseResult => {
  // Strip a leading BOM so a BOM-prefixed file still matches the fence.
  const src = code.charCodeAt(0) === 0xfeff ? code.slice(1) : code;
  let data: Record<string, any> = {};
  let content = src;

  const match = src.match(FRONTMATTER_RE);
  if (match) {
    content = src.slice(match[0].length);
    const yamlText = match[1]; // undefined for an empty `---\n---` block
    if (yamlText && yamlText.trim()) {
      const parsed = parseYaml(yamlText);
      // Frontmatter is conventionally a map; ignore a scalar/array/null document so
      // `data` stays a usable record (callers do `Object.keys(data)`).
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        data = parsed as Record<string, any>;
      }
    }
  }

  // Excerpt: the text before the first `<More />` marker (gray-matter-compatible).
  // Only when that prefix is non-empty — a marker at offset 0 is left in place, as
  // gray-matter's truthy-excerpt check did.
  const sepIdx = content.indexOf(EXCERPT_SEPARATOR);
  if (sepIdx > 0) {
    data.excerpt = content.slice(0, sepIdx);
    content = content.slice(sepIdx + EXCERPT_SEPARATOR.length).trimStart();
  }

  return { data, content };
};
