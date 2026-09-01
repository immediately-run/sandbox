// The headings index extension (GROVE_AGENT_SPEC §4), bundler side: `filesMetadata`
// rows gain an additive `headings: [{id, text, depth}]` computed from the entry's
// BODY by the same `@immediately-run/mdx-plugins` heading-anchor canon the render
// path uses — so an index heading's id IS the id a reader's `#fragment` lands on.
//
// This mirrors the SDK's `collectHeadings` (`immediately-run-sdk/src/collectHeadings.ts`):
// the sandbox bundler cannot import the SDK at runtime (it SERVES the SDK), so the
// walk lives on both sides — pinned to one canon by importing the SAME `headingId`
// and asserted against the SAME fixture set (`SLUG_PARITY_FIXTURE`) in both repos'
// tests. The walk is a byte-level ATX scan (top-level `#`–`######` outside code
// fences); headings carrying an author id (MDX `{#…}`/JSX) stay the remark pass's
// to own.
//
// Additive by design: an older index (or a sidecar-seeded row, which carries
// frontmatter only — no body at seed time) simply lacks `headings`, and readers
// degrade to body reads (ways_of_working §6).

import { headingId } from '@immediately-run/mdx-plugins';

export interface BundlerHeadingSummary {
  id: string;
  text: string;
  /** 1–6, the ATX depth. */
  depth: number;
}

/** Collect an entry's headings from its MDX/Markdown BODY (frontmatter stripped),
 * ids from the canon with per-document duplicate suffixes (`baseId-1`, …). */
export function collectHeadings(body: string, opts: { sectionIds?: boolean } = {}): BundlerHeadingSummary[] {
  const sectionIds = opts.sectionIds !== false;
  const seen = new Map<string, number>();
  const out: BundlerHeadingSummary[] = [];

  let fenceMarker: string | null = null; // inside a ``` or ~~~ block
  for (const line of body.split('\n')) {
    const fenceMatch = /^(\s{0,3})(`{3,}|~{3,})/.exec(line);
    if (fenceMarker) {
      if (fenceMatch && line.trim().startsWith(fenceMarker)) fenceMarker = null;
      continue;
    }
    if (fenceMatch) {
      fenceMarker = fenceMatch[2][0].repeat(3);
      continue;
    }
    const h = /^(#{1,6})[ \t]+(\S.*)$/.exec(line);
    if (!h) continue;
    const text = flattenInline(h[2].trim());
    if (!text) continue;
    const baseId = headingId(text, { sectionIds });
    const n = seen.get(baseId) ?? 0;
    seen.set(baseId, n + 1);
    const id = n === 0 ? baseId : `${baseId}-${n}`;
    out.push({ id, text, depth: h[1].length });
  }
  return out;
}

/** Flatten inline markup the way the remark pass's `headingText` does: emphasis and
 * code markers drop, link/image syntax keeps its text. */
function flattenInline(s: string): string {
  return s
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // [text](url) / ![alt](url) → text
    .replace(/`([^`]*)`/g, '$1') // `code` → code
    .replace(/\*\*([^*]+)\*\*/g, '$1') // **bold** → bold
    .replace(/\*([^*]+)\*/g, '$1') // *em* → em
    .replace(/__([^_]+)__/g, '$1') // __bold__ → bold
    .replace(/_([^_]+)_/g, '$1'); // _em_ → em
}

/**
 * Attach the additive `headings` field to a parsed frontmatter record. The author's
 * OWN `headings` frontmatter key (if any) wins — the row is their data first; the
 * computed field is an index extension, not an override.
 */
export function withHeadings(data: Record<string, any>, body: string): Record<string, any> {
  if (Object.prototype.hasOwnProperty.call(data, 'headings')) return data;
  const headings = collectHeadings(body);
  return headings.length ? { ...data, headings } : data;
}
