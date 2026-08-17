#!/usr/bin/env node
/*
 * ONE SOURCE → FOUR PROJECTIONS (PLATFORM_LAYERING_SPEC §2 / S1 target 1, R3-274b).
 *
 * `descriptors.protocol.mjs` is the single definition of the sandbox↔SDK wire
 * vocabulary. This projects it into:
 *
 *   src/generated/protocol.ts               the frame's constants + payload types
 *   protocol-snapshot.json                  this repo's snapshot
 *   generated/sdk/protocol.ts               the SDK-side module
 *   generated/sdk/protocol-snapshot.json    the SDK's snapshot
 *
 * The two snapshots stop being independently-frozen artifacts and become
 * projections: after this item, `protocol-snapshot.json` is generated, and hand
 * editing it fails `protocol:check` (which extracts from SOURCE and compares).
 * That is the single-source property the whole S1 guardrail wants — the same
 * descriptor→projection mechanism `SDK_SIMPLIFICATION_SPEC` §2 proves for `spaces:*`.
 *
 * The generated snapshots must be BYTE-IDENTICAL to the Phase-1 hand-frozen ones.
 * Any diff is a descriptor bug to fix, not a snapshot to regenerate — that is what
 * proves the descriptors transcribe reality rather than replace it.
 *
 * ── The SDK-side delivery (read this before changing it) ──────────────────────
 * `generated/sdk/*` is emitted HERE and committed in THIS repo, then copied into
 * the SDK repo's `src/generated/protocol.ts` + `protocol-snapshot.json`. The copy
 * is a *manual sync* today, because there is no channel from this repo to the SDK:
 * the SDK does not depend on the sandbox (build order is SDK → fork → sandbox →
 * site-main), and reading a sibling checkout at build time is the very thing
 * R3-274d retires. The staleness is at least DETECTABLE: both emitted modules carry
 * a `descriptorsHash` stamp, so a stale SDK copy is visible by inspection rather
 * than silent. Making the sync automatic (publishing this as a versioned artifact
 * the SDK consumes, the ways_of_working §6 rule) is its own item — R3-274b1 — and
 * it gates R3-274c, the call-site migration that actually depends on the module.
 *
 * Run: node scripts/protocol-codegen/generate.mjs [--out <dir>]
 * Dependency-free.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CHANNELS,
  DYNAMIC_FAMILIES,
  ENVELOPES,
  FORMAT_VERSION,
  REPOS,
} from './descriptors.protocol.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const outIdx = process.argv.indexOf('--out');
const outRoot = outIdx === -1 ? repoRoot : resolve(process.cwd(), process.argv[outIdx + 1]);

const descriptorsHash = createHash('sha256')
  .update(readFileSync(join(here, 'descriptors.protocol.mjs')))
  .digest('hex')
  .slice(0, 16);

// ── snapshot projection ───────────────────────────────────────────────────────
/*
 * Re-assembles one side's snapshot from the descriptors. Key ORDER matters: these
 * files are compared byte-for-byte against the Phase-1 originals, so the object is
 * built in the same order the extractor wrote it (top level: formatVersion, repo,
 * channels, dynamicFamilies, envelopes; per entry: the side's own key order, with
 * the hoisted divergence marker last, where the audit put it).
 */
const snapshotFor = (side) => {
  const channels = {};
  for (const ch of CHANNELS) {
    const entry = ch[side];
    if (!entry) continue;
    channels[ch.name] = ch.divergent
      ? { ...entry, divergent: true, divergentNote: ch.divergentNote }
      : entry;
  }
  return {
    formatVersion: FORMAT_VERSION,
    repo: REPOS[side],
    channels,
    dynamicFamilies: DYNAMIC_FAMILIES[side],
    envelopes: ENVELOPES[side],
  };
};

// ── TypeScript projection ─────────────────────────────────────────────────────
/*
 * Type texts in the snapshot are TypeScript AS WRITTEN IN THEIR HOME MODULE, so a
 * field can name a type this generated module has never heard of (`StackFrame`,
 * `VcsPR` — the fingerprint's depth cap stops before their shape). Emitting the
 * name verbatim would not compile, and re-exporting a fake `StackFrame` from the
 * protocol module would be worse: someone would import it. So an unresolvable name
 * degrades to `unknown` with the original spelled out beside it — the module stays
 * honest about what the snapshot does and does not carry.
 */
const SAFE_TYPE_TOKENS = new Set([
  'string', 'number', 'boolean', 'unknown', 'any', 'null', 'undefined', 'void',
  'never', 'true', 'false', 'object', 'symbol', 'bigint',
  'Record', 'Array', 'Partial', 'Readonly', 'ReadonlyArray', 'Promise', 'Date',
  'MessagePort', 'Uint8Array', 'ArrayBuffer', 'Error',
]);

const sanitize = (text) => {
  // String-literal types carry words too (`"dark" | "light"`); they are values, not
  // names to resolve, so blank them before looking for identifiers.
  const withoutLiterals = text.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '');
  const idents = (withoutLiterals.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []).filter(
    (t) => !SAFE_TYPE_TOKENS.has(t),
  );
  if (!idents.length) return text;
  return `unknown /* ${text} */`;
};

/** A field description (the snapshot's shape language) → TypeScript. */
const tsType = (d, indent = '') => {
  if (!d) return 'unknown';
  if (d.union) return d.union.map((m) => tsType(m, indent)).join(' | ');
  if (d.array) return `Array<${tsType(d.array, indent)}>`;
  if (d.tuple) return `[${d.tuple.map((t) => tsType(t, indent)).join(', ')}]`;
  if (d.fields) {
    if (!d.fields.length) return 'Record<string, never>';
    const inner = d.fields
      .map((f) => `${indent}  ${f.name}${f.optional ? '?' : ''}: ${tsType(f, `${indent}  `)};`)
      .join('\n');
    return `{\n${inner}\n${indent}}`;
  }
  return d.type ? sanitize(d.type) : 'unknown';
};

/** Doc line for a channel: what it is, which way it goes, where it is spoken. */
const doc = (ch, entry) => {
  const lines = [
    `${entry.kind} · ${entry.direction}`,
    ...(entry.poll ? [`polled with \`${entry.poll}\``] : []),
    ...(ch.divergent ? [`DIVERGENT (R3-274e): ${ch.divergentNote}`] : []),
  ];
  return `/** \`${ch.name}\` — ${lines.join('. ')}. */`;
};

const emitTs = (side) => {
  const rows = CHANNELS.filter((ch) => ch[side]);
  const out = [];
  out.push(`// GENERATED by sandbox scripts/protocol-codegen/generate.mjs — DO NOT EDIT.`);
  out.push(`// Source of truth: sandbox scripts/protocol-codegen/descriptors.protocol.mjs`);
  out.push(`// descriptorsHash: ${descriptorsHash}`);
  out.push(`//`);
  out.push(`// The sandbox↔SDK wire vocabulary (PLATFORM_LAYERING_SPEC §2 / S1). Import the`);
  out.push(`// constants instead of writing the string: a rename then has ONE edit site and`);
  out.push(`// the protocol snapshot gate sees it. Payload types are emitted for every name`);
  out.push(`// that has a declared shape; a name handled as \`any\` today gets its read field`);
  out.push(`// list in the doc comment instead (R3-274e is where those grow real types).`);
  out.push('');
  out.push(`/** Every wire name this side speaks, as a union. */`);
  out.push(
    `export type WireName =\n${rows.map((ch) => `  | '${ch.name}'`).join('\n')};`,
  );
  out.push('');
  for (const ch of rows) {
    const entry = ch[side];
    out.push(doc(ch, entry));
    out.push(`export const ${ch.const} = '${ch.name}';`);
    const payload = entry.payload;
    if (payload?.fields?.length) {
      out.push(`export interface ${ch.type}Payload ${tsType(payload)}`);
    } else if (payload?.reads?.length) {
      out.push(`/** Read off this message today: ${payload.reads.map((r) => `\`${r}\``).join(', ')}. */`);
    }
    if (entry.methods) {
      for (const [method, spec] of Object.entries(entry.methods)) {
        if (!spec.payload?.fields?.length) continue;
        const name = `${ch.type}${method[0].toUpperCase()}${method.slice(1)}Params`;
        if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) continue;
        out.push(`/** Params of \`${ch.name}\` method \`${method}\`. */`);
        out.push(`export interface ${name} ${tsType(spec.payload)}`);
      }
    }
    out.push('');
  }
  out.push(`/** Every wire name this side speaks, keyed by its constant. */`);
  out.push(`export const WIRE_NAMES = {`);
  for (const ch of rows) out.push(`  ${ch.const},`);
  out.push(`} as const;`);
  out.push('');
  return out.join('\n');
};

// ── emit ──────────────────────────────────────────────────────────────────────
const write = (rel, text) => {
  const target = join(outRoot, rel);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
  return rel;
};

const json = (v) => JSON.stringify(v, null, 2) + '\n';

const written = [
  write('src/generated/protocol.ts', emitTs('sandbox')),
  write('protocol-snapshot.json', json(snapshotFor('sandbox'))),
  write('generated/sdk/protocol.ts', emitTs('sdk')),
  write('generated/sdk/protocol-snapshot.json', json(snapshotFor('sdk'))),
];

console.log(`✓ Generated from ${CHANNELS.length} descriptors (hash ${descriptorsHash}):`);
for (const w of written) console.log(`    ${w}`);
