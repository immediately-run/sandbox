/**
 * The frame's half of the R3-274e1 cross-side proof.
 *
 * `protocol:check` already proves this repo's source matches the pinned contract. What
 * it cannot prove is that this side and the SDK agree with EACH OTHER: the two snapshots
 * are projections of one descriptor set, so they agree by construction until someone
 * edits the descriptors — and then they disagree quietly, because nothing reads both.
 *
 * So both repos drive the SAME object, published once as
 * `@immediately-run/sandbox-protocol/fixtures`. The SDK has the mirror of this file
 * (`test/wireFixtures.test.ts`). Deleting a field from a fixture must fail BOTH; if it
 * only fails one, the fixture stopped being a cross-side proof and became two
 * independent assertions that happened to agree.
 *
 * Two things are checked per name, and both are needed:
 *   1. the fixture conforms to THIS side's declared shape (`shapeProblems`), and
 *   2. this side's REAL parser accepts it and surfaces what it reads.
 * (1) alone would only re-check the snapshot against itself; (2) alone would pass on a
 * parser that quietly ignores a field the wire carries.
 */
import type { ProtocolSnapshot, WireShape } from '@immediately-run/sandbox-protocol';
import { WIRE_FIXTURES, shapeProblems } from '@immediately-run/sandbox-protocol/fixtures';
import snapshot from '@immediately-run/sandbox-protocol/snapshots/sandbox';

import { EditorContextService } from '../editor/EditorContextService';
import { EDITOR_CONTEXT_MESSAGE, EditorContextMessage } from '../editor/editorContextState';
import { underAppRoot } from '../fsLayout';
import { EDITOR_CONTEXT, FS_CHANGE, SDK_HANDSHAKE } from '../generated/protocol';
import { Emitter } from '../utils/emitter';
import { FsChangeMessage } from './fsChange';
import { IFrameParentMessageBus } from './iframe';
import { handshakePayload } from './version';

const snap = snapshot as unknown as ProtocolSnapshot;

/** Every shape this side declares for a name that carries structure. */
const declaredShapes = (name: string): WireShape[] => {
  const c = snap.channels[name];
  return [c.payload, c.value].filter((s): s is WireShape => !!s?.fields);
};

const expectConformant = (name: string) => {
  const shapes = declaredShapes(name);
  // Guard the vacuous pass: a fixture checked against zero shapes asserts nothing.
  expect(shapes.length).toBeGreaterThan(0);
  for (const shape of shapes) {
    expect({ name, problems: shapeProblems(shape, WIRE_FIXTURES[name]) }).toEqual({
      name,
      problems: [],
    });
  }
};

describe('the shared wire fixture conforms to this frame’s declarations', () => {
  it.each(['fs-change', 'editor-context', 'sdk-handshake'])('%s', (name) => {
    expectConformant(name);
  });

  it('the fixture names are the ones this frame speaks, spelled by its own constants', () => {
    // Catches a rename landing on one side only: the constants come from the pinned
    // contract, the fixture keys from the same package, and this frame's dispatch
    // switches on the constants.
    expect(Object.keys(WIRE_FIXTURES).sort()).toEqual([EDITOR_CONTEXT, FS_CHANGE, SDK_HANDSHAKE].sort());
  });
});

describe('this frame’s real parsers accept the shared fixture', () => {
  it('editor-context: EditorContextService caches what it reads, ignores what it does not', () => {
    const emitter = new Emitter<unknown>();
    const bus = { onMessage: emitter.event } as unknown as IFrameParentMessageBus;
    const service = new EditorContextService(bus);

    const fixture = WIRE_FIXTURES['editor-context'] as unknown as Omit<EditorContextMessage, 'type'>;
    emitter.fire({ type: EDITOR_CONTEXT_MESSAGE, ...fixture });

    // The frame deliberately caches a SUBSET (the SDK is the side that surfaces all
    // four to apps) — so this asserts the subset exactly, not the whole message. A
    // frame that started caching `openFiles` would fail here and have to say so.
    expect(service.getContext()).toEqual({
      dirtyPaths: fixture.dirtyPaths,
      activeFile: fixture.activeFile,
    });
  });

  it('editor-context: the two fields the frame does NOT cache still travel', () => {
    // The point of R3-274e: the declaration describes the message, not the reader's
    // appetite. If these ever stop being on the wire, this fails even though the
    // frame's own cache would not notice.
    const fixture = WIRE_FIXTURES['editor-context'];
    expect(Object.keys(fixture)).toEqual(expect.arrayContaining(['openFiles', 'viewedFile']));
  });

  it('fs-change: the paths anchor under APP_ROOT, and epoch survives being unread', () => {
    const fixture = WIRE_FIXTURES['fs-change'] as unknown as Omit<FsChangeMessage, 'type'>;
    // The frame's actual transformation of this message (src/index.ts FS_CHANGE case):
    // repo-relative in, APP_ROOT-anchored out.
    const anchored = fixture.paths.map((p) => underAppRoot(p));
    expect(anchored).toHaveLength(fixture.paths.length);
    for (const p of anchored) expect(p.startsWith('/')).toBe(true);
    // `epoch` is declared and not read here. That is the divergence R3-274e closed, so
    // assert it is genuinely present rather than letting "unread" drift to "absent".
    expect(typeof fixture.epoch).toBe('number');
  });

  it('sdk-handshake: what this frame PRODUCES fits the same shape the fixture does', () => {
    // This name is the one the frame sends rather than receives, so the parser under
    // test is the producer. Two legitimate producers share the name — the frame
    // announces the versions it owns, the SDK its own — which is why every field is
    // optional. A producer emitting something outside the union is the failure.
    const produced = handshakePayload() as unknown as Record<string, unknown>;
    for (const shape of declaredShapes('sdk-handshake')) {
      expect(shapeProblems(shape, produced)).toEqual([]);
    }
    // And the frame really does populate its own field — an all-empty payload would
    // also conform, every field being optional.
    expect(typeof produced.sandboxProtocolVersion).toBe('string');
  });
});

describe('the fixture is falsifiable on THIS side too', () => {
  // Without this, the suite above would pass against a validator that returns [] for
  // everything, and the cross-side claim would be vacuous here even while it holds in
  // the protocol package.
  it('a fixture missing a declared field is rejected by this side', () => {
    const broken = { ...WIRE_FIXTURES['fs-change'] } as Record<string, unknown>;
    delete broken.epoch;
    const problems = declaredShapes('fs-change').flatMap((s) => shapeProblems(s, broken));
    expect(problems).toContain('$.epoch: required by the declaration, absent');
  });

  it('a fixture missing a field the SDK reads is rejected there — same deletion', () => {
    // Documented here so the pair is visible from one file: this same deletion trips
    // the SDK's `value.fields` AND its `payload.reads`. See the SDK's mirror test.
    const sdkReads = ['epoch', 'paths'];
    for (const key of sdkReads) {
      expect(Object.prototype.hasOwnProperty.call(WIRE_FIXTURES['fs-change'], key)).toBe(true);
    }
  });
});
