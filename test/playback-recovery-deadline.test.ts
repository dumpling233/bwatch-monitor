import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlaybackSession, type PlaybackConnectionEvents, type PlayerStatus } from '../client/multiview/playbackSession.js';
import type { PlaybackInfo, PlaybackSource } from '../shared/playback.js';
import { createPlaybackHealthRuntime } from '../client/multiview/playbackHealth.js';

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
function fakeClock() {
  let time = 0;
  let next = 0;
  const timers = new Map<number, { callback(): void; at: number }>();
  return {
    now: () => time,
    setTimeout(callback: () => void, delay: number) { const id = ++next; timers.set(id, { callback, at: time + delay }); return id; },
    clearTimeout(handle: unknown) { timers.delete(handle as number); },
    size: () => timers.size,
    async advance(duration: number) {
      const end = time + duration;
      for (;;) {
        const timer = [...timers].filter(([, value]) => value.at <= end).sort((first, second) => first[1].at - second[1].at)[0];
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
const source = (id = 'one', expiresAt?: number): PlaybackSource => ({
  id, url: `https://${id}.cdn.example/live.flv`, protocol: 'flv', format: 'flv', codec: 'avc', actualQuality: 250,
  ...(expiresAt === undefined ? {} : { expiresAt }),
});
const info = (candidate = source()): PlaybackInfo => ({
  roomId: '1', status: 'live', requestedQuality: 250, qualities: [{ qn: 250, label: '超清' }], sources: [candidate], resolvedAt: 0,
});

test('a hanging initial request aborts at fifteen seconds and retries as a network failure', async () => {
  const clock = fakeClock(), pending = deferred<PlaybackInfo>();
  const signals: AbortSignal[] = [], states: PlayerStatus[] = [], reported: string[] = [];
  let connections = 0;
  const session = createPlaybackSession({
    resolve: signal => {
      signals.push(signal);
      if (signals.length === 1) return pending.promise;
      return Promise.resolve(info(source('latest')));
    },
    connect: async () => { connections++; return { destroy() {} }; },
    onInfo: value => reported.push(value.sources[0].id), onStatus: state => states.push(state), clock,
  });
  await clock.advance(14_999);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].aborted, false);
  await clock.advance(1);
  assert.equal(signals[0].aborted, true);
  assert.equal(states.at(-1), 'retrying');
  assert.equal(states.includes('restricted'), false);
  await clock.advance(999);
  assert.equal(signals.length, 1);
  await clock.advance(1);
  assert.equal(signals.length, 2);
  assert.equal(connections, 1);
  pending.resolve(info(source('expired-request')));
  await flush();
  assert.deepEqual(reported, ['latest']);
  assert.equal(connections, 1);
  session.destroy();
  assert.equal(clock.size(), 0);
});

test('the abort rejection caused by a deadline is not mistaken for revoked permissions', async () => {
  const clock = fakeClock(), states: PlayerStatus[] = [];
  let signal!: AbortSignal;
  const session = createPlaybackSession({
    resolveTimeoutMs: 1_000,
    resolve: current => new Promise((_done, reject) => {
      signal = current;
      current.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }),
    connect: async () => ({ destroy() {} }), onStatus: state => states.push(state), clock,
  });
  await clock.advance(1_000);
  assert.equal(signal.aborted, true);
  assert.equal(states.at(-1), 'retrying');
  assert.equal(states.includes('restricted'), false);
  session.destroy();
  assert.equal(clock.size(), 0);
});

test('a hanging signature renewal preserves healthy playback and rejects its late result', async () => {
  const clock = fakeClock(), pending = deferred<PlaybackInfo>();
  const states: PlayerStatus[] = [], reported: string[] = [];
  let calls = 0, connections = 0, destroyed = 0;
  let renewalSignal!: AbortSignal;
  let events!: PlaybackConnectionEvents;
  const session = createPlaybackSession({
    resolve: async (signal, context) => {
      if (++calls === 1) return info(source('healthy', 100_000));
      assert.equal(context.reason, 'expiry');
      renewalSignal = signal;
      return pending.promise;
    },
    connect: async (_candidate, _signal, hooks) => { connections++; events = hooks; return { destroy() { destroyed++; } }; },
    onInfo: value => reported.push(value.sources[0].id), onStatus: state => states.push(state), clock,
  });
  await flush();
  events.playing(); events.progress?.();
  await clock.advance(70_000);
  assert.equal(calls, 2);
  await clock.advance(15_000);
  assert.equal(renewalSignal.aborted, true);
  assert.equal(connections, 1);
  assert.equal(destroyed, 0);
  assert.equal(states.at(-1), 'playing');
  assert.equal(states.includes('restricted'), false);
  pending.resolve(info(source('late-renewal', 200_000)));
  await flush();
  assert.deepEqual(reported, ['healthy']);
  assert.equal(connections, 1);
  session.destroy();
  assert.equal(destroyed, 1);
  assert.equal(clock.size(), 0);
});

test('manual reconnect cancels an old request and its deadline without accepting late metadata', async () => {
  const clock = fakeClock(), pending = deferred<PlaybackInfo>();
  const signals: AbortSignal[] = [], reported: string[] = [];
  let connections = 0;
  const session = createPlaybackSession({
    resolve: signal => {
      signals.push(signal);
      return signals.length === 1 ? pending.promise : Promise.resolve(info(source('manual')));
    },
    connect: async () => { connections++; return { destroy() {} }; },
    onInfo: value => reported.push(value.sources[0].id), clock,
  });
  await clock.advance(5_000);
  session.reconnect();
  await flush();
  assert.equal(signals[0].aborted, true);
  assert.equal(signals[1].aborted, false);
  pending.resolve(info(source('old')));
  await clock.advance(30_000);
  assert.deepEqual(reported, ['manual']);
  assert.equal(signals.length, 2);
  assert.equal(connections, 1);
  assert.equal(clock.size(), 0);
  session.destroy();
});

test('destroy cancels a pending deadline and ignores late failures', async () => {
  const clock = fakeClock(), pending = deferred<PlaybackInfo>();
  const states: PlayerStatus[] = [];
  let signal!: AbortSignal, connections = 0;
  const session = createPlaybackSession({
    resolve: current => { signal = current; return pending.promise; },
    connect: async () => { connections++; return { destroy() {} }; },
    onStatus: state => states.push(state), clock,
  });
  session.destroy();
  const count = states.length;
  assert.equal(signal.aborted, true);
  assert.equal(clock.size(), 0);
  pending.reject({ status: 403 });
  await clock.advance(60_000);
  assert.equal(states.length, count);
  assert.equal(connections, 0);
  assert.equal(clock.size(), 0);
});

test('disabled automatic recovery stops deadline retries until explicitly re-enabled', async () => {
  const clock = fakeClock(), pending = deferred<PlaybackInfo>();
  const states: PlayerStatus[] = [];
  let requests = 0;
  const session = createPlaybackSession({
    autoReconnect: false,
    resolve: async () => { requests++; return requests === 1 ? pending.promise : info(); },
    connect: async () => ({ destroy() {} }), onStatus: state => states.push(state), clock,
  });
  await clock.advance(120_000);
  assert.equal(requests, 1);
  assert.equal(states.at(-1), 'error');
  assert.equal(clock.size(), 0);
  session.setAutoReconnect(true);
  await flush();
  assert.equal(requests, 2);
  pending.resolve(info(source('late')));
  await flush();
  session.destroy();
  assert.equal(clock.size(), 0);
});

test('stalled playback recovers on progress once and only current connections can report health', async () => {
  const clock = fakeClock(), events: PlaybackConnectionEvents[] = [], states: PlayerStatus[] = [];
  let healthChecks = 0;
  const session = createPlaybackSession({
    resolve: async () => info(),
    connect: async (_candidate, _signal, hooks) => {
      events.push(hooks);
      return { destroy() {}, checkHealth() { healthChecks++; } };
    }, onStatus: state => states.push(state), clock,
  });
  await flush();
  events[0].playing();
  events[0].stalled?.('画面暂时卡住');
  assert.equal(states.at(-1), 'stalled');
  const before = states.length;
  events[0].stalled?.('画面暂时卡住');
  assert.equal(states.length, before);
  events[0].progress?.();
  assert.equal(states.at(-1), 'playing');
  const recovered = states.length;
  events[0].progress?.(); events[0].progress?.();
  assert.equal(states.length, recovered);
  assert.equal(events[0].canAutoRecover?.(), true);
  session.setAutoReconnect(false);
  assert.equal(events[0].canAutoRecover?.(), false);
  session.setAutoReconnect(true);
  assert.equal(healthChecks, 1);
  session.reconnect();
  await flush();
  const replaced = states.length;
  events[0].stalled?.('旧连接'); events[0].progress?.();
  assert.equal(events[0].canAutoRecover?.(), false);
  assert.equal(states.length, replaced);
  assert.equal(events[1].canAutoRecover?.(), true);
  session.destroy();
  assert.equal(events[1].canAutoRecover?.(), false);
  assert.equal(clock.size(), 0);
});

test('automatic source recovery keeps its queue lease until media progresses', async () => {
  const clock = fakeClock(), hooks: PlaybackConnectionEvents[] = [];
  const queued: Array<{ action(): void; signal: AbortSignal }> = [];
  const connected: string[] = [];
  let releases = 0;
  const session = createPlaybackSession({
    resolve: async () => ({ ...info(), sources: [source('one'), source('two')] }),
    connect: async (candidate, _signal, events) => { connected.push(candidate.id); hooks.push(events); return { destroy() {} }; },
    enqueueRecovery(action, signal) { queued.push({ action, signal }); return () => { releases++; }; }, clock,
  });
  await flush();
  assert.deepEqual(connected, ['one']);
  hooks[0].failed();
  assert.equal(queued.length, 1);
  assert.deepEqual(connected, ['one']);
  assert.equal(releases, 0);
  queued[0].action();
  queued[0].action();
  await flush();
  assert.deepEqual(connected, ['one', 'two']);
  hooks[1].playing();
  assert.equal(releases, 0);
  hooks[1].progress?.();
  assert.equal(releases, 1);
  assert.equal(queued[0].signal.aborted, true);
  hooks[1].progress?.();
  session.destroy();
  assert.equal(releases, 1);
  assert.equal(clock.size(), 0);
});

test('automatic reconnect off and manual recovery cancel queued source reconstruction', async () => {
  for (const action of ['disable', 'manual', 'destroy'] as const) {
    const clock = fakeClock(), hooks: PlaybackConnectionEvents[] = [];
    const queued: Array<{ action(): void; signal: AbortSignal }> = [];
    let connections = 0, releases = 0;
    const session = createPlaybackSession({
      resolve: async () => ({ ...info(), sources: [source('one'), source('two')] }),
      connect: async (_candidate, _signal, events) => { connections++; hooks.push(events); return { destroy() {} }; },
      enqueueRecovery(callback, signal) { queued.push({ action: callback, signal }); return () => { releases++; }; }, clock,
    });
    await flush();
    hooks[0].failed();
    assert.equal(queued.length, 1);
    if (action === 'disable') session.setAutoReconnect(false);
    else if (action === 'manual') session.reconnect();
    else session.destroy();
    await flush();
    assert.equal(queued[0].signal.aborted, true);
    assert.equal(releases, 1);
    queued[0].action();
    await flush();
    assert.equal(connections, action === 'manual' ? 2 : 1);
    session.destroy();
    assert.equal(clock.size(), 0);
  }
});

test('metadata recovery uses the queue and all runtime leases are released on teardown', async () => {
  const clock = fakeClock(), runtime = createPlaybackHealthRuntime({ clock });
  const records = Array.from({ length: 3 }, () => ({ requests: 0, hooks: [] as PlaybackConnectionEvents[] }));
  const sessions = records.map(record => createPlaybackSession({
    resolve: async () => {
      if (++record.requests === 1) throw new Error('temporary failure');
      return info();
    },
    connect: async (_candidate, _signal, hooks) => { record.hooks.push(hooks); return { destroy() {} }; },
    enqueueRecovery: runtime.enqueue, clock,
  }));
  await flush();
  await clock.advance(1_000);
  assert.deepEqual(records.map(record => record.requests), [2, 1, 1]);
  await clock.advance(1_000);
  assert.deepEqual(records.map(record => record.requests), [2, 2, 1]);
  await clock.advance(5_000);
  assert.deepEqual(records.map(record => record.requests), [2, 2, 1]);
  records[0].hooks[0].playing();
  await clock.advance(1_000);
  assert.deepEqual(records.map(record => record.requests), [2, 2, 1]);
  records[0].hooks[0].progress?.();
  await clock.advance(0);
  assert.deepEqual(records.map(record => record.requests), [2, 2, 2]);
  sessions.forEach(session => session.destroy());
  assert.equal(clock.size(), 0);
  let nextStarted = false;
  const controller = new AbortController();
  const release = runtime.enqueue(() => { nextStarted = true; }, controller.signal);
  await clock.advance(1_000);
  assert.equal(nextStarted, true);
  release();
  assert.equal(clock.size(), 0);
});

test('disabling automatic recovery cancels already running recovery metadata and ignores its late result', async () => {
  for (const queued of [false, true]) {
    const clock = fakeClock(), pending = deferred<PlaybackInfo>();
    const signals: AbortSignal[] = [], reported: string[] = [];
    let runRecovery: (() => void) | undefined;
    let connections = 0, releases = 0;
    const session = createPlaybackSession({
      resolve: signal => {
        signals.push(signal);
        if (signals.length === 1) return Promise.reject(new Error('initial failure'));
        if (signals.length === 2) return pending.promise;
        return Promise.resolve(info(source('new-recovery')));
      },
      connect: async () => { connections++; return { destroy() {} }; },
      onInfo: value => reported.push(value.sources[0].id),
      ...(queued ? { enqueueRecovery(action: () => void) { runRecovery = action; return () => { releases++; }; } } : {}), clock,
    });
    await flush();
    await clock.advance(1_000);
    if (queued) runRecovery!();
    await flush();
    assert.equal(signals.length, 2);
    assert.equal(signals[1].aborted, false);
    session.networkRestored(); session.networkRestored();
    assert.equal(signals.length, 2);
    session.setAutoReconnect(false);
    assert.equal(signals[1].aborted, true);
    assert.equal(clock.size(), 0);
    if (queued) assert.equal(releases, 1);
    pending.resolve(info(source('cancelled-recovery')));
    await clock.advance(60_000);
    assert.equal(connections, 0);
    assert.deepEqual(reported, []);
    session.setAutoReconnect(true);
    if (queued) runRecovery!();
    await flush();
    assert.equal(signals.length, 3);
    assert.equal(connections, 1);
    assert.deepEqual(reported, ['new-recovery']);
    session.destroy();
    assert.equal(clock.size(), 0);
  }
});

test('disabling automatic recovery preserves initial, explicit manual, quality and healthy expiry requests', async () => {
  for (const reason of ['initial', 'manual', 'quality', 'expiry'] as const) {
    const clock = fakeClock(), pending = deferred<PlaybackInfo>();
    let calls = 0, signal!: AbortSignal;
    let hooks!: PlaybackConnectionEvents;
    const reported: string[] = [];
    const session = createPlaybackSession({
      resolve: current => {
        signal = current;
        if (++calls === 1 && reason !== 'initial') return Promise.resolve(info(source('healthy', reason === 'expiry' ? 100_000 : undefined)));
        return pending.promise;
      },
      connect: async (_candidate, _signal, events) => { hooks = events; return { destroy() {} }; },
      onInfo: value => reported.push(value.sources[0].id), clock,
    });
    await flush();
    if (reason !== 'initial') { hooks.playing(); hooks.progress?.(); }
    if (reason === 'manual') session.reconnect();
    else if (reason === 'quality') session.updateQuality(400);
    else if (reason === 'expiry') await clock.advance(70_000);
    session.setAutoReconnect(false);
    assert.equal(signal.aborted, false, reason);
    pending.resolve(info(source('explicit-result')));
    await flush();
    assert.equal(reported.at(-1), 'explicit-result', reason);
    session.destroy();
    assert.equal(clock.size(), 0);
  }
});

test('re-enabling health checks does not re-enter a recovery already scheduled by that check', async () => {
  const clock = fakeClock();
  let requests = 0;
  const session = createPlaybackSession({
    autoReconnect: false,
    resolve: async () => { requests++; return info(); },
    connect: async (_candidate, _signal, events) => ({ destroy() {}, checkHealth() { events.failed(); } }), clock,
  });
  await flush();
  session.setAutoReconnect(true);
  await flush();
  assert.equal(requests, 1);
  await clock.advance(4_999);
  assert.equal(requests, 1);
  await clock.advance(1);
  assert.equal(requests, 2);
  session.destroy();
  assert.equal(clock.size(), 0);
});
