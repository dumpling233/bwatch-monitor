import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlaybackSession, createPlaybackRecoveryState, playbackRouteKey, type PlaybackConnectionEvents, type PlaybackFailure } from '../client/multiview/playbackSession.js';
import { connectPlaybackSource, orderPlaybackSources } from '../client/multiview/playbackAdapters.js';
import type { PlaybackInfo, PlaybackSource } from '../shared/playback.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function fakeClock() {
  let time = 0;
  let next = 0;
  const timers = new Map<number, { callback: () => void; at: number }>();
  return {
    now: () => time,
    setTimeout(callback: () => void, delay: number) { const id = ++next; timers.set(id, { callback, at: time + delay }); return id; },
    clearTimeout(handle: unknown) { timers.delete(handle as number); },
    size: () => timers.size,
    async advance(ms: number) {
      const end = time + ms;
      for (;;) {
        const timer = [...timers].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!timer) break;
        time = timer[1].at;
        timers.delete(timer[0]);
        timer[1].callback();
        await flush();
      }
      time = end;
      await flush();
    },
  };
}
const source = (id: string, expiresAt?: number): PlaybackSource => ({
  id, url: `https://${id}.cdn.example/${id}`, protocol: 'flv', format: 'flv', codec: 'avc', actualQuality: 250,
  ...(expiresAt === undefined ? {} : { expiresAt }),
});
const info = (sources = [source('one')]): PlaybackInfo => ({
  roomId: '1', status: 'live', requestedQuality: 10000, qualities: [{ qn: 250, label: '超清' }], sources, resolvedAt: 0,
});

test('multi-room video prefers segmented HLS over continuous FLV while keeping CDN order stable', () => {
  const sources: PlaybackSource[] = [
    source('flv-a'), { ...source('ts-a'), protocol: 'hls', format: 'ts' },
    { ...source('fmp4-a'), protocol: 'hls', format: 'fmp4' }, source('flv-b'),
    { ...source('ts-b'), protocol: 'hls', format: 'ts' }, { ...source('fmp4-b'), protocol: 'hls', format: 'fmp4' },
  ];
  const video = (native: boolean) => ({ canPlayType: () => native ? 'probably' : '' }) as unknown as HTMLVideoElement;
  assert.deepEqual(orderPlaybackSources(video(false), sources).map(item => item.id), ['fmp4-a', 'fmp4-b', 'ts-a', 'ts-b', 'flv-a', 'flv-b']);
  assert.deepEqual(orderPlaybackSources(video(true), sources).map(item => item.id), ['ts-a', 'ts-b', 'fmp4-a', 'fmp4-b', 'flv-a', 'flv-b']);
  assert.deepEqual(orderPlaybackSources(video(true), sources, true).map(item => item.id), ['fmp4-a', 'fmp4-b', 'ts-a', 'ts-b', 'flv-a', 'flv-b']);
  assert.deepEqual(sources.map(item => item.id), ['flv-a', 'ts-a', 'fmp4-a', 'flv-b', 'ts-b', 'fmp4-b']);
});

test('manual route preference and healthy route memory take precedence over default format order', async () => {
  for (const manual of [false, true]) {
    const clock = fakeClock(), recovery = createPlaybackRecoveryState();
    const flv = source('known'), fmp4: PlaybackSource = { ...source('fmp4'), protocol: 'hls', format: 'fmp4' };
    if (!manual) recovery.healthyRoute = playbackRouteKey(fmp4);
    const attached: string[] = [];
    const session = createPlaybackSession({
      recoveryState: recovery, preferredRoute: manual ? playbackRouteKey(fmp4) : null,
      resolve: async () => info([flv, fmp4]),
      orderSources: candidates => orderPlaybackSources({ canPlayType: () => '' } as unknown as HTMLVideoElement, candidates),
      connect: async candidate => { attached.push(candidate.id); return { destroy() {} }; }, clock,
    });
    await flush();
    assert.deepEqual(attached, ['fmp4']);
    session.destroy();
    assert.equal(clock.size(), 0);
  }
});

test('destroy aborts metadata and ignores a late permission or room response', async () => {
  const pending = deferred<PlaybackInfo>();
  const clock = fakeClock();
  let signal!: AbortSignal;
  let connections = 0;
  let received = 0;
  const session = createPlaybackSession({
    resolve: requestSignal => { signal = requestSignal; return pending.promise; },
    connect: async () => { connections++; return { destroy() {} }; },
    onInfo: () => { received++; }, clock,
  });
  session.destroy();
  pending.resolve(info());
  await flush();
  assert.equal(signal.aborted, true);
  assert.equal(received, 0);
  assert.equal(connections, 0);
  assert.equal(clock.size(), 0);
});

test('a late adapter is disposed after the room is removed', async () => {
  const pending = deferred<{ destroy(): void }>();
  const clock = fakeClock();
  let disposed = 0;
  const session = createPlaybackSession({ resolve: async () => info(), connect: () => pending.promise, clock });
  await flush();
  session.destroy();
  pending.resolve({ destroy() { disposed++; } });
  await flush();
  assert.equal(disposed, 1);
  assert.equal(clock.size(), 0);
});

test('a failed CDN moves only this session to its next source and ignores old events', async () => {
  const clock = fakeClock();
  const attached: string[] = [];
  const hooks: PlaybackConnectionEvents[] = [];
  const states: string[] = [];
  const destroyed: string[] = [];
  let resolves = 0;
  const session = createPlaybackSession({
    resolve: async () => { resolves++; return info([source('a'), source('b')]); },
    connect: async (candidate, _signal, events) => {
      attached.push(candidate.id); hooks.push(events);
      return { destroy() { destroyed.push(candidate.id); } };
    }, onStatus: state => states.push(state), clock,
  });
  await flush();
  hooks[0].failed();
  await flush();
  assert.deepEqual(attached, ['a', 'b']);
  assert.deepEqual(destroyed, ['a']);
  assert.equal(resolves, 1);
  hooks[1].playing();
  hooks[0].failed();
  hooks[0].playing();
  assert.equal(states.at(-1), 'playing');
  assert.deepEqual(attached, ['a', 'b']);
  session.destroy();
  assert.deepEqual(destroyed, ['a', 'b']);
  assert.equal(clock.size(), 0);
});

test('Retry-After cooldown is respected and is cancelled when the panel closes', async () => {
  const clock = fakeClock();
  let resolves = 0;
  const session = createPlaybackSession({
    resolve: async () => { resolves++; throw { status: 429, retryAfter: 45 }; },
    connect: async () => ({ destroy() {} }), clock,
  });
  await flush();
  await clock.advance(44_999);
  assert.equal(resolves, 1);
  await clock.advance(1);
  assert.equal(resolves, 2);
  session.destroy();
  assert.equal(clock.size(), 0);
  await clock.advance(120_000);
  assert.equal(resolves, 2);
});

test('all unsupported formats stop retrying while known expiry refreshes before expiration', async () => {
  const unsupportedClock = fakeClock();
  let unsupportedResolves = 0;
  let state = '';
  const unsupported = createPlaybackSession({
    resolve: async () => { unsupportedResolves++; return info([source('a'), source('b')]); },
    connect: async (_source, _signal, events) => { events.failed('unsupported'); return { destroy() {} }; },
    onStatus: next => { state = next; }, clock: unsupportedClock,
  });
  await flush();
  assert.equal(state, 'unsupported');
  await unsupportedClock.advance(120_000);
  assert.equal(unsupportedResolves, 1);
  unsupported.destroy();
  const expiryClock = fakeClock();
  let expiryResolves = 0;
  const expiring = createPlaybackSession({
    resolve: async () => { expiryResolves++; return info([source('expiry', expiryClock.now() + 100_000)]); },
    connect: async () => ({ destroy() {} }), clock: expiryClock,
  });
  await flush();
  await expiryClock.advance(69_999);
  assert.equal(expiryResolves, 1);
  await expiryClock.advance(1);
  assert.equal(expiryResolves, 2);
  expiring.destroy();
  assert.equal(expiryClock.size(), 0);
});

test('already expired signatures are not attached or re-requested in a tight loop', async () => {
  const clock = fakeClock();
  let resolves = 0;
  let attached = 0;
  const session = createPlaybackSession({
    resolve: async () => { resolves++; return info([source('expired', 1)]); },
    connect: async () => { attached++; return { destroy() {} }; }, clock,
  });
  await flush();
  await clock.advance(9_999);
  assert.equal(attached, 0);
  assert.equal(resolves, 1);
  await clock.advance(1);
  assert.equal(resolves, 2);
  assert.equal(attached, 0);
  session.destroy();
  assert.equal(clock.size(), 0);
});

test('short-lived signatures refresh before expiry without repeatedly attaching the cached address', async () => {
  const clock = fakeClock();
  let resolves = 0;
  let attached = 0;
  let destroyed = 0;
  const session = createPlaybackSession({
    resolve: async () => { resolves++; return info([source('short', 5_000)]); },
    connect: async () => { attached++; return { destroy() { destroyed++; } }; }, clock,
  });
  await flush();
  await clock.advance(3_999);
  assert.equal(resolves, 1);
  await clock.advance(1);
  assert.equal(resolves, 2);
  assert.equal(attached, 1);
  assert.equal(destroyed, 0);
  await clock.advance(9_999);
  assert.equal(resolves, 2);
  await clock.advance(1);
  assert.equal(resolves, 3);
  assert.equal(attached, 1);
  session.destroy();
  assert.equal(destroyed, 1);
  assert.equal(clock.size(), 0);
});

test('an adapter that finishes near signature expiry refreshes immediately and remains bounded', async () => {
  const clock = fakeClock();
  const pending = deferred<{ destroy(): void }>();
  let resolves = 0;
  let disposed = 0;
  const session = createPlaybackSession({
    resolve: async () => { resolves++; return info([source('short', 5_000)]); },
    connect: () => pending.promise, clock,
  });
  await flush();
  await clock.advance(4_100);
  pending.resolve({ destroy() { disposed++; } });
  await flush();
  await clock.advance(0);
  assert.equal(resolves, 2);
  assert.equal(disposed, 0);
  await clock.advance(9_999);
  assert.equal(resolves, 2);
  session.destroy();
  assert.equal(disposed, 1);
  assert.equal(clock.size(), 0);
});

test('autoplay denial and permission aborts require a user action instead of a retry storm', async () => {
  for (const deniedByApi of [false, true]) {
    const clock = fakeClock();
    let resolves = 0;
    let connections = 0;
    let state = '';
    const session = createPlaybackSession({
      resolve: async () => {
        resolves++;
        if (deniedByApi) throw { name: 'AbortError' };
        return info([source('a'), source('b')]);
      },
      connect: async (_candidate, _signal, events) => { connections++; events.failed('autoplay'); return { destroy() {} }; },
      onStatus: next => { state = next; }, clock,
    });
    await flush();
    assert.equal(state, deniedByApi ? 'restricted' : 'autoplay-blocked');
    assert.equal(connections, deniedByApi ? 0 : 1);
    await clock.advance(120_000);
    assert.equal(resolves, 1);
    assert.equal(clock.size(), 0);
    session.destroy();
  }
});

class NativeVideo extends EventTarget {
  src = '';
  paused = true;
  ended = false;
  currentTime = 0;
  error: { code: number } | null = null;
  loads = 0;
  plays = 0;
  constructor(readonly playResult: () => Promise<void>) { super(); }
  canPlayType() { return 'probably'; }
  play() { this.plays++; this.paused = false; return this.playResult(); }
  pause() { this.paused = true; }
  removeAttribute(name: string) { if (name === 'src') this.src = ''; }
  load() { this.loads++; }
}
const nativeSource = (): PlaybackSource => ({ ...source('native'), protocol: 'hls', format: 'ts' });

test('native autoplay and unsupported errors are classified without leaking a connection', async () => {
  for (const [name, expected] of [['NotAllowedError', 'autoplay'], ['NotSupportedError', 'unsupported']]) {
    const video = new NativeVideo(() => Promise.reject({ name }));
    const controller = new AbortController();
    const reasons: Array<string | undefined> = [];
    const connection = await connectPlaybackSource(video as unknown as HTMLVideoElement, nativeSource(), controller.signal, {
      playing() {}, failed: reason => { reasons.push(typeof reason === 'string' ? reason : reason?.kind); },
    });
    try {
      await flush();
      assert.deepEqual(reasons, [expected]);
      controller.abort();
      assert.equal(video.src, '');
      assert.equal(video.paused, true);
      assert.equal(video.loads, 1);
      video.dispatchEvent(new Event('canplay'));
      assert.equal(video.plays, 1);
    } finally { connection.destroy(); }
  }
});

test('an aborted native play promise cannot report an error for its replacement', async () => {
  let rejectPlay!: (error: unknown) => void;
  const video = new NativeVideo(() => new Promise((_resolve, reject) => { rejectPlay = reject; }));
  const controller = new AbortController();
  const reasons: Array<string | undefined> = [];
  const connection = await connectPlaybackSource(video as unknown as HTMLVideoElement, nativeSource(), controller.signal, {
    playing() {}, failed: reason => { reasons.push(typeof reason === 'string' ? reason : reason?.kind); },
  });
  try {
    controller.abort();
    rejectPlay({ name: 'NotAllowedError' });
    video.error = { code: 4 };
    video.dispatchEvent(new Event('error'));
    await flush();
    assert.deepEqual(reasons, []);
    assert.equal(video.loads, 1);
  } finally { connection.destroy(); }
});

test('quality updates retain the current connection until a different actual quality is available', async () => {
  const clock = fakeClock();
  const pending = deferred<PlaybackInfo>();
  const contexts: Array<{ qn: number; reason: string; force: boolean }> = [];
  let connections = 0, destroyed = 0;
  const session = createPlaybackSession({
    resolve: async (_signal, context) => {
      contexts.push(context);
      if (context.qn === 10000) return pending.promise;
      return info([{ ...source('one'), actualQuality: context.qn }]);
    }, connect: async () => { connections++; return { destroy() { destroyed++; } }; }, clock,
  });
  await flush();
  session.updateQuality(10000);
  await flush();
  assert.equal(connections, 1);
  assert.equal(destroyed, 0);
  pending.resolve(info([{ ...source('one'), id: 'new-signature', url: source('one').url + '?token=new' }]));
  await flush();
  assert.equal(connections, 1);
  assert.equal(destroyed, 0);
  assert.deepEqual({ qn: contexts[1].qn, reason: contexts[1].reason, force: contexts[1].force }, { qn: 10000, reason: 'quality', force: false });
  session.updateQuality(400);
  await flush();
  assert.equal(connections, 2);
  assert.equal(destroyed, 1);
  session.destroy();
  assert.equal(clock.size(), 0);
});

test('a failed quality switch restores a recent usable old source once, without a fallback loop', async () => {
  const clock = fakeClock();
  const attached: number[] = [], hooks: PlaybackConnectionEvents[] = [], actual: number[] = [];
  let destroyed = 0;
  const session = createPlaybackSession({
    resolve: async (_signal, context) => info([{ ...source(context.qn === 400 ? 'high' : 'one'), actualQuality: context.qn }]),
    connect: async (candidate, _signal, events) => {
      attached.push(candidate.actualQuality); hooks.push(events);
      if (candidate.actualQuality === 400) events.failed({ kind: 'media' });
      return { destroy() { destroyed++; } };
    }, onSource: value => actual.push(value.actualQuality), clock,
  });
  await flush();
  hooks[0].playing(); hooks[0].progress?.();
  session.updateQuality(400);
  await flush();
  assert.deepEqual(attached, [250, 400, 250]);
  assert.deepEqual(actual, [250]);
  hooks[2].progress?.();
  assert.deepEqual(actual, [250, 250]);
  assert.equal(destroyed, 2);
  hooks[2].failed({ kind: 'network' });
  await flush();
  assert.deepEqual(attached, [250, 400, 250]);
  session.destroy();
  assert.equal(destroyed, 3);
  assert.equal(clock.size(), 0);
});

test('retaining the same actual quality does not replace current protocol quality options with another protocol', async () => {
  const clock = fakeClock();
  const hls = { ...source('one'), protocol: 'hls' as const, format: 'ts' as const, qualities: [{ qn: 250, label: '当前HLS' }] };
  let calls = 0;
  const reported: PlaybackSource[] = [];
  let hooks!: PlaybackConnectionEvents;
  const session = createPlaybackSession({
    resolve: async () => ++calls === 1 ? info([hls]) : info([{ ...source('one'), qualities: [{ qn: 400, label: '其他FLV档位' }] }]),
    connect: async (_source, _signal, events) => { hooks = events; return { destroy() {} }; }, onSource: value => reported.push(value), clock,
  });
  await flush();
  hooks.progress?.();
  session.updateQuality(10000);
  await flush();
  assert.equal(reported.at(-1)?.protocol, 'hls');
  assert.deepEqual(reported.at(-1)?.qualities, hls.qualities);
  session.destroy();
});

test('rapid quality changes discard old metadata without invalidating the active media events', async () => {
  const clock = fakeClock();
  const old = deferred<PlaybackInfo>(), latest = deferred<PlaybackInfo>();
  const actual: number[] = [];
  let hooks!: PlaybackConnectionEvents;
  const session = createPlaybackSession({
    resolve: async (_signal, context) => context.qn === 400 ? old.promise : context.qn === 10000 ? latest.promise : info(),
    connect: async (_source, _signal, events) => { hooks = events; return { destroy() {} }; },
    onSource: value => actual.push(value.actualQuality), clock,
  });
  await flush();
  hooks.progress?.();
  session.updateQuality(400);
  session.updateQuality(10000);
  latest.resolve(info());
  await flush();
  old.resolve(info([{ ...source('one'), actualQuality: 400 }]));
  await flush();
  assert.deepEqual(actual, [250, 250]);
  hooks.playing();
  session.destroy();
  assert.equal(clock.size(), 0);
});

test('expiry metadata failures retain healthy FLV and new FLV signatures are only prefetched', async () => {
  for (const failed of [false, true]) {
    const clock = fakeClock();
    const pending = deferred<PlaybackInfo>();
    let calls = 0, connections = 0, destroyed = 0;
    const session = createPlaybackSession({
      resolve: async (_signal, context) => {
        calls++;
        if (calls === 1) return info([source('one', 100_000)]);
        assert.equal(context.reason, 'expiry');
        assert.equal(context.force, true);
        if (failed) throw new Error('upstream timeout');
        return pending.promise;
      }, connect: async () => { connections++; return { destroy() { destroyed++; } }; }, clock,
    });
    await flush();
    await clock.advance(70_000);
    assert.equal(destroyed, 0);
    if (!failed) pending.resolve(info([{ ...source('one', 200_000), id: 'new', url: source('one').url + '?token=new' }]));
    await flush();
    assert.equal(connections, 1);
    assert.equal(destroyed, 0);
    session.destroy();
    assert.equal(destroyed, 1);
    assert.equal(clock.size(), 0);
  }
});

test('HLS expiry replaces the media only after the new signed playlist has arrived', async () => {
  const clock = fakeClock();
  const pending = deferred<PlaybackInfo>();
  const first = { ...source('hls', 100_000), protocol: 'hls' as const, format: 'fmp4' as const };
  let calls = 0, connections = 0, destroyed = 0;
  const session = createPlaybackSession({
    resolve: async () => ++calls === 1 ? info([first]) : pending.promise,
    connect: async () => { connections++; return { destroy() { destroyed++; } }; }, clock,
  });
  await flush();
  await clock.advance(70_000);
  assert.equal(destroyed, 0);
  pending.resolve(info([{ ...first, id: 'new', url: first.url + '?token=new', expiresAt: 200_000 }]));
  await flush();
  assert.equal(connections, 2);
  assert.equal(destroyed, 1);
  session.destroy();
  assert.equal(clock.size(), 0);
});

test('one playing event cannot clear backoff; thirty seconds of continuous progress can', async () => {
  const clock = fakeClock(), recovery = createPlaybackRecoveryState();
  recovery.failures = 4;
  let hooks!: PlaybackConnectionEvents;
  const session = createPlaybackSession({
    recoveryState: recovery, resolve: async () => info(),
    connect: async (_source, _signal, events) => { hooks = events; return { destroy() {} }; }, clock,
  });
  await flush();
  hooks.playing();
  await clock.advance(30_000);
  assert.equal(recovery.failures, 4);
  hooks.progress?.();
  for (let second = 1; second <= 20; second++) { await clock.advance(1_000); hooks.progress?.(); }
  hooks.waiting?.();
  for (let second = 1; second <= 29; second++) { await clock.advance(1_000); hooks.progress?.(); }
  assert.equal(recovery.failures, 4);
  await clock.advance(2_000); hooks.progress?.();
  assert.equal(recovery.failures, 0);
  assert.equal(recovery.healthyRoute, playbackRouteKey(source('one')));
  session.destroy();
});

test('bad route memory survives metadata reload and a preferred failed route does not disrupt its healthy fallback', async () => {
  const clock = fakeClock(), recovery = createPlaybackRecoveryState();
  recovery.routes.set(playbackRouteKey(source('bad')), { failures: 1, failedUntil: 30_000 });
  recovery.healthyRoute = playbackRouteKey(source('good'));
  const attached: string[] = [];
  let destroyed = 0;
  const session = createPlaybackSession({
    recoveryState: recovery, preferredRoute: playbackRouteKey(source('bad')),
    resolve: async () => info([source('bad'), source('good')]),
    connect: async candidate => { attached.push(candidate.id); return { destroy() { destroyed++; } }; }, clock,
  });
  await flush();
  session.updateQuality(10000);
  await flush();
  assert.deepEqual(attached, ['good']);
  assert.equal(destroyed, 0);
  session.destroy();
});

test('CDN cooldown survives pause/resume and manual or online actions cannot bypass it', async () => {
  const clock = fakeClock(), recovery = createPlaybackRecoveryState();
  let hooks!: PlaybackConnectionEvents;
  const initial = createPlaybackSession({
    recoveryState: recovery, resolve: async () => info(),
    connect: async (_source, _signal, events) => { hooks = events; return { destroy() {} }; }, clock,
  });
  await flush();
  hooks.failed({ kind: 'cooldown', httpStatus: 429, retryAfter: 45 });
  initial.destroy();
  let resolves = 0;
  const resumed = createPlaybackSession({
    recoveryState: recovery, resolve: async () => { resolves++; return info(); },
    connect: async () => ({ destroy() {} }), clock,
  });
  resumed.reconnect(); resumed.networkRestored(); resumed.updateQuality(10000);
  await clock.advance(44_999);
  assert.equal(resolves, 0);
  await clock.advance(1);
  assert.equal(resolves, 1);
  resumed.destroy();
  assert.equal(clock.size(), 0);
});

test('late metadata cannot reconnect a route during a CDN cooldown', async () => {
  const clock = fakeClock();
  const pending = deferred<PlaybackInfo>();
  let calls = 0, attached = 0;
  let hooks!: PlaybackConnectionEvents;
  const session = createPlaybackSession({
    resolve: async () => ++calls === 1 ? info() : pending.promise,
    connect: async (_source, _signal, events) => { attached++; hooks = events; return { destroy() {} }; }, clock,
  });
  await flush();
  session.updateQuality(10000);
  hooks.failed({ kind: 'cooldown', httpStatus: 412, retryAfter: 30 });
  pending.resolve(info());
  await flush();
  assert.equal(attached, 1);
  await clock.advance(29_999);
  assert.equal(attached, 1);
  session.destroy();
});

test('automatic reconnect can be toggled without rebuilding healthy media', async () => {
  const clock = fakeClock();
  let calls = 0, destroyed = 0;
  let hooks!: PlaybackConnectionEvents;
  const session = createPlaybackSession({
    resolve: async () => { calls++; return info(); },
    connect: async (_source, _signal, events) => { hooks = events; return { destroy() { destroyed++; } }; }, clock,
  });
  await flush();
  session.setAutoReconnect(false);
  assert.equal(destroyed, 0);
  hooks.failed();
  await clock.advance(60_000);
  assert.equal(calls, 1);
  session.reconnect();
  await flush();
  assert.equal(calls, 2);
  session.destroy();
  assert.equal(clock.size(), 0);
});

test('disabled automatic reconnect permits one initial or manual attempt and no failure retries', async () => {
  const clock = fakeClock();
  let resolves = 0;
  const session = createPlaybackSession({
    autoReconnect: false,
    resolve: async () => { resolves++; throw new Error('metadata unavailable'); },
    connect: async () => ({ destroy() {} }), clock,
  });
  await flush();
  assert.equal(resolves, 1);
  assert.equal(clock.size(), 0);
  await clock.advance(120_000);
  assert.equal(resolves, 1);
  session.reconnect();
  await flush();
  assert.equal(resolves, 2);
  assert.equal(clock.size(), 0);
  await clock.advance(120_000);
  assert.equal(resolves, 2);
  session.destroy();
});

test('disabled automatic reconnect retains healthy media after one failed quality request without retrying', async () => {
  const clock = fakeClock();
  let resolves = 0, destroyed = 0;
  let hooks!: PlaybackConnectionEvents;
  const session = createPlaybackSession({
    autoReconnect: false,
    resolve: async () => { if (++resolves === 1) return info(); throw new Error('quality unavailable'); },
    connect: async (_source, _signal, events) => { hooks = events; return { destroy() { destroyed++; } }; }, clock,
  });
  await flush();
  hooks.playing(); hooks.progress?.();
  session.updateQuality(10000);
  await flush();
  assert.equal(resolves, 2);
  assert.equal(destroyed, 0);
  assert.equal(clock.size(), 0);
  await clock.advance(120_000);
  assert.equal(resolves, 2);
  session.destroy();
  assert.equal(destroyed, 1);
});

test('disabled automatic reconnect does not automatically restore the old source after a failed explicit quality switch', async () => {
  const clock = fakeClock();
  const attached: number[] = [];
  let initial!: PlaybackConnectionEvents;
  const session = createPlaybackSession({
    autoReconnect: false,
    resolve: async (_signal, context) => info([{ ...source(context.qn === 400 ? 'high' : 'one'), actualQuality: context.qn }]),
    connect: async (candidate, _signal, events) => {
      attached.push(candidate.actualQuality);
      if (candidate.actualQuality === 400) events.failed({ kind: 'media' });
      else initial = events;
      return { destroy() {} };
    }, clock,
  });
  await flush();
  initial.playing(); initial.progress?.();
  session.updateQuality(400);
  await flush();
  assert.deepEqual(attached, [250, 400]);
  assert.equal(clock.size(), 0);
  session.destroy();
});

test('turning automatic reconnect off cancels queued initial, manual and quality retries', async () => {
  for (const reason of ['initial', 'manual', 'quality']) {
    const clock = fakeClock();
    let resolves = 0;
    const session = createPlaybackSession({
      resolve: async () => {
        resolves++;
        if (reason !== 'initial' && resolves === 1) return info();
        throw new Error('metadata unavailable');
      }, connect: async () => ({ destroy() {} }), clock,
    });
    await flush();
    if (reason === 'manual') session.reconnect();
    if (reason === 'quality') session.updateQuality(10000);
    await flush();
    assert.equal(clock.size(), 1);
    const before = resolves;
    session.setAutoReconnect(false);
    assert.equal(clock.size(), 0);
    await clock.advance(120_000);
    assert.equal(resolves, before);
    session.destroy();
  }
});

test('disabled automatic reconnect still renews metadata for a healthy expiring connection', async () => {
  const clock = fakeClock();
  let resolves = 0, destroyed = 0;
  let hooks!: PlaybackConnectionEvents;
  const session = createPlaybackSession({
    autoReconnect: false,
    resolve: async () => { resolves++; return info([source('one', clock.now() + 100_000)]); },
    connect: async (_source, _signal, events) => { hooks = events; return { destroy() { destroyed++; } }; }, clock,
  });
  await flush();
  hooks.playing(); hooks.progress?.();
  await clock.advance(70_000);
  assert.equal(resolves, 2);
  assert.equal(destroyed, 0);
  session.destroy();
  assert.equal(clock.size(), 0);
});

test('native EOF and an unexpected pause recover without keeping inactive media timers', async () => {
  const clock = fakeClock(), controller = new AbortController();
  const video = new NativeVideo(async () => {});
  const failures: unknown[] = [];
  const connection = await connectPlaybackSource(video as unknown as HTMLVideoElement, nativeSource(), controller.signal, {
    playing() {}, failed: reason => failures.push(reason),
  }, 'stable', { clock });
  try {
    video.currentTime = 1; video.dispatchEvent(new Event('timeupdate'));
    video.paused = true; video.dispatchEvent(new Event('pause'));
    assert.equal(video.plays, 2);
    video.ended = true; video.paused = true; video.dispatchEvent(new Event('ended'));
    assert.deepEqual(failures, [{ kind: 'network' }]);
    controller.abort();
    assert.equal(clock.size(), 0);
    video.dispatchEvent(new Event('ended'));
    assert.equal(failures.length, 1);
  } finally { connection.destroy(); }
});

test('playing without media progress still times out and does not keep extending its deadline', async () => {
  const clock = fakeClock(), controller = new AbortController();
  const video = new NativeVideo(async () => {});
  let failures = 0;
  const connection = await connectPlaybackSource(video as unknown as HTMLVideoElement, nativeSource(), controller.signal, {
    playing() {}, failed() { failures++; },
  }, 'stable', { clock });
  try {
    video.currentTime = 1; video.dispatchEvent(new Event('timeupdate'));
    for (let second = 0; second < 24; second++) { await clock.advance(1_000); video.dispatchEvent(new Event('playing')); }
    assert.equal(failures, 0);
    await clock.advance(1_000);
    assert.equal(failures, 1);
    assert.equal(clock.size(), 0);
  } finally { connection.destroy(); }
});

test('a stagnant optional frame counter does not hide a progressing media timeline', async () => {
  const clock = fakeClock(), controller = new AbortController();
  class CounterVideo extends NativeVideo {
    totalFrames = 0;
    getVideoPlaybackQuality() { return { totalVideoFrames: this.totalFrames }; }
  }
  const video = new CounterVideo(async () => {});
  let failures = 0, progress = 0;
  const connection = await connectPlaybackSource(video as unknown as HTMLVideoElement, nativeSource(), controller.signal, {
    playing() {}, progress() { progress++; }, failed() { failures++; },
  }, 'stable', { clock });
  try {
    for (let second = 1; second <= 26; second++) {
      video.currentTime = second; video.dispatchEvent(new Event('timeupdate'));
      await clock.advance(1_000);
    }
    assert.equal(failures, 0);
    assert.ok(progress >= 25);
  } finally { connection.destroy(); }
});

test('media counters resetting for a new source do not inherit the previous source baseline', async () => {
  const clock = fakeClock(), controller = new AbortController();
  class CounterVideo extends NativeVideo {
    totalFrames = 900;
    getVideoPlaybackQuality() { return { totalVideoFrames: this.totalFrames }; }
  }
  const video = new CounterVideo(async () => {});
  video.currentTime = 80;
  let failures = 0;
  const connection = await connectPlaybackSource(video as unknown as HTMLVideoElement, nativeSource(), controller.signal, {
    playing() {}, failed() { failures++; },
  }, 'stable', { clock });
  try {
    video.currentTime = 0; video.totalFrames = 0; video.dispatchEvent(new Event('timeupdate'));
    for (let second = 1; second <= 26; second++) {
      video.currentTime = second; video.totalFrames += 30; video.dispatchEvent(new Event('timeupdate'));
      await clock.advance(1_000);
    }
    assert.equal(failures, 0);
  } finally { connection.destroy(); }
});

test('mpegts destruction cancels the engine and classifies CDN rate limits', async () => {
  const clock = fakeClock(), controller = new AbortController();
  const video = new NativeVideo(async () => {});
  const handlers = new Map<string, (...args: unknown[]) => void>();
  let destroyed = 0, loaded = false;
  let config: Record<string, unknown> = {};
  const failures: unknown[] = [];
  const engine = {
    on: (name: string, listener: (...args: unknown[]) => void) => handlers.set(name, listener),
    attachMediaElement() { video.src = 'blob:media'; }, load() { loaded = true; },
    destroy() { destroyed++; loaded = false; handlers.clear(); },
  };
  const mpegts = {
    getFeatureList: () => ({ mseLivePlayback: true }), LoggingControl: { enableAll: true },
    createPlayer: (_source: unknown, options: Record<string, unknown>) => { config = options; return engine; },
    Events: { ERROR: 'error' }, ErrorTypes: { NETWORK_ERROR: 'network' },
    ErrorDetails: { MEDIA_FORMAT_UNSUPPORTED: 'format', MEDIA_CODEC_UNSUPPORTED: 'codec' },
  };
  const connection = await connectPlaybackSource(video as unknown as HTMLVideoElement, source('one'), controller.signal, {
    playing() {}, failed: reason => failures.push(reason),
  }, 'stable', { clock, loadMpegts: async () => ({ default: mpegts }) as never });
  try {
    assert.equal(loaded, true);
    assert.equal(config.referrerPolicy, 'no-referrer');
    assert.equal(config.enableStashBuffer, true);
    assert.equal(config.autoCleanupSourceBuffer, true);
    assert.equal(config.autoCleanupMaxBackwardDuration, 10);
    assert.equal(config.autoCleanupMinBackwardDuration, 5);
    handlers.get('error')?.('network', 'invalid-status', { code: 429, retryAfter: 45 });
    assert.deepEqual(failures, [{ kind: 'cooldown', httpStatus: 429, retryAfter: 45 }]);
    controller.abort();
    assert.equal(loaded, false);
    assert.equal(destroyed, 1);
    assert.equal(handlers.size, 0);
    assert.equal(video.src, '');
    assert.equal(clock.size(), 0);
  } finally { connection.destroy(); }
});

test('hls.js MSE takes precedence when the media element also advertises native HLS', async () => {
  const clock = fakeClock(), controller = new AbortController();
  const video = new NativeVideo(async () => {});
  let created = 0, destroyed = 0, maxBufferLength = 0;
  class Hls {
    static isSupported = () => true;
    static Events = { ERROR: 'error', MANIFEST_PARSED: 'manifest' };
    static ErrorTypes = { NETWORK_ERROR: 'network', MEDIA_ERROR: 'media' };
    constructor(config: { maxBufferLength: number }) { created++; maxBufferLength = config.maxBufferLength; }
    on() {} loadSource() {}
    attachMedia() { video.src = 'blob:hls-mse'; }
    destroy() { destroyed++; }
  }
  const connection = await connectPlaybackSource(video as unknown as HTMLVideoElement, nativeSource(), controller.signal, {
    playing() {}, failed() { assert.fail('supported MSE must not be rejected'); },
  }, 'stable', { clock, loadHls: async () => ({ default: Hls }) as never });
  try {
    assert.equal(created, 1);
    assert.equal(video.src, 'blob:hls-mse');
    assert.equal(maxBufferLength, 20);
  } finally { connection.destroy(); }
  assert.equal(destroyed, 1);
  assert.equal(clock.size(), 0);
});

for (const mode of ['stable', 'low-latency'] as const) {
  test(`${mode} media adapters reclaim past buffers without reducing forward playback reserve`, async () => {
    for (const protocol of ['hls', 'flv'] as const) {
      const clock = fakeClock(), controller = new AbortController();
      const video = new NativeVideo(async () => {});
      let config: Record<string, unknown> = {}, destroyed = 0, failures = 0;
      const attach = () => { video.src = `blob:${protocol}`; };
      class Hls {
        static isSupported = () => true;
        static Events = { ERROR: 'error', MANIFEST_PARSED: 'manifest' };
        static ErrorTypes = { NETWORK_ERROR: 'network', MEDIA_ERROR: 'media' };
        constructor(options: Record<string, unknown>) { config = options; }
        on() {} loadSource() {} attachMedia() { attach(); }
        destroy() { destroyed++; }
      }
      const mpegts = {
        getFeatureList: () => ({ mseLivePlayback: true }), LoggingControl: { enableAll: false },
        createPlayer: (_source: unknown, options: Record<string, unknown>) => {
          config = options;
          return { on() {}, attachMediaElement: attach, load() {}, destroy() { destroyed++; } };
        },
        Events: { ERROR: 'error' }, ErrorTypes: { NETWORK_ERROR: 'network' },
        ErrorDetails: { MEDIA_FORMAT_UNSUPPORTED: 'format', MEDIA_CODEC_UNSUPPORTED: 'codec' },
      };
      const connection = await connectPlaybackSource(video as unknown as HTMLVideoElement,
        protocol === 'hls' ? nativeSource() : source('one'), controller.signal,
        { playing() {}, failed() { failures++; } }, mode, {
          clock, loadHls: async () => ({ default: Hls }) as never,
          loadMpegts: async () => ({ default: mpegts }) as never,
        });
      try {
        if (protocol === 'hls') {
          assert.equal(config.backBufferLength, 5);
          assert.equal(config.maxBufferLength, mode === 'stable' ? 20 : 12);
          assert.equal(config.maxMaxBufferLength, 30);
          assert.equal(Object.hasOwn(config, 'maxBufferSize'), false, 'keep the library byte target unchanged');
          assert.equal(config.liveSyncDurationCount, mode === 'stable' ? 4 : 3);
          assert.equal(config.lowLatencyMode, mode === 'low-latency');
        } else {
          assert.equal(config.autoCleanupSourceBuffer, true);
          assert.equal(config.autoCleanupMaxBackwardDuration, 10);
          assert.equal(config.autoCleanupMinBackwardDuration, 5);
          assert.equal(config.enableStashBuffer, mode === 'stable');
          assert.equal(config.stashInitialSize, 64 * 1024);
          assert.equal(config.liveBufferLatencyChasing, true);
          assert.equal(config.liveBufferLatencyChasingOnPaused, true);
          assert.equal(config.liveBufferLatencyMaxLatency, mode === 'stable' ? 6 : 3);
          assert.equal(config.liveBufferLatencyMinRemain, mode === 'stable' ? 1.5 : 0.5);
        }
        // Progress beyond both cleanup thresholds must keep the same active connection.
        for (let second = 1; second <= 22; second++) {
          video.currentTime = second;
          video.dispatchEvent(new Event('timeupdate'));
          await clock.advance(1_000);
        }
        assert.equal(destroyed, 0);
        assert.equal(failures, 0);
        assert.equal(video.src, `blob:${protocol}`);
        controller.abort();
        connection.destroy();
        assert.equal(destroyed, 1);
        assert.equal(video.src, '');
        assert.equal(video.paused, true);
        assert.equal(clock.size(), 0);
      } finally { connection.destroy(); }
    }
  });
}

test('native HLS is used when hls.js MSE is unsupported', async () => {
  const clock = fakeClock(), controller = new AbortController();
  const video = new NativeVideo(async () => {});
  class Hls {
    static isSupported = () => false;
    constructor() { assert.fail('unsupported MSE must not create an engine'); }
  }
  const connection = await connectPlaybackSource(video as unknown as HTMLVideoElement, nativeSource(), controller.signal, {
    playing() {}, failed() { assert.fail('available native HLS must remain a fallback'); },
  }, 'stable', { clock, loadHls: async () => ({ default: Hls }) as never });
  try { assert.equal(video.src, nativeSource().url); }
  finally { connection.destroy(); }
  assert.equal(clock.size(), 0);
});

test('HLS internal recovery is bounded and rate limits bypass internal retry', async () => {
  for (const rateLimited of [false, true]) {
    const clock = fakeClock(), controller = new AbortController();
    const video = new NativeVideo(async () => {});
    video.canPlayType = () => '';
    const failures: Array<PlaybackFailure | string | undefined> = [];
    const handlers = new Map<string, (...args: unknown[]) => void>();
    let internalRetries = 0, destroyed = 0;
    class Hls {
      static isSupported = () => true;
      static Events = { ERROR: 'error', MANIFEST_PARSED: 'manifest' };
      static ErrorTypes = { NETWORK_ERROR: 'network', MEDIA_ERROR: 'media' };
      on(name: string, callback: (...args: unknown[]) => void) { handlers.set(name, callback); }
      loadSource() {} attachMedia() {} recoverMediaError() { internalRetries++; }
      startLoad() { internalRetries++; }
      destroy() { destroyed++; handlers.clear(); }
    }
    const connection = await connectPlaybackSource(video as unknown as HTMLVideoElement, nativeSource(), controller.signal, {
      playing() {}, failed: reason => failures.push(reason),
    }, 'stable', { clock, loadHls: async () => ({ default: Hls }) as never });
    try {
      const error = { fatal: true, type: 'network', ...(rateLimited ? { response: { code: 429 }, networkDetails: { headers: new Headers({ 'retry-after': '40' }) } } : {}) };
      handlers.get('error')?.('error', error);
      if (!rateLimited) handlers.get('error')?.('error', error);
      assert.equal(internalRetries, rateLimited ? 0 : 1);
      assert.equal(failures.length, 1);
      if (rateLimited) assert.deepEqual(failures[0], { kind: 'cooldown', httpStatus: 429, retryAfter: 40 });
      controller.abort();
      assert.equal(destroyed, 1);
      assert.equal(clock.size(), 0);
    } finally { connection.destroy(); }
  }
});
