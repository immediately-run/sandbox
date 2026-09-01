// The working-tree `fs-change` admission rules.
//
// This frame recompiles on every batch it accepts, so accepting one it has already
// applied is a feedback loop waiting for a partner — and it had one: site-main's
// channel router replayed the cached `fs-change` on every re-register, and one
// keystroke put a production preview into ~7 full compiles per second, permanently
// (2026-09-01).
//
// Both halves are covered here on purpose. `decideWorktreeBatch` is the arithmetic;
// `FsChangeGate` is what the message handler actually calls, and an adversarial
// review of the first version of this change showed why that distinction matters:
// the whole suite stayed green with the frame's WIRING gutted (verdict computed and
// discarded), because only the pure function had tests. The gate carries the memory,
// so gutting it now fails here.
import { decideWorktreeBatch, FsChangeGate, type FsChangeAdmissionInput } from './fsChange';

const batch = (paths: string[], epoch?: number): FsChangeAdmissionInput => ({ paths, epoch });
/** A batch from a host that does not speak `epoch` (or speaks it badly). */
const untyped = (v: unknown): FsChangeAdmissionInput => v as FsChangeAdmissionInput;

describe('decideWorktreeBatch', () => {
  it('applies a fresh batch and reports the epoch to remember', () => {
    expect(decideWorktreeBatch(batch(['/src/App.tsx'], 7), undefined)).toEqual({ apply: true, epoch: 7 });
    expect(decideWorktreeBatch(batch(['/src/App.tsx'], 8), 7)).toEqual({ apply: true, epoch: 8 });
  });

  it('drops a re-announcement of the batch it last applied — the loop breaker', () => {
    expect(decideWorktreeBatch(batch(['/src/App.tsx'], 7), 7)).toEqual({ apply: false, reason: 'duplicate-epoch' });
  });

  it('drops an empty batch: it invalidates nothing and the compile finds no changes', () => {
    expect(decideWorktreeBatch(batch([], 3), undefined)).toEqual({ apply: false, reason: 'empty' });
    expect(decideWorktreeBatch(untyped({ epoch: 3 }), undefined)).toEqual({ apply: false, reason: 'empty' });
  });

  // The reason the duplicate test is EQUALITY and not `epoch <= lastApplied`: the
  // host legitimately delivers an OLDER batch after a newer one. `ChannelRouter`
  // queues while the frame is not ready, but readiness is a ref assigned during
  // render and `flush()` runs in a later effect — so a push in that window is
  // dispatched directly (newer) while the older one arrives on the next flush.
  // Under an ordering guard that older batch is dropped, and a dropped batch is
  // never re-transformed by any later compile, so its paths go DURABLY stale.
  it('still applies a batch whose epoch went BACKWARDS (an older queued batch flushed late)', () => {
    expect(decideWorktreeBatch(batch(['/src/App.tsx'], 1), 42)).toEqual({ apply: true, epoch: 1 });
  });

  // Fail towards applying: an extra compile is cheap, a missed edit is durable.
  it('applies when the host sends no usable epoch at all', () => {
    expect(decideWorktreeBatch(untyped({ paths: ['/a.ts'] }), 5)).toEqual({ apply: true, epoch: undefined });
    expect(decideWorktreeBatch(untyped({ paths: ['/a.ts'], epoch: 'nope' }), 5)).toEqual({
      apply: true,
      epoch: undefined,
    });
    expect(decideWorktreeBatch(untyped({ paths: ['/a.ts'], epoch: NaN }), 5)).toEqual({
      apply: true,
      epoch: undefined,
    });
  });
});

describe('FsChangeGate — the admission the frame actually performs', () => {
  it('admits a fresh batch and refuses the replay of the one it just admitted', () => {
    const gate = new FsChangeGate();
    expect(gate.admit(batch(['/content/a.mdx'], 1))).toBe(true);
    expect(gate.admit(batch(['/content/a.mdx'], 1))).toBe(false);
  });

  it('refuses the same epoch however many times it is replayed — the loop breaker', () => {
    const gate = new FsChangeGate();
    let admitted = 0;
    for (let i = 0; i < 50; i++) if (gate.admit(batch(['/content/a.mdx'], 1))) admitted++;
    expect(admitted).toBe(1);
  });

  it('admits each genuinely new batch in a normal typing run', () => {
    const gate = new FsChangeGate();
    const admitted = [1, 2, 3, 4, 5].filter((e) => gate.admit(batch(['/content/a.mdx'], e)));
    expect(admitted).toEqual([1, 2, 3, 4, 5]);
  });

  // An epoch-less batch must not ERASE the memory: if it did, the next replay of an
  // already-applied batch would compare against nothing, be admitted, and re-open
  // the loop after a single batch from an older host.
  it('keeps the last known-good epoch across an epoch-less batch, so the loop stays shut', () => {
    const gate = new FsChangeGate();
    expect(gate.admit(batch(['/content/a.mdx'], 5))).toBe(true);
    expect(gate.admit(untyped({ paths: ['/content/b.mdx'] }))).toBe(true); // no epoch — applied
    expect(gate.admit(batch(['/content/a.mdx'], 5))).toBe(false); // replay of 5 still refused
  });

  it('refuses an empty batch without disturbing the memory', () => {
    const gate = new FsChangeGate();
    expect(gate.admit(batch(['/content/a.mdx'], 5))).toBe(true);
    expect(gate.admit(batch([], 6))).toBe(false);
    expect(gate.admit(batch(['/content/a.mdx'], 5))).toBe(false);
    expect(gate.admit(batch(['/content/a.mdx'], 6))).toBe(true);
  });

  it('gates are independent — one frame’s history never suppresses another’s', () => {
    const a = new FsChangeGate();
    const b = new FsChangeGate();
    expect(a.admit(batch(['/x.ts'], 1))).toBe(true);
    expect(b.admit(batch(['/x.ts'], 1))).toBe(true);
  });
});
