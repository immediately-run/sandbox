/**
 * @jest-environment jsdom
 *
 * `IFrameParentMessageBus` — the frame's window-level intake.
 *
 * Two things are proven here:
 *
 * 1. **register-frame handshake parsing** — the §5.2 dirty set rides IInitConfig
 *    alongside sdkIntegrity (PRETRANSPILED_ARTIFACTS_SPEC §5.2).
 * 2. **Cross-frame capability theft is closed (R3-352)** — the bus is bound to
 *    `window.parent`, so a hostile SIBLING frame cannot forge the messages that
 *    carry authority into this frame. Any iframe on a page can reach any other
 *    (`window.parent.frames[i]`, and `postMessage` is legal cross-origin), so
 *    before R3-352 a malicious app in one frame could hand a privileged frame a
 *    filesystem of its own and have it evaluated in that frame's realm.
 *
 * The hostile source here is a REAL second frame's `contentWindow`, not a
 * hand-made sentinel — the thing an attacker actually has.
 */
import { IFrameParentMessageBus } from './iframe';

/** A stand-in for a transferred `MessagePort`. `close` is a spy because "the
 *  refused handshake's ports are closed, not silently orphaned" is part of the
 *  contract (a refusal must fail fast, never hang). */
const fakePort = () => ({ start: jest.fn(), close: jest.fn() } as unknown as MessagePort);

/** Deliver a window message AS THE PARENT — what the sandpack client does. */
const fromParent = (data: Record<string, unknown>, ports: MessagePort[] = []) =>
  window.dispatchEvent(new MessageEvent('message', { data, ports, source: window.parent as Window }));

/** Deliver the same message AS A SIBLING FRAME — what a hostile app can do. */
const fromHostileFrame = (data: Record<string, unknown>, ports: MessagePort[] = []) => {
  const iframe = document.createElement('iframe');
  document.body.appendChild(iframe);
  window.dispatchEvent(new MessageEvent('message', { data, ports, source: iframe.contentWindow as Window }));
  return iframe;
};

const registerFrame = (extra: Record<string, unknown> = {}, ports: MessagePort[] = []) =>
  fromParent({ type: 'register-frame', id: 'frame-1', template: 'react', ...extra }, ports);

/** Resolve to `null` instead of hanging when a promise is never settled — the
 *  assertion for "the frame ignored it" is a NON-event, so it needs a bound. */
const settledOr = async <T>(p: Promise<T>): Promise<T | null> =>
  Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), 0))]);

describe('IFrameParentMessageBus register-frame', () => {
  it('reads dirtyPaths into the init config', async () => {
    const bus = new IFrameParentMessageBus();
    registerFrame({ dirtyPaths: ['/src/App.tsx', '/src/old.ts'] });
    const config = await bus.getInitConfig();
    expect(config.dirtyPaths).toEqual(['/src/App.tsx', '/src/old.ts']);
    expect(config.template).toBe('react');
  });

  it('leaves dirtyPaths undefined when the host omits it', async () => {
    const bus = new IFrameParentMessageBus();
    registerFrame({});
    const config = await bus.getInitConfig();
    expect(config.dirtyPaths).toBeUndefined();
  });

  it('reads the chrome region into the init config (R3-114)', async () => {
    const bus = new IFrameParentMessageBus();
    registerFrame({ region: 'stage.conversation' });
    const config = await bus.getInitConfig();
    expect(config.region).toBe('stage.conversation');
  });

  it('leaves region undefined for standalone / older hosts', async () => {
    const bus = new IFrameParentMessageBus();
    registerFrame({});
    const config = await bus.getInitConfig();
    expect(config.region).toBeUndefined();
  });

  it('adopts the transferred fs and babel ports, in wire order', async () => {
    const bus = new IFrameParentMessageBus();
    const fs = fakePort();
    const babel = fakePort();
    registerFrame({}, [fs, babel]);
    await expect(bus.getFsPort()).resolves.toBe(fs);
    await expect(bus.getBabelPort()).resolves.toBe(babel);
    expect(fs.start).toHaveBeenCalled();
    expect(babel.start).toHaveBeenCalled();
  });
});

describe('IFrameParentMessageBus is bound to the parent (R3-352)', () => {
  it('ignores a register-frame forged by a sibling frame — no config, no ports', async () => {
    const bus = new IFrameParentMessageBus();
    const stolen = fakePort();
    fromHostileFrame({ type: 'register-frame', id: 'evil', template: 'react' }, [stolen]);

    // The negative space: nothing resolved, nothing started, nothing adopted.
    await expect(settledOr(bus.getInitConfig())).resolves.toBeNull();
    await expect(settledOr(bus.getFsPort())).resolves.toBeNull();
    expect(stolen.start).not.toHaveBeenCalled();
    expect(bus.droppedForeignMessages).toBe(1);

    // ...and the frame is still registerable by its REAL parent afterwards: the
    // hostile attempt must not have consumed the single-shot latch.
    const fs = fakePort();
    registerFrame({ template: 'vanilla' }, [fs]);
    await expect(bus.getFsPort()).resolves.toBe(fs);
    await expect(bus.getInitConfig()).resolves.toMatchObject({ template: 'vanilla' });
  });

  it('ignores a mount-add forged by a sibling frame — it never reaches a handler', () => {
    const bus = new IFrameParentMessageBus();
    const seen: unknown[] = [];
    bus.onMessage((m: unknown) => void seen.push(m));
    registerFrame(); // the frame is live and talking to its real parent

    fromHostileFrame({ codesandbox: true, type: 'mount-add', mount: { path: '/app' } }, [fakePort()]);

    // The gate IS the chokepoint: the message never reaches `handleParentMessage`,
    // so `handleMountAdd` — and the mount table — are never touched at all.
    expect(seen).toEqual([]);
    expect(bus.droppedForeignMessages).toBe(1);
  });

  it.each([
    ['fs-change', { codesandbox: true, type: 'fs-change', paths: ['/index.tsx'] }],
    ['refresh', { codesandbox: true, type: 'refresh' }],
    ['mount-remove', { codesandbox: true, type: 'mount-remove', id: '/mnt/abc' }],
    ['repo-mount', { codesandbox: true, type: 'repo-mount', path: '/mnt/abc' }],
  ])('ignores a forged %s from a sibling frame', (_name, message) => {
    const bus = new IFrameParentMessageBus();
    const seen: unknown[] = [];
    bus.onMessage((m: unknown) => void seen.push(m));
    registerFrame();

    fromHostileFrame(message);

    expect(seen).toEqual([]);
    expect(bus.droppedForeignMessages).toBe(1);
  });

  it('counts repeated probes without unbounded logging', () => {
    const bus = new IFrameParentMessageBus();
    for (let i = 0; i < 5; i++) fromHostileFrame({ codesandbox: true, type: 'fs-change', paths: [] });
    expect(bus.droppedForeignMessages).toBe(5);
  });

  it('still delivers the parent-originated flows unchanged', () => {
    const bus = new IFrameParentMessageBus();
    const seen: any[] = [];
    bus.onMessage((m: any) => void seen.push(m));
    registerFrame();

    const port = fakePort();
    fromParent({ codesandbox: true, type: 'mount-add', mount: { path: '/mnt/abc' } }, [port]);
    fromParent({ codesandbox: true, type: 'fs-change', paths: ['/index.tsx'] });
    fromParent({ codesandbox: true, type: 'request-mounts' });

    expect(seen.map((m) => m.type)).toEqual(['mount-add', 'fs-change', 'request-mounts']);
    // `mount-add`'s transferred ports are still attached for the mount handler.
    expect(seen[0].ports).toEqual([port]);
    expect(bus.droppedForeignMessages).toBe(0);
  });

  it('still drops parent messages that are not codesandbox protocol traffic', () => {
    const bus = new IFrameParentMessageBus();
    const seen: unknown[] = [];
    bus.onMessage((m: unknown) => void seen.push(m));
    fromParent({ type: 'some-unrelated-host-chatter' });
    expect(seen).toEqual([]);
    // Not a foreign source — it came from the parent, it just isn't ours.
    expect(bus.droppedForeignMessages).toBe(0);
  });
});

describe('register-frame is single-shot (R3-352)', () => {
  it('keeps the ORIGINAL ports and config when a second register-frame arrives', async () => {
    const bus = new IFrameParentMessageBus();
    const fs = fakePort();
    const babel = fakePort();
    registerFrame({ template: 'react', region: 'stage.conversation' }, [fs, babel]);
    const firstConfig = await bus.getInitConfig();

    const swappedFs = fakePort();
    const swappedBabel = fakePort();
    registerFrame({ id: 'frame-2', template: 'vanilla', region: 'chrome.editor' }, [swappedFs, swappedBabel]);

    // Identity, not shape: the point is that the LIVE ports did not move.
    await expect(bus.getFsPort()).resolves.toBe(fs);
    await expect(bus.getBabelPort()).resolves.toBe(babel);
    await expect(bus.getInitConfig()).resolves.toBe(firstConfig);
    expect(firstConfig.template).toBe('react');
    expect(firstConfig.region).toBe('stage.conversation');

    // The duplicate's ports were never adopted, and were closed rather than left
    // as a channel the sender waits on forever.
    expect(swappedFs.start).not.toHaveBeenCalled();
    expect(swappedBabel.start).not.toHaveBeenCalled();
    expect(swappedFs.close).toHaveBeenCalled();
    expect(swappedBabel.close).toHaveBeenCalled();
  });

  it('does not re-fire resolvers that are still pending on the first registration', async () => {
    const bus = new IFrameParentMessageBus();
    const resolved: MessagePort[] = [];
    void bus.getFsPort().then((p) => void resolved.push(p));

    const fs = fakePort();
    registerFrame({}, [fs]);
    registerFrame({ id: 'frame-2' }, [fakePort()]);
    await Promise.resolve();

    expect(resolved).toEqual([fs]);
  });

  it('keeps the parent id of the FIRST registration on outbound messages', () => {
    const bus = new IFrameParentMessageBus();
    const posted: any[] = [];
    jest.spyOn(window.parent, 'postMessage').mockImplementation(((m: any) => void posted.push(m)) as any);
    try {
      registerFrame({ id: 42 });
      registerFrame({ id: 99 });
      bus.sendMessage('status', { status: 'idle' });
    } finally {
      (window.parent.postMessage as jest.Mock).mockRestore();
    }
    expect(posted).toHaveLength(1);
    expect(posted[0].$id).toBe(42);
  });
});
