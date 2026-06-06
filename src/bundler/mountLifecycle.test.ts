import { MountLifecycle, type MountContext, type MountAction } from './mountLifecycle';

const ctx = (over: Partial<MountContext> = {}): MountContext => ({
  path: '/app',
  isAppRoot: true,
  ...over,
});

describe('MountLifecycle', () => {
  it('runs registered onMount actions in order with the context', async () => {
    const seen: string[] = [];
    const lc = new MountLifecycle();
    lc.register({ name: 'a', onMount: (c) => void seen.push(`a:${c.path}`) });
    lc.register({ name: 'b', onMount: (c) => void seen.push(`b:${c.path}`) });
    await lc.runMount(ctx({ path: '/mnt/x' }));
    expect(seen).toEqual(['a:/mnt/x', 'b:/mnt/x']);
  });

  it('isolates a throwing action — others still run, mount not broken', async () => {
    const seen: string[] = [];
    const lc = new MountLifecycle();
    lc.register({ name: 'boom', onMount: () => { throw new Error('kaboom'); } });
    lc.register({ name: 'ok', onMount: () => void seen.push('ok') });
    await expect(lc.runMount(ctx())).resolves.toBeUndefined();
    expect(seen).toEqual(['ok']);
  });

  it('lets an action scope itself via the context (e.g. isAppRoot-only)', async () => {
    const scanned: string[] = [];
    const lc = new MountLifecycle();
    const mdxLike: MountAction = {
      name: 'mdx',
      onMount: (c) => {
        if (c.isAppRoot) scanned.push(c.path);
      },
    };
    lc.register(mdxLike);
    await lc.runMount(ctx({ path: '/app', isAppRoot: true }));
    await lc.runMount(ctx({ path: '/mnt/space', isAppRoot: false }));
    expect(scanned).toEqual(['/app']); // the space mount was skipped by the action
  });

  it('runs onUnmount in reverse order, best-effort', async () => {
    const order: string[] = [];
    const lc = new MountLifecycle();
    lc.register({ name: 'a', onMount: () => {}, onUnmount: () => void order.push('a') });
    lc.register({ name: 'b', onMount: () => {}, onUnmount: () => void order.push('b') });
    await lc.runUnmount(ctx());
    expect(order).toEqual(['b', 'a']); // reverse of registration
  });

  it('tolerates actions without an onUnmount', async () => {
    const lc = new MountLifecycle();
    lc.register({ name: 'a', onMount: () => {} }); // no onUnmount
    await expect(lc.runUnmount(ctx())).resolves.toBeUndefined();
  });
});
