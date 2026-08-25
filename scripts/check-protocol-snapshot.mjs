#!/usr/bin/env node
/*
 * Freeze the sandbox↔host WIRE VOCABULARY (PLATFORM_LAYERING_SPEC §2 / S1, Phase 1,
 * roadmap R3-274a). This is the SANDBOX half of the gate; the SDK half is
 * `immediately-run-sdk/scripts/check-protocol-snapshot.mjs` (roadmap R3-274), whose
 * snapshot format this file reproduces byte-compatibly so the two can be diffed.
 *
 * WHY SHAPE AND NOT JUST NAME. The known live drift is `fs-change`: one wire name
 * carrying two different payload shapes (this repo's vs. the SDK's `paths`/`epoch`
 * shape). A name-only snapshot would have blessed it green. So every entry records
 * fields + types + optionality, and a change to any of them fails.
 *
 *   - A name in the snapshot but not in the source  → REMOVED/RENAMED → fail.
 *   - A name whose recorded shape no longer matches → RESHAPED       → fail.
 *   - A name in the source but not in the snapshot  → ADDITIVE       → fail with
 *     "run `npm run protocol:update`", so every wire change is reviewed in a diff.
 *
 * Usage: node scripts/check-protocol-snapshot.mjs [--self-test]
 *
 * ── Where the snapshot comes from (R3-274b1) ──────────────────────────────────
 * `@immediately-run/sandbox-protocol/snapshots/sandbox` — the PUBLISHED contract,
 * generated from the descriptor set that owns the wire. There is no `--update` any
 * more, and that is the point: this repo can no longer bless its own wire change by
 * rewriting a local file. A change goes descriptors → publish → bump the pin here,
 * which is what makes the contract cross-repo rather than a copy that agrees today.
 *
 * Iterating on an unpublished change: link a local checkout of the package
 * (`npm link @immediately-run/sandbox-protocol`) and this reads whatever it resolves
 * to. No env-var bypass exists, deliberately — a bypass would be reachable in CI.
 *
 * ── SNAPSHOT FORMAT (protocol-snapshot.json, formatVersion 1) ──────────────────
 * Identical to the SDK's. `direction` is written from the FRAME's point of view in
 * both repos — `app->host` means frame→host, `host->app` means host→frame — so the
 * two snapshots line up name by name.
 *
 * {
 *   "formatVersion": 1,
 *   "repo": "<package name of the side this snapshot describes>",
 *   "channels": {                       // keyed by the WIRE NAME, as it appears in `msg.type`
 *     "<wire-name>": {
 *       "kind":      "message" | "push" | "poll" | "request" | "stream",
 *       "direction": "app->host" | "host->app" | "both",
 *       "payload": { "fields": [ { "name", "optional", "type" } ] | "type": "…",
 *                    "reads": [ "<field>" ] },
 *       "poll":    "<wire-name>",       // push channels only: their `request-*` twin
 *       "methods": { "<method>": { "payload": … } },   // request/stream only
 *       "sites":   [ "src/…" ],
 *       "divergent": true               // set BY HAND when the two repos' snapshots
 *                                       // disagree on this name's shape. Phase 1
 *                                       // records it; R3-274e resolves and clears it.
 *     }
 *   },
 *   "envelopes":       { … },           // the framing every message rides
 *   "dynamicFamilies": { "<template>": { "schemes": [ … ], "sites": [ … ] } }
 * }
 *
 * `payload.fields` is the structural fingerprint: property name, optionality, and the
 * TypeScript type text, whitespace-normalized, sorted by name.
 *
 * ── EXTRACTION ────────────────────────────────────────────────────────────────
 * From SOURCE via the TypeScript compiler API — a real type checker, not regex,
 * because a regex cannot see that a field became optional, and because this repo
 * names most of its channels through CONSTANTS (`MOUNT_ADD_MESSAGE`), which only a
 * checker can resolve back to `'mount-add'`. Recognized sites:
 *
 *   sendMessage(<name>, <payload>)          → app->host   (`name` may be a constant)
 *   switch (m.type) { case <name>: … }      → host->app   (+ the fields the case reads)
 *   m.type === <name>                       → host->app   (+ the fields that scope reads)
 *   interface X { type: typeof NAME; … }    → the DECLARED payload for that name
 *   `protocol-${protocolName}`              → dynamic family (template + envelope)
 *
 * Test files are excluded: they exercise the vocabulary, they do not define it.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'src');
// The published contract, resolved through node so a linked local checkout works
// for iteration without a bypass this gate would then have to trust.
const snapshotPath = require.resolve('@immediately-run/sandbox-protocol/snapshots/sandbox');
const pkgName = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name;
const pkgVersion = JSON.parse(
  readFileSync(require.resolve('@immediately-run/sandbox-protocol/package.json'), 'utf8'),
).version;

// ── source enumeration ────────────────────────────────────────────────────────
// The bundler's own internals (transforms, resolver, the babel worker) speak no
// parent-frame protocol; excluding them keeps the program small and the extraction
// focused on the frame boundary. `bundler/bundler.ts` and `bundler/perfMarkers.ts`
// DO mint outbound names, so the exclusion is per-directory, not per-tree.
const EXCLUDED_DIRS = new Set(['transforms', 'testHarness', 'fixture']);
const isTest = (name) => /\.(test|spec)\.tsx?$/.test(name);
const listSources = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) out.push(...listSources(p));
    } else if (/\.tsx?$/.test(entry.name) && !isTest(entry.name)) out.push(p);
  }
  return out.sort();
};

// ── type description (identical rules to the SDK side) ────────────────────────
const normalize = (s) => s.replace(/\s+/g, ' ').trim();

const MAX_DEPTH = 2;

/**
 * Structural fingerprint of a type.
 *
 * Object types expand field by field; unions expand member by member; arrays and
 * tuples expand through their elements. Everything else is its type text.
 *
 * WHY EXPAND INSTEAD OF PRINTING THE TYPE NAME. A field typed `HostTheme` prints
 * as `"HostTheme"`, and then *adding a third theme* — a genuinely new value on the
 * wire — changes nothing in the snapshot. The alias has to be resolved for the gate
 * to mean "the shape", not "the spelling". Depth is capped at MAX_DEPTH so a field
 * whose type reaches half the codebase does not drag it into the snapshot.
 */
const describeType = (checker, type, node, depth = 0) => {
  if (!type) return { type: 'unknown' };
  const text = (t = type) => normalize(checker.typeToString(t, undefined, ts.TypeFormatFlags.NoTruncation));
  if (depth > MAX_DEPTH) return { type: text() };
  if (checker.isArrayType?.(type)) {
    const [el] = checker.getTypeArguments(type);
    return { array: describeType(checker, el, node, depth + 1) };
  }
  if (checker.isTupleType?.(type)) {
    return {
      tuple: checker.getTypeArguments(type).map((t) => describeType(checker, t, node, depth + 1)),
    };
  }
  // `boolean` is internally `true | false`; keep it spelled as itself.
  if (type.flags & ts.TypeFlags.Boolean) return { type: 'boolean' };
  if (type.isUnion?.()) {
    const members = type.types.map((t) => describeType(checker, t, node, depth + 1)).map((d) => JSON.stringify(d));
    return { union: [...new Set(members)].sort().map((j) => JSON.parse(j)) };
  }
  const isObject = Boolean(type.flags & ts.TypeFlags.Object);
  const callable = checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0;
  if (isObject && !callable) {
    const props = checker.getPropertiesOfType(type).filter((p) => !p.name.startsWith('__@'));
    if (props.length) {
      const fields = props
        .map((p) => {
          const decl = p.valueDeclaration ?? p.declarations?.[0] ?? node;
          return {
            name: p.name,
            optional: Boolean(p.flags & ts.SymbolFlags.Optional),
            ...describeType(checker, checker.getTypeOfSymbolAtLocation(p, decl), decl, depth + 1),
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      return { fields };
    }
  }
  return { type: text() };
};

/** Field names read off `subject` anywhere inside `node`. */
const readsOf = (node, subject) => {
  const reads = new Set();
  if (!node || !subject) return [];
  const walk = (n) => {
    if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === subject) {
      reads.add(n.name.text);
    }
    if (
      ts.isElementAccessExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === subject &&
      ts.isStringLiteralLike(n.argumentExpression)
    ) {
      reads.add(n.argumentExpression.text);
    }
    ts.forEachChild(n, walk);
  };
  walk(node);
  reads.delete('type'); // the discriminant, not a payload field
  return [...reads].sort();
};

// ── extraction ────────────────────────────────────────────────────────────────
export const extract = (opts = {}) => {
  const patch = opts.patch ?? new Map();
  const files = opts.files ?? listSources(srcDir);
  const options = {
    ...JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8')).compilerOptions,
    module: ts.ModuleKind.ES2020,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.Preserve,
    target: ts.ScriptTarget.ESNext,
    rootDir: undefined,
    noEmit: true,
  };
  const host = ts.createCompilerHost(options, true);
  const readFile = host.readFile.bind(host);
  host.readFile = (fileName) => patch.get(resolve(fileName)) ?? readFile(fileName);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    const patched = patch.get(resolve(fileName));
    if (patched !== undefined) {
      return ts.createSourceFile(fileName, patched, languageVersion, true);
    }
    return getSourceFile(fileName, languageVersion, onError, shouldCreate);
  };

  const program = ts.createProgram({ rootNames: files, options, host });
  const checker = program.getTypeChecker();

  /** A string-literal-valued expression — a literal, or a const that resolves to one. */
  const asLiteral = (node) => {
    if (!node) return undefined;
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
      const t = checker.getTypeAtLocation(node);
      if (t.isStringLiteral?.()) return t.value;
    }
    return undefined;
  };

  const channels = {};
  const dynamicFamilies = {};
  /** name → declared payload from an `interface X { type: typeof NAME; … }`. */
  const declared = {};

  const site = (node) => relative(root, node.getSourceFile().fileName).split('\\').join('/');

  /**
   * Fields read off the message by a handler the message is HANDED TO — the
   * dispatch cases here mostly do `case MOUNT_ADD_MESSAGE: this.handleMountAdd(message)`,
   * so the real payload shape lives one call away. Followed exactly ONE level: deep
   * enough for the dispatch idiom, shallow enough to stay predictable (a snapshot
   * that changed because some transitive callee grew a field read would be noise).
   */
  const followCalls = (scopeNode, subject) => {
    const extra = new Set();
    const walk = (n) => {
      if (ts.isCallExpression(n)) {
        n.arguments.forEach((arg, i) => {
          if (!ts.isIdentifier(arg) || arg.text !== subject) return;
          const target = ts.isPropertyAccessExpression(n.expression) ? n.expression.name : n.expression;
          const sym = checker.getSymbolAtLocation(target);
          const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
          if (!decl || !ts.isFunctionLike(decl)) return;
          const p = decl.parameters?.[i];
          if (!p || !ts.isIdentifier(p.name)) return;
          for (const f of readsOf(decl.body, p.name.text)) extra.add(f);
        });
      }
      ts.forEachChild(n, walk);
    };
    walk(scopeNode);
    return [...extra];
  };

  const record = (name, entry, at) => {
    const prev = channels[name];
    if (!prev) {
      channels[name] = { ...entry, sites: [site(at)] };
      return;
    }
    prev.sites = [...new Set([...prev.sites, site(at)])].sort();
    if (entry.kind !== prev.kind) {
      prev.kind = [...new Set([...prev.kind.split('+'), ...entry.kind.split('+')])].sort().join('+');
    }
    if (entry.direction !== prev.direction) prev.direction = 'both';
    if (entry.payload?.reads?.length) {
      prev.payload = {
        ...prev.payload,
        reads: [...new Set([...(prev.payload?.reads ?? []), ...entry.payload.reads])].sort(),
      };
    }
    if (!prev.payload?.fields && entry.payload?.fields) {
      prev.payload = { ...entry.payload, ...(prev.payload?.reads ? { reads: prev.payload.reads } : {}) };
    }
  };

  for (const file of files) {
    const sf = program.getSourceFile(file);
    if (!sf) continue;

    const visit = (node) => {
      // ── declared message shapes: `interface X { type: typeof NAME; … }` ──────
      if (ts.isInterfaceDeclaration(node) || ts.isTypeLiteralNode(node)) {
        const disc = node.members.find((m) => ts.isPropertySignature(m) && m.name?.getText() === 'type' && m.type);
        if (disc) {
          const t = checker.getTypeAtLocation(disc.type);
          if (t.isStringLiteral?.()) {
            const shape = describeType(checker, checker.getTypeAtLocation(node), node);
            declared[t.value] = {
              fields: (shape.fields ?? []).filter((f) => f.name !== 'type'),
              site: site(node),
            };
          }
        }
      }

      // ── inbound: `switch (m.type) { case NAME: … }` ──────────────────────────
      if (ts.isSwitchStatement(node)) {
        const subj =
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === 'type' &&
          ts.isIdentifier(node.expression.expression)
            ? node.expression.expression.text
            : undefined;
        if (subj) {
          for (const clause of node.caseBlock.clauses) {
            if (!ts.isCaseClause(clause)) continue;
            const name = asLiteral(clause.expression);
            if (!name) continue;
            const reads = [...new Set([...readsOf(clause, subj), ...followCalls(clause, subj)])].sort();
            record(name, { kind: 'message', direction: 'host->app', payload: reads.length ? { reads } : {} }, clause);
          }
        }
      }

      // ── inbound: `m.type === NAME` ──────────────────────────────────────────
      if (
        ts.isBinaryExpression(node) &&
        (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
          node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken) &&
        ts.isPropertyAccessExpression(node.left) &&
        node.left.name.text === 'type' &&
        ts.isIdentifier(node.left.expression)
      ) {
        const name = asLiteral(node.right);
        if (name) {
          const subj = node.left.expression.text;
          // Scope the reads to the enclosing `if` — NOT the enclosing function. One
          // listener typically guards several message types in a row
          // (`iframe.ts:_messageListener` handles `register-frame` and `mount-add`),
          // so a function-wide scan hands every one of them every other one's fields.
          let scope = node;
          while (scope.parent && !ts.isIfStatement(scope.parent) && !ts.isSourceFile(scope.parent)) {
            scope = scope.parent;
          }
          const guard = ts.isIfStatement(scope.parent) ? scope.parent : scope;
          const reads = [...new Set([...readsOf(guard, subj), ...followCalls(guard, subj)])].sort();
          record(name, { kind: 'message', direction: 'host->app', payload: reads.length ? { reads } : {} }, node);
        }
      }

      // ── outbound: `sendMessage(NAME, payload)` ──────────────────────────────
      if (ts.isCallExpression(node)) {
        const callee = ts.isIdentifier(node.expression)
          ? node.expression.text
          : ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : undefined;
        if (callee === 'sendMessage') {
          const name = asLiteral(node.arguments[0]);
          if (name) {
            const arg = node.arguments[1];
            const payload = arg ? describeType(checker, checker.getTypeAtLocation(arg), arg) : { fields: [] };
            record(name, { kind: 'message', direction: 'app->host', payload }, node);
          }
        }
      }

      // ── the `protocol-${scheme}` family ─────────────────────────────────────
      if (ts.isTemplateExpression(node)) {
        const template = node.head.text + node.templateSpans.map((s) => `<scheme>${s.literal.text}`).join('');
        if (template.startsWith('protocol-')) {
          const fam = (dynamicFamilies[template] ??= { schemes: [], sites: [] });
          fam.sites = [...new Set([...fam.sites, site(node)])].sort();
        }
      }

      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  // Declared shapes win over inferred `reads` — they are the authored contract.
  for (const [name, decl] of Object.entries(declared)) {
    const c = channels[name];
    if (!c) continue;
    c.payload = { fields: decl.fields, ...(c.payload?.reads ? { reads: c.payload.reads } : {}) };
    c.sites = [...new Set([...c.sites, decl.site])].sort();
  }

  // Pair each `request-x` poll with the `x` channel it polls, when both exist —
  // the same push/poll pairing the SDK's `createPushChannel` makes explicit.
  for (const name of Object.keys(channels)) {
    if (!name.startsWith('request-')) continue;
    const target = name.slice('request-'.length);
    if (channels[target]) {
      channels[name].kind = 'poll';
      channels[target].kind = 'push';
      channels[target].poll = name;
    }
  }

  // ── the transport envelope every message rides ──────────────────────────────
  // `IFrameParentMessageBus.sendMessage` wraps every outbound payload, and
  // `protocolRequest` adds the request framing. Both are wire facts: `$id` and
  // `codesandbox: true` are how the host recognizes this frame at all.
  const envelopes = {};
  const busSrc = program.getSourceFile(resolve(srcDir, 'protocol/iframe.ts'));
  if (busSrc) {
    const visitBus = (node) => {
      if (ts.isCallExpression(node)) {
        const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : undefined;
        const arg = node.arguments[0];
        if (callee === '_postMessage' && arg && ts.isObjectLiteralExpression(arg)) {
          envelopes.outbound = describeType(checker, checker.getTypeAtLocation(arg), arg);
        }
        if (callee === 'sendMessage' && node.arguments[1] && ts.isObjectLiteralExpression(node.arguments[1])) {
          envelopes.protocolRequest = describeType(
            checker,
            checker.getTypeAtLocation(node.arguments[1]),
            node.arguments[1],
          );
        }
      }
      ts.forEachChild(node, visitBus);
    };
    visitBus(busSrc);
    // The reply-matching fields: what `protocolRequest`'s listener reads off a reply.
    const replyReads = new Set();
    const collectReply = (node) => {
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'msg') {
        replyReads.add(node.name.text);
      }
      ts.forEachChild(node, collectReply);
    };
    collectReply(busSrc);
    if (replyReads.size) envelopes.protocolReply = { reads: [...replyReads].sort() };
  }

  const schemes = Object.keys(channels)
    .filter((n) => n.startsWith('protocol-'))
    .map((n) => n.replace(/^protocol-/, ''))
    .sort();
  for (const fam of Object.values(dynamicFamilies)) fam.schemes = schemes;

  const sorted = {};
  for (const key of Object.keys(channels).sort()) {
    const c = channels[key];
    sorted[key] = {
      kind: c.kind,
      direction: c.direction,
      ...(c.poll ? { poll: c.poll } : {}),
      payload: c.payload ?? {},
      sites: c.sites,
    };
  }

  return { formatVersion: 1, repo: pkgName, channels: sorted, dynamicFamilies, envelopes };
};

// ── comparison (identical rules to the SDK side) ──────────────────────────────
const HAND_KEYS = ['divergent', 'divergentNote'];
const mergeHandKeys = (current, snapshot) => {
  for (const [name, entry] of Object.entries(current.channels)) {
    const prior = snapshot?.channels?.[name];
    if (!prior) continue;
    for (const k of HAND_KEYS) if (k in prior) entry[k] = prior[k];
  }
  return current;
};

const stable = (v) => JSON.stringify(v);

const compare = (current, snapshot) => {
  const removed = [];
  const added = [];
  const changed = [];
  for (const name of Object.keys(snapshot.channels ?? {})) {
    if (!current.channels[name]) removed.push(name);
  }
  for (const name of Object.keys(current.channels)) {
    if (!snapshot.channels?.[name]) added.push(name);
    else if (stable(current.channels[name]) !== stable(snapshot.channels[name])) changed.push(name);
  }
  if (stable(current.dynamicFamilies) !== stable(snapshot.dynamicFamilies ?? {})) {
    changed.push('(dynamic families)');
  }
  if (stable(current.envelopes) !== stable(snapshot.envelopes ?? {})) {
    changed.push('(transport envelope)');
  }
  return { removed, added, changed };
};

// ── main ──────────────────────────────────────────────────────────────────────
const NON_VACUOUS_MIN = 10;

const main = () => {
  const current = extract();
  const count = Object.keys(current.channels).length;
  if (count < NON_VACUOUS_MIN) {
    console.error(
      `error: extracted only ${count} wire names — the extractor is broken or pointed at\n` +
        'the wrong tree. A checker that finds nothing must fail, not pass.',
    );
    process.exit(1);
  }

  const snapshot = existsSync(snapshotPath) ? JSON.parse(readFileSync(snapshotPath, 'utf8')) : null;
  if (!snapshot) {
    console.error(
      'error: @immediately-run/sandbox-protocol is not installed — the wire contract\n' +
        'lives there since R3-274b1. Run `npm ci`.',
    );
    process.exit(1);
  }

  const { removed, added, changed } = compare(mergeHandKeys(current, snapshot), snapshot);
  if (!removed.length && !added.length && !changed.length) {
    console.log(
      `PASS  this frame's source matches @immediately-run/sandbox-protocol@${pkgVersion} ` + `(${count} wire names).`,
    );
    return;
  }
  if (removed.length) {
    console.error('✗ BREAKING: wire names removed or renamed since the snapshot:\n');
    for (const r of removed) console.error(`  - ${r}`);
  }
  if (changed.length) {
    console.error('\n✗ BREAKING: wire payload shapes changed since the snapshot:\n');
    for (const c of changed) {
      console.error(`  ~ ${c}`);
      const was = snapshot.channels?.[c];
      const now = current.channels[c];
      if (was && now) {
        console.error(`      was: ${stable(was.payload)}`);
        console.error(`      now: ${stable(now.payload)}`);
      }
    }
  }
  if (added.length) {
    console.error('\n✗ New wire names are not in the snapshot:\n');
    for (const a of added) console.error(`  + ${a}`);
  }
  console.error(
    '\nThe sandbox↔SDK wire is additive-only (SDK_PACKAGING_SPEC §9,\n' +
      'PLATFORM_LAYERING_SPEC §2): renaming or reshaping a name breaks every app\n' +
      'pinned to an older SDK against a newer frame, and vice versa.\n\n' +
      'If the change is genuinely additive: edit the descriptors in\n' +
      '@immediately-run/sandbox-protocol, publish, and bump the pin here. This repo\n' +
      'cannot bless its own wire change any more — that is the contract, not a chore.',
  );
  process.exit(1);
};

// ── --self-test ───────────────────────────────────────────────────────────────
const patchOf = (relPath, from, to) => patchFile(resolve(srcDir, relPath), from, to);

/** Poison any file the TypeScript program reads — including one inside the pinned
 *  package, which is where a wire name now lives (R3-274b1). Nothing is written to
 *  disk: the extractor's compiler host serves the patched text. */
const patchFile = (abs, from, to) => {
  const text = readFileSync(abs, 'utf8');
  return new Map([[abs, text.replace(from, to)]]);
};

/** The pinned contract's declaration file — where the constants are declared now. */
const CONTRACT_DTS = require.resolve('@immediately-run/sandbox-protocol/sandbox').replace(/\.js$/, '.d.ts');

const selfTest = () => {
  const real = extract();
  const cases = [
    // Since R3-274b1 the wire names live in the PINNED CONTRACT, so a rename arrives
    // from there — a published change this repo's source has not caught up with.
    // That is the cross-repo failure this gate exists to make loud, so it is what the
    // self-test poisons.
    [
      'a RENAMED wire string arriving from the pinned contract',
      patchFile(CONTRACT_DTS, 'export declare const THEME = "theme";', 'export declare const THEME = "host-theme";'),
    ],
    [
      'a RENAMED dispatch-case name arriving from the pinned contract',
      patchFile(
        CONTRACT_DTS,
        'export declare const REPO_MOUNT = "repo-mount";',
        'export declare const REPO_MOUNT = "repository-mount";',
      ),
    ],
    [
      'a payload field made OPTIONAL (name unchanged)',
      // Targets a channel with a DECLARED shape (`ThemeMessage`). Most inbound
      // messages here are handled as `any`, so their snapshot entry is the field
      // NAMES the handler reads — see the R3-274a audit: "no declared inbound
      // types" is itself one of the divergence findings, and R3-274b's descriptors
      // are what finally give every inbound name a type to change.
      patchOf('theme/themeState.ts', '  theme: HostTheme;', '  theme?: HostTheme;'),
    ],
    [
      'a payload field TYPE change (name unchanged)',
      patchOf(
        'theme/themeState.ts',
        "export type HostTheme = 'light' | 'dark';",
        "export type HostTheme = 'light' | 'dark' | 'auto';",
      ),
    ],
    ['a DELETED outbound call site', patchOf('index.ts', 'this.messageBus.sendMessage(REQUEST_MOUNTS_MESSAGE);', '')],
  ];

  let ok = 0;
  for (const [label, patch] of cases) {
    for (const [file, text] of patch) {
      if (text === readFileSync(file, 'utf8')) {
        console.error(`FAIL  self-test case "${label}" no longer patches ${relative(root, file)}`);
        process.exit(1);
      }
    }
    const diff = compare(extract({ patch }), real);
    const caught = diff.removed.length + diff.added.length + diff.changed.length > 0;
    console.log(`${caught ? 'PASS' : 'FAIL'}  detects: ${label}`);
    if (caught) ok++;
  }

  let vacuousCaught = false;
  try {
    vacuousCaught = Object.keys(extract({ files: [] }).channels).length < NON_VACUOUS_MIN;
  } catch {
    vacuousCaught = true;
  }
  console.log(`${vacuousCaught ? 'PASS' : 'FAIL'}  an empty extraction is a failure, not a pass`);
  if (vacuousCaught) ok++;

  const clean = compare(extract(), real);
  const cleanOk = clean.removed.length + clean.added.length + clean.changed.length === 0;
  console.log(`${cleanOk ? 'PASS' : 'FAIL'}  extraction is deterministic (no false positive)`);
  if (cleanOk) ok++;

  const total = cases.length + 2;
  console.log(`\n${ok}/${total} self-test cases.`);
  if (ok !== total) {
    console.error('\nself-test FAILED — the protocol gate is not catching drift it must catch.');
    process.exit(1);
  }
};

// ── --audit <other-snapshot.json>: the cross-repo divergence table ────────────
/*
 * Diff this repo's snapshot against the other side's and classify every name in
 * the UNION. This is R3-274a's deliverable, kept as a SCRIPT rather than a table
 * pasted into a doc: the table has to be re-derivable after every wire change, and
 * a hand-maintained copy of generated data drifts silently.
 *
 * Classes:
 *   agree-declared     both sides DECLARE a shape and the shapes match
 *   divergent-declared both sides declare a shape and they disagree (fields, types,
 *                      or optionality) — two shapes under one name, the class the
 *                      whole S1 guardrail exists to stop
 *   declared-incomplete one side DECLARES a type that names fewer fields than the
 *                      other side reads off the same message — the declaration is
 *                      behind the wire (how `editor-context` lost `viewedFile`)
 *   divergent-reads    at least one side has no declared type, and the field names
 *                      each side touches CONFLICT (each reads something the other
 *                      never does) — a shape disagreement hiding in `any`
 *   subset-reads       same as above, but one side's fields are a strict SUBSET of
 *                      the other's: consistent, just less consumed. Not a bug —
 *                      but nothing forces it to stay consistent, which is why the
 *                      name still needs one owner (Phase 3)
 *   agree-reads        untyped on at least one side, same field names
 *   sdk-only           the SDK mints/consumes it and this frame has no code for it —
 *                      the frame RELAYS it and the host is the other end
 *   sandbox-only       frame↔host only; the SDK never sees it
 */
/**
 * The comparable shape of one channel entry — strictly the MESSAGE level: the
 * declared payload fields, else the field names the side reads off the message.
 *
 * Deliberately NOT the SDK's `value` (a push channel's semantic value, e.g. the
 * `FormFactor` object under `msg.formFactor`): comparing one side's message fields
 * against the other side's value fields manufactures divergences that do not exist
 * — both sides read `msg.formFactor`; only one of them names what is inside it.
 */
const fieldNames = (entry) => {
  const payload = entry?.payload;
  if (payload?.fields) return { names: payload.fields.map((f) => f.name).sort(), typed: true };
  if (payload?.reads) return { names: [...payload.reads].sort(), typed: false };
  return { names: [], typed: false };
};

const typeSig = (entry) => {
  const fields = entry?.payload?.fields;
  return fields ? JSON.stringify(fields.map((f) => [f.name, f.optional, f.type ?? f.union ?? f.fields])) : null;
};

const audit = (otherPath) => {
  if (!existsSync(otherPath)) {
    console.error(`error: ${otherPath} not found — pass the OTHER repo's protocol-snapshot.json.`);
    process.exit(1);
  }
  const mine = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  const other = JSON.parse(readFileSync(otherPath, 'utf8'));
  const names = [...new Set([...Object.keys(mine.channels), ...Object.keys(other.channels)])].sort();

  const rows = [];
  for (const name of names) {
    const a = mine.channels[name];
    const b = other.channels[name];
    if (a && !b) {
      rows.push([name, 'sandbox-only', a.kind, a.direction, '']);
      continue;
    }
    if (!a && b) {
      rows.push([name, 'sdk-only', b.kind, b.direction, '']);
      continue;
    }
    const fa = fieldNames(a);
    const fb = fieldNames(b);
    const setA = new Set(fa.names);
    const setB = new Set(fb.names);
    const onlyA = fa.names.filter((n) => !setB.has(n));
    const onlyB = fb.names.filter((n) => !setA.has(n));
    // Backticked: this table is pasted into the MDX roadmap item, where a bare
    // `{a,b}` is parsed as an MDX expression and fails the corpus safe-surface check.
    const show = `${mine.repo}: \`{${fa.names.join(',')}}\` vs ` + `${other.repo}: \`{${fb.names.join(',')}}\``;
    let cls;
    let note = '';
    if (fa.typed && fb.typed) {
      const same = !onlyA.length && !onlyB.length && typeSig(a) === typeSig(b);
      cls = same ? 'agree-declared' : 'divergent-declared';
      if (!same) note = onlyA.length || onlyB.length ? show : 'same fields, different types/optionality';
    } else if (onlyA.length && onlyB.length) {
      cls = 'divergent-reads';
      note = show;
    } else if ((fa.typed && onlyB.length) || (fb.typed && onlyA.length)) {
      // The side that DECLARES a type names fewer fields than the other side
      // actually touches — the declaration does not cover what the wire carries.
      cls = 'declared-incomplete';
      note = show;
    } else if (onlyA.length || onlyB.length) {
      cls = 'subset-reads';
      note = show;
    } else {
      cls = 'agree-reads';
    }
    if (a.kind !== b.kind) {
      note = note ? `${note}; kind ${a.kind} vs ${b.kind}` : `kind ${a.kind} vs ${b.kind}`;
    }
    rows.push([name, cls, a.kind, a.direction, note]);
  }

  const counts = {};
  for (const [, cls] of rows) counts[cls] = (counts[cls] ?? 0) + 1;

  console.log('| wire name | class | kind | direction | note |');
  console.log('|---|---|---|---|---|');
  for (const [name, cls, kind, dir, note] of rows) {
    console.log(`| \`${name}\` | ${cls} | ${kind} | ${dir} | ${note} |`);
  }
  console.log(
    `\n${rows.length} names over the union of ${mine.repo} (${Object.keys(mine.channels).length}) ` +
      `and ${other.repo} (${Object.keys(other.channels).length}): ` +
      Object.entries(counts)
        .sort()
        .map(([k, v]) => `${k} ${v}`)
        .join(', '),
  );
  const divergent = rows
    .filter(([, c]) => c === 'divergent-declared' || c === 'divergent-reads' || c === 'declared-incomplete')
    .map(([n]) => n);
  console.log(
    divergent.length
      ? `\nMark \`divergent: true\` in BOTH snapshots for: ${divergent.join(', ')}`
      : '\nNo conflicting shapes found.',
  );
};

const auditIdx = process.argv.indexOf('--audit');
if (auditIdx !== -1) audit(resolve(process.cwd(), process.argv[auditIdx + 1] ?? ''));
else if (process.argv.includes('--self-test')) selfTest();
else main();
