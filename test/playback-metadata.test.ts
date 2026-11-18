import assert from 'node:assert/strict';
import test from 'node:test';
import { PlaybackMetadataController, type PlaybackMetadataContext } from '../client/multiview/playbackMetadata';
import { PlaybackRequestPool } from '../client/multiview/playbackRequestPool';
import type { PlaybackInfo } from '../shared/playback';

const flush = async () => { for (let i = 0; i < 18; i++) await Promise.resolve(); };
function clock() {
  let now = 0, next = 0;
  const timers = new Map<number, { at: number; run(): void }>();
  return { now: () => now,
    setTimeout(run: () => void, ms: number) { const id = ++next; timers.set(id, { at: now + ms, run }); return id; },
    clearTimeout(id: unknown) { timers.delete(id as number); },
    size: () => timers.size,
    async advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...timers].filter(([, task]) => task.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at; timers.delete(due[0]); due[1].run(); await flush();
      }
      now = until; await flush();
    },
  };
}
const context = (change: Partial<PlaybackMetadataContext> = {}): PlaybackMetadataContext => ({
  identityScope: 'account:1', rpcScope: 'worker:1', quality: 250,
  needed: true, visible: true, online: true, menuOpen: false, ...change,
});
const info = (qn = 250, at = 0, actual = qn): PlaybackInfo => ({ roomId: '1', status: 'live', requestedQuality: qn,
  sources: [{ id: `cdn-${actual}`, actualQuality: actual, protocol: 'flv', format: 'flv', codec: 'avc',
    url: `https://cdn.bilivideo.com/${actual}`, expiresAt: at + 120_000 }],
  qualities: [{ qn, label: `画质${qn}` }], resolvedAt: at });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('ordinary playback descriptions survive TTL and wake events without speculative requests', async () => {
  const timer = clock(); let calls = 0;
  const controller = new PlaybackMetadataController({ roomId: '1', clock: timer,
    resolve: async qn => { calls++; return info(qn, timer.now()); } });
  controller.setContext(context({ needed: false })); controller.observe(info());
  controller.setContext(context()); await flush();
  assert.equal(calls, 0); assert.equal(controller.getSnapshot().stale, false);
  await timer.advance(90_000); assert.equal(calls, 0);
  controller.wake(); await flush(); assert.equal(calls, 0);
  assert.equal(controller.getSnapshot().info?.qualities[0].label, '画质250');
  await controller.ensureRoutes(250); assert.equal(calls, 1);
  controller.dispose(); assert.equal(timer.size(), 0);
});

test('inherited descriptions never provide current-identity route cache entries or replace verified routes', async () => {
  const timer = clock(); let calls = 0;
  const controller = new PlaybackMetadataController({ roomId: '1', clock: timer, resolve: async qn => {
    calls++; return { ...info(qn, timer.now()), message: 'personal routes' };
  } });
  controller.setContext(context({ needed: false }));
  controller.observeDescription({ ...info(), message: 'anonymous description' });
  await flush(); assert.equal(calls, 0);
  controller.setContext(context({ menuOpen: true })); await flush();
  assert.equal(calls, 1); assert.equal(controller.getSnapshot().stale, false);
  assert.equal(controller.getSnapshot().info?.message, 'personal routes');
  const routes = await controller.ensureRoutes(250); assert.equal(calls, 1); assert.equal(routes.message, 'personal routes');
  controller.observeDescription({ ...info(), message: 'late anonymous description' });
  assert.equal((await controller.ensureRoutes(250)).message, 'personal routes'); assert.equal(calls, 1);
  await timer.advance(90_000); controller.wake(); await flush(); assert.equal(calls, 1);
  controller.dispose(); assert.equal(timer.size(), 0);
});

test('same-account worker renewal retains names and only replaces routes on explicit demand', async () => {
  const timer = clock(), pending = deferred<PlaybackInfo>(); let calls = 0, oldSignal: AbortSignal | undefined;
  const controller = new PlaybackMetadataController({ roomId: '1', clock: timer, resolve: (qn, signal) => {
    calls++; if (calls === 1) { oldSignal = signal; return pending.promise; }
    return Promise.resolve(info(qn, timer.now()));
  } });
  controller.setContext(context({ needed: false })); controller.observe(info(250));
  await timer.advance(31_000); controller.setContext(context()); await flush();
  assert.equal(calls, 0);
  const oldRequest = controller.ensureRoutes(250); const oldRejection = assert.rejects(oldRequest, { name: 'AbortError' });
  await flush();
  assert.equal(controller.getSnapshot().state, 'loading');
  controller.setContext(context({ rpcScope: 'worker:2' }));
  assert.equal(controller.getSnapshot().info?.qualities[0].label, '画质250');
  assert.equal(oldSignal!.aborted, true); await oldRejection; await flush(); assert.equal(calls, 1);
  await controller.ensureRoutes(250); assert.equal(calls, 2);
  pending.resolve({ ...info(), message: 'stale result' }); await flush();
  assert.equal(controller.getSnapshot().info?.message, undefined);
  assert.equal(controller.getSnapshot().state, 'ready'); controller.dispose();
});

test('true logout/account/permission change clears old information before replacement resolves', async () => {
  const timer = clock(), next = deferred<PlaybackInfo>();
  const controller = new PlaybackMetadataController({ roomId: '1', clock: timer, resolve: () => next.promise });
  controller.setContext(context({ needed: false })); controller.observe(info());
  controller.setContext(context({ identityScope: 'anonymous:permission2', rpcScope: 'anonymous' }));
  assert.equal(controller.getSnapshot().info, undefined); await flush();
  controller.observe(info(10000), 'worker:1'); assert.equal(controller.getSnapshot().info, undefined);
  next.resolve(info()); await flush(); assert.equal(controller.getSnapshot().info?.requestedQuality, 250);
  controller.dispose();
});

test('closing demand/background cancels loading immediately and foreground starts a replacement', async () => {
  const timer = clock(), pending = deferred<PlaybackInfo>(); let calls = 0, aborted = false;
  const controller = new PlaybackMetadataController({ roomId: '1', clock: timer, resolve: (qn, signal) => {
    calls++; signal.addEventListener('abort', () => { aborted = true; });
    return calls === 1 ? pending.promise : Promise.resolve(info(qn, timer.now()));
  } });
  controller.setContext(context()); await flush();
  controller.setContext(context({ visible: false })); assert.equal(aborted, true);
  assert.equal(controller.getSnapshot().state, 'idle'); assert.equal(timer.size(), 0);
  controller.setContext(context()); await flush(); assert.equal(calls, 2);
  pending.resolve(info(10000)); await flush(); assert.equal(controller.getSnapshot().info?.requestedQuality, 250);
  controller.dispose();
});

test('an open empty menu retries failed initialization while closed menus leave no retry timers', async () => {
  const timer = clock(); let calls = 0;
  const controller = new PlaybackMetadataController({ roomId: '1', clock: timer,
    resolve: qn => ++calls === 1 ? new Promise(() => {}) : Promise.resolve(info(qn, timer.now())) });
  controller.setContext(context({ menuOpen: true })); await flush(); await timer.advance(15_000);
  assert.equal(controller.getSnapshot().state, 'error'); assert.equal(controller.getSnapshot().retryAt, 17_000);
  await timer.advance(2_000); assert.equal(calls, 2); assert.equal(controller.getSnapshot().state, 'ready');
  controller.dispose(); assert.equal(timer.size(), 0);
});

test('closing an empty failed menu cancels retry demand until the next explicit opening', async () => {
  const timer = clock(); let calls = 0;
  const controller = new PlaybackMetadataController({ roomId: '1', clock: timer, resolve: async qn => {
    if (++calls === 1) throw Object.assign(new Error('limited'), { status: 429, retryAfter: 40 });
    return info(qn, timer.now());
  } });
  controller.setContext(context({ menuOpen: true })); await flush(); assert.equal(calls, 1);
  controller.setContext(context({ needed: false })); assert.equal(timer.size(), 0);
  await timer.advance(90_000); controller.wake(); await flush(); assert.equal(calls, 1);
  controller.setContext(context({ menuOpen: true })); await flush(); assert.equal(calls, 2);
  controller.dispose(); assert.equal(timer.size(), 0);
});

test('Retry-After survives focus, offline/online and same-account RPC renewal', async () => {
  const timer = clock(); let calls = 0;
  const controller = new PlaybackMetadataController({ roomId: '1', clock: timer, resolve: async qn => {
    if (++calls === 1) throw Object.assign(new Error('limited'), { status: 429, retryAfter: 40 });
    return info(qn, timer.now());
  } });
  controller.setContext(context({ menuOpen: true })); await flush(); assert.equal(controller.getSnapshot().state, 'cooldown');
  controller.wake(); controller.setContext(context({ online: false, menuOpen: true }));
  controller.setContext(context({ rpcScope: 'worker:2', menuOpen: true })); await flush(); assert.equal(calls, 1);
  await timer.advance(39_999); assert.equal(calls, 1);
  await timer.advance(1); assert.equal(calls, 2); assert.equal(controller.getSnapshot().state, 'ready'); controller.dispose();
});

test('an open menu keeps advertised choices without periodic expiration or route preflight', async () => {
  const timer = clock(); let calls = 0;
  const controller = new PlaybackMetadataController({ roomId: '1', clock: timer,
    resolve: async qn => { calls++; return info(qn, timer.now()); } });
  controller.setContext(context({ menuOpen: true })); await flush(); assert.equal(calls, 1);
  await timer.advance(90_000); assert.equal(calls, 1); assert.equal(timer.size(), 0);
  controller.wake(); await flush(); assert.equal(calls, 1);
  await controller.ensureRoutes(250); assert.equal(calls, 2);
  controller.setContext(context()); assert.equal(timer.size(), 0);
  await timer.advance(90_000); assert.equal(calls, 2); controller.dispose();
});

test('routes are fetched for actual playback QN rather than previous preferred QN', async () => {
  const timer = clock(), requested: number[] = [];
  const controller = new PlaybackMetadataController({ roomId: '1', clock: timer,
    resolve: async qn => { requested.push(qn); return info(qn, timer.now()); } });
  controller.setContext(context({ needed: false })); controller.observe(info(10000));
  controller.setContext(context()); const result = await controller.ensureRoutes(250);
  assert.deepEqual(requested, [250]); assert.equal(result.sources.every(source => source.actualQuality === 250), true);
  controller.dispose();
});

test('fresh routes are reused while expired addresses are replaced before new selection', async () => {
  const timer = clock(); let calls = 0;
  const controller = new PlaybackMetadataController({ roomId: '1', clock: timer,
    resolve: async qn => { calls++; return info(qn, timer.now()); } });
  controller.setContext(context({ needed: false }));
  controller.observe({ ...info(), sources: info().sources.map(source => ({ ...source, expiresAt: 5_000 })) });
  controller.setContext(context()); await controller.ensureRoutes(250); assert.equal(calls, 0);
  await timer.advance(4_001); await controller.ensureRoutes(250); assert.equal(calls, 1);
  controller.dispose();
});

test('missing requested routes reject selection with a recovery delay instead of claiming success', async () => {
  const timer = clock(); let calls = 0;
  const controller = new PlaybackMetadataController({ roomId: '1', clock: timer,
    resolve: async qn => { calls++; return info(qn, timer.now(), 250); } });
  controller.setContext(context({ quality: 10000 }));
  await assert.rejects(controller.ensureRoutes(10000), /线路暂时不可用/);
  assert.equal(calls, 1); assert.equal(controller.getSnapshot().retryAt, 30_000);
  await assert.rejects(controller.ensureRoutes(10000)); assert.equal(calls, 1);
  controller.dispose();
});

test('a newer ordinary media response cannot be overwritten by a slower metadata result', async () => {
  const timer = clock(), pending = deferred<PlaybackInfo>();
  const controller = new PlaybackMetadataController({ roomId: '1', clock: timer, resolve: () => pending.promise });
  controller.setContext(context()); await flush(); await timer.advance(500);
  controller.observe({ ...info(250, 500), message: 'newest' });
  pending.resolve(info(250, 0)); await flush();
  assert.equal(controller.getSnapshot().info?.message, 'newest'); controller.dispose();
});

test('fresh offline and restricted responses stay settled during repeated focus without request storms', async () => {
  for (const status of ['offline', 'restricted'] as const) {
    const timer = clock(); let calls = 0;
    const controller = new PlaybackMetadataController({ roomId: '1', clock: timer, resolve: async qn => {
      calls++; return { ...info(qn, timer.now()), status, sources: [] };
    } });
    controller.setContext(context({ menuOpen: true })); await flush();
    for (let i = 0; i < 10; i++) { controller.wake(); controller.setContext(context()); await flush(); }
    assert.equal(calls, 1); assert.equal(controller.getSnapshot().state, 'ready');
    await assert.rejects(controller.ensureRoutes(250)); assert.equal(calls, 2);
    await assert.rejects(controller.ensureRoutes(250)); assert.equal(calls, 2);
    controller.dispose(); assert.equal(timer.size(), 0);
  }
});

test('new downgrade or offline evidence invalidates earlier signed route candidates', async () => {
  const timer = clock(); let calls = 0;
  const controller = new PlaybackMetadataController({ roomId: '1', clock: timer,
    resolve: async qn => { calls++; return info(qn, timer.now(), 250); } });
  controller.setContext(context({ quality: 10000, needed: false })); controller.observe(info(10000));
  await timer.advance(1); controller.observe(info(10000, 1, 250));
  controller.setContext(context({ quality: 10000 }));
  await assert.rejects(controller.ensureRoutes(10000)); assert.equal(calls, 1);
  controller.observe({ ...info(250, timer.now()), status: 'offline', sources: [] });
  assert.equal(controller.getSnapshot().info?.status, 'offline'); controller.dispose();
});

test('a newer observed snapshot cannot make an already expired pending response safe for route selection', async () => {
  const timer = clock(), pending = deferred<PlaybackInfo>();
  const controller = new PlaybackMetadataController({ roomId: '1', clock: timer, resolve: () => pending.promise });
  await timer.advance(40_000); controller.setContext(context());
  const selection = controller.ensureRoutes(250); const rejection = assert.rejects(selection, /已过期/);
  await flush(); controller.observe(info(250, timer.now()));
  pending.resolve(info(250, 0)); await rejection;
  assert.equal(controller.getSnapshot().info?.resolvedAt, 40_000); controller.dispose();
});

test('explicit authentication/access errors immediately invalidate personal descriptions and routes until revalidation', async () => {
  for (const status of [401, 403, 404, 409]) {
    const timer = clock(); let calls = 0;
    const controller = new PlaybackMetadataController({ roomId: '1', clock: timer, resolve: async qn => {
      if (++calls === 1) throw Object.assign(new Error('access changed'), { status });
      return info(qn, timer.now());
    } });
    controller.setContext({ ...context(), needed: false }); controller.observe(info(10000));
    controller.setContext(context({ menuOpen: true })); await assert.rejects(controller.ensureRoutes(250)); await flush();
    assert.equal(controller.getSnapshot().info, undefined, String(status));
    assert.equal(controller.getSnapshot().invalidated, true); assert.equal(controller.getSnapshot().state, 'error');
    controller.observe(info(10000)); assert.equal(controller.getSnapshot().info, undefined);
    await assert.rejects(controller.ensureRoutes(10000)); assert.equal(calls, 1);
    controller.wake(); await flush(); assert.equal(calls, 1);
    await timer.advance(2_000); assert.equal(calls, 2);
    assert.equal(controller.getSnapshot().invalidated, false); assert.equal(controller.getSnapshot().info?.requestedQuality, 250);
    controller.dispose(); assert.equal(timer.size(), 0);
  }
});

test('temporary network and upstream rate limits retain the last safe description', async () => {
  for (const status of [503, 412, 429]) {
    const timer = clock();
    const controller = new PlaybackMetadataController({ roomId: '1', clock: timer,
      resolve: async () => { throw Object.assign(new Error('temporary'), { status }); } });
    controller.setContext({ ...context(), needed: false }); controller.observe(info(10000));
    controller.setContext(context()); await assert.rejects(controller.ensureRoutes(250)); await flush();
    assert.equal(controller.getSnapshot().info?.requestedQuality, 10000);
    assert.equal(controller.getSnapshot().invalidated, false); controller.dispose();
  }
});

test('metadata queued behind playback keeps one request beyond its execution deadline and settles after its slot starts', async () => {
  const timer = clock(), media = deferred<PlaybackInfo>(), menu = deferred<PlaybackInfo>();
  const calls: string[] = [];
  const pool = new PlaybackRequestPool(request => {
    calls.push(request.roomId); return request.roomId === '2' ? media.promise : menu.promise;
  }, 1);
  const first = pool.resolve({ roomId: '2', source: 'custom', qn: 250, force: false, signal: new AbortController().signal });
  const controller = new PlaybackMetadataController({ roomId: '1', clock: timer,
    resolve: (qn, signal, lifecycle) => pool.resolve({ roomId: '1', source: 'custom', qn, force: false, signal, ...lifecycle }, '', 'metadata') });
  controller.setContext(context({ menuOpen: true })); await flush();
  await timer.advance(60_000);
  assert.deepEqual(calls, ['2']); assert.equal(controller.getSnapshot().state, 'loading'); assert.equal(timer.size(), 0);
  media.resolve({ ...info(250, timer.now()), roomId: '2' }); await first; await flush();
  assert.deepEqual(calls, ['2', '1']); assert.equal(timer.size(), 1);
  await timer.advance(14_999); assert.equal(controller.getSnapshot().state, 'loading');
  menu.resolve(info(250, timer.now())); await flush();
  assert.equal(controller.getSnapshot().state, 'ready'); assert.equal(timer.size(), 0);
  controller.dispose(); pool.dispose();
});

test('metadata timeout starts when queued work executes and background cancellation removes the queued consumer', async () => {
  for (const cancelQueued of [false, true]) {
    const timer = clock(), media = deferred<PlaybackInfo>(); const calls: string[] = [];
    const pool = new PlaybackRequestPool(request => {
      calls.push(request.roomId); return request.roomId === '2' ? media.promise : new Promise(() => {});
    }, 1);
    const first = pool.resolve({ roomId: '2', source: 'custom', qn: 250, force: false, signal: new AbortController().signal });
    const controller = new PlaybackMetadataController({ roomId: '1', clock: timer,
      resolve: (qn, signal, lifecycle) => pool.resolve({ roomId: '1', source: 'custom', qn, force: false, signal, ...lifecycle }, '', 'metadata') });
    controller.setContext(context({ menuOpen: true })); await flush(); await timer.advance(30_000);
    if (cancelQueued) controller.setContext(context({ menuOpen: true, visible: false }));
    media.resolve({ ...info(250, timer.now()), roomId: '2' }); await first; await flush();
    await timer.advance(15_000);
    assert.equal(controller.getSnapshot().state, cancelQueued ? 'idle' : 'error');
    assert.deepEqual(calls, cancelQueued ? ['2'] : ['2', '1']);
    controller.dispose(); pool.dispose(); assert.equal(timer.size(), 0);
  }
});
