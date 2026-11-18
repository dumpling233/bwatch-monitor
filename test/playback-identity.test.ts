import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlaybackSession, type PlaybackConnectionEvents } from '../client/multiview/playbackSession.js';
import { PlaybackRequestPool } from '../client/multiview/playbackRequestPool.js';
import type { PlaybackInfo, PlaybackSource } from '../shared/playback.js';

const flush = async () => { for (let i = 0; i < 32; i++) await Promise.resolve(); };
function clock() {
  let now = 0, sequence = 0;
  const timers = new Map<number, { at: number; run(): void }>();
  return {
    now: () => now,
    setTimeout(run: () => void, delay: number) { const id = ++sequence; timers.set(id, { at: now + delay, run }); return id; },
    clearTimeout(handle: unknown) { timers.delete(handle as number); },
    size: () => timers.size,
    async advance(duration: number) {
      const end = now + duration;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].run(); await flush();
      }
      now = end; await flush();
    },
  };
}
const source = (id: string, quality = 250): PlaybackSource => ({ id, url: `https://${id}.bilivideo.com/live.flv`,
  actualQuality: quality, protocol: 'flv', format: 'flv', codec: 'avc' });
const info = (candidate: PlaybackSource, roomId = '1'): PlaybackInfo => ({ roomId, requestedQuality: candidate.actualQuality,
  status: 'live', sources: [candidate], qualities: [{ qn: 10000, label: '原画' }, { qn: 250, label: '超清' }, { qn: 80, label: '流畅' }], resolvedAt: 0 });

test('authorization preserves healthy anonymous media and commits personal identity only after new real progress', async () => {
  const timer = clock(), hooks: PlaybackConnectionEvents[] = [], committed: string[] = [], calls: string[] = [];
  let scope = 'anonymous', destroyed = 0, cleared = 0;
  const session = createPlaybackSession({ identityScope: scope, clock: timer,
    resolve: async (_signal, context) => { calls.push(`${scope}:${context.qn}`); return info(source(scope, context.qn)); },
    connect: async (_candidate, _signal, events) => { hooks.push(events); return { destroy() { destroyed++; } }; },
    onSource: (_candidate, identity) => committed.push(identity!), onSourceCleared: () => { cleared++; } });
  await flush(); hooks[0].progress?.();
  scope = 'account:a'; session.setIdentityScope(scope); await flush();
  assert.deepEqual(calls, ['anonymous:250']); assert.equal(hooks.length, 1); assert.equal(destroyed, 0);
  assert.deepEqual(committed, ['anonymous', 'anonymous']);
  session.updateQuality(10000); await flush();
  assert.deepEqual(calls, ['anonymous:250', 'account:a:10000']); assert.equal(destroyed, 1);
  hooks[1].playing(); assert.equal(committed.at(-1), 'anonymous');
  hooks[1].progress?.(); assert.equal(committed.at(-1), 'account:a');
  scope = 'anonymous'; session.setIdentityScope(scope);
  assert.equal(destroyed, 2); assert.equal(cleared, 1);
  hooks[1].progress?.(); assert.equal(committed.at(-1), 'account:a');
  await flush(); hooks[2].progress?.(); assert.equal(committed.at(-1), 'anonymous');
  session.destroy(); assert.equal(timer.size(), 0);
});

test('identity changes cancel stale metadata and remove personal media even at the same actual quality', async () => {
  const timer = clock(), signals: AbortSignal[] = [], hooks: PlaybackConnectionEvents[] = [], committed: string[] = [];
  let release!: (value: PlaybackInfo) => void, scope = 'anonymous', destroyed = 0;
  const session = createPlaybackSession({ clock: timer,
    resolve: (signal, context) => { signals.push(signal); return signals.length === 1
      ? new Promise(resolve => { release = resolve; }) : Promise.resolve(info(source(scope, context.qn))); },
    connect: async (_candidate, _signal, events) => { hooks.push(events); return { destroy() { destroyed++; } }; },
    onSource: (_candidate, identity) => committed.push(identity!) });
  scope = 'account:a'; session.setIdentityScope(scope); assert.equal(signals[0].aborted, true);
  release(info(source('stale-anonymous'))); await flush(); assert.equal(hooks.length, 1);
  hooks[0].progress?.(); assert.deepEqual(committed, ['account:a']);
  scope = 'account:b'; session.setIdentityScope(scope); assert.equal(destroyed, 1);
  hooks[0].progress?.(); await flush(); hooks[1].progress?.(); assert.deepEqual(committed, ['account:a', 'account:b']);
  session.destroy(); assert.equal(timer.size(), 0);
});

test('forty-eight healthy anonymous players gain authorization without RPC or engine reconstruction', async () => {
  const timer = clock(), hooks: PlaybackConnectionEvents[] = [], scopes: string[] = [];
  let resolves = 0, connects = 0, destroyed = 0;
  const sessions = Array.from({ length: 48 }, (_, index) => createPlaybackSession({ clock: timer,
    resolve: async () => { resolves++; return info(source(`room-${index}`)); },
    connect: async (_candidate, _signal, events) => { connects++; hooks.push(events); return { destroy() { destroyed++; } }; },
    onSource: (_candidate, scope) => scopes.push(scope!) }));
  await flush(); hooks.forEach(events => events.progress?.());
  sessions.forEach(session => session.setIdentityScope('account:a')); await flush();
  assert.equal(resolves, 48); assert.equal(connects, 48); assert.equal(destroyed, 0);
  assert.equal(scopes.length, 96); assert.equal(scopes.every(scope => scope === 'anonymous'), true);
  sessions.forEach(session => session.destroy()); assert.equal(destroyed, 48); assert.equal(timer.size(), 0);
});

test('forty-eight queued startups wait for the two RPC slots without spending their network deadline', async () => {
  const timer = clock(); let calls = 0, concurrent = 0, maximum = 0, connections = 0, aborted = 0;
  const pool = new PlaybackRequestPool(request => new Promise(resolve => {
    calls++; concurrent++; maximum = Math.max(maximum, concurrent);
    request.signal.addEventListener('abort', () => { aborted++; }, { once: true });
    timer.setTimeout(() => { concurrent--; resolve(info(source(`room-${request.roomId}`), request.roomId)); }, 4_000);
  }), 2);
  const sessions = Array.from({ length: 48 }, (_, index) => createPlaybackSession({ clock: timer,
    resolve: (signal, context) => pool.resolve({ roomId: String(index), source: 'custom', qn: context.qn, force: context.force,
      signal, onQueued: context.onQueued, onStarted: context.onStarted }),
    connect: async (_candidate, _signal, events) => { connections++; events.progress?.(); return { destroy() {} }; } }));
  await flush(); assert.equal(calls, 2);
  await timer.advance(100_000);
  assert.equal(calls, 48); assert.equal(connections, 48); assert.equal(maximum, 2); assert.equal(aborted, 0);
  sessions.forEach(session => session.destroy()); pool.dispose(); assert.equal(timer.size(), 0);
});

for (const failure of ['empty', 'timeout'] as const) test(`an unavailable selected quality (${failure}) keeps healthy media and stops retrying the high quality`, async () => {
  const timer = clock(), calls: number[] = [], hooks: PlaybackConnectionEvents[] = [];
  let destroyed = 0;
  const session = createPlaybackSession({ clock: timer,
    resolve: (_signal, context) => {
      calls.push(context.qn);
      if (context.qn === 10000) return failure === 'empty' ? Promise.resolve({ ...info(source('high', 10000)), sources: [] }) : new Promise(() => {});
      return Promise.resolve(info(source('low', context.qn)));
    }, connect: async (_candidate, _signal, events) => { hooks.push(events); return { destroy() { destroyed++; } }; } });
  await flush(); hooks[0].progress?.(); session.updateQuality(10000); await flush();
  await timer.advance(15_000); assert.equal(destroyed, 0);
  await timer.advance(120_000); assert.deepEqual(calls, [250, 10000]);
  hooks[0].failed(); await flush(); await timer.advance(10_000);
  assert.equal(calls.slice(2).every(qn => qn <= 250), true); assert.equal(calls.filter(qn => qn === 10000).length, 1);
  session.destroy(); assert.equal(timer.size(), 0);
});

test('startup downgrades only after real failure, uses the upstream catalogue and remains bounded', async () => {
  const timer = clock(), calls: number[] = [], connected: number[] = [];
  const session = createPlaybackSession({ requestedQuality: 10000, clock: timer,
    resolve: async (_signal, context) => { calls.push(context.qn); const value = info(source(`qn-${context.qn}`, context.qn));
      return context.qn === 80 ? value : { ...value, sources: [] }; },
    connect: async (candidate, _signal, events) => { connected.push(candidate.actualQuality); events.progress?.(); return { destroy() {} }; } });
  await flush(); assert.deepEqual(calls, [10000, 250, 80]); assert.deepEqual(connected, [80]);
  await timer.advance(300_000); assert.deepEqual(calls, [10000, 250, 80]);
  session.destroy(); assert.equal(timer.size(), 0);
});

test('authorization after a long-running FLV URL expires keeps the established connection and its newer renewal plan', async () => {
  const timer = clock(), hooks: PlaybackConnectionEvents[] = [], calls: string[] = [];
  let scope = 'anonymous', destroyed = 0;
  const session = createPlaybackSession({ clock: timer,
    resolve: async () => { calls.push(scope); return info({ ...source(`signature-${calls.length}`),
      expiresAt: calls.length === 1 ? 40_000 : timer.now() + 300_000 }); },
    connect: async (_candidate, _signal, events) => { hooks.push(events); return { destroy() { destroyed++; } }; } });
  await flush(); hooks[0].progress?.(); await timer.advance(41_000); hooks[0].progress?.();
  assert.deepEqual(calls, ['anonymous', 'anonymous']);
  scope = 'account:a'; session.setIdentityScope(scope); await flush();
  assert.equal(hooks.length, 1); assert.equal(destroyed, 0);
  await timer.advance(60_000); assert.deepEqual(calls, ['anonymous', 'anonymous']);
  await timer.advance(179_000); assert.deepEqual(calls, ['anonymous', 'anonymous', 'account:a']);
  assert.equal(hooks.length, 1); assert.equal(destroyed, 0);
  session.destroy(); assert.equal(timer.size(), 0);
});

test('a failed explicit quality request keeps a progressing expired FLV connection without retrying the high quality', async () => {
  const timer = clock(), hooks: PlaybackConnectionEvents[] = [], calls: number[] = [];
  let destroyed = 0;
  const session = createPlaybackSession({ clock: timer,
    resolve: async (_signal, context) => {
      calls.push(context.qn);
      if (context.qn === 10000) throw Object.assign(new Error('network unavailable'), { status: 503 });
      return info({ ...source(`signature-${calls.length}`), expiresAt: calls.length === 1 ? 40_000 : timer.now() + 300_000 });
    }, connect: async (_candidate, _signal, events) => { hooks.push(events); return { destroy() { destroyed++; } }; } });
  await flush(); hooks[0].progress?.(); await timer.advance(41_000); hooks[0].progress?.();
  session.updateQuality(10000); await flush(); await timer.advance(60_000);
  assert.deepEqual(calls, [250, 250, 10000]); assert.equal(destroyed, 0); assert.equal(hooks.length, 1);
  session.destroy(); assert.equal(timer.size(), 0);
});

test('quality metadata reports pending independently from healthy playback and clears pending on cancellation', async () => {
  const timer = clock(), hooks: PlaybackConnectionEvents[] = [], phases: { state: string; qn?: number; reason?: string }[] = [];
  const statuses: string[] = []; let complete!: (value: PlaybackInfo) => void;
  const session = createPlaybackSession({ clock: timer,
    resolve: (_signal, context) => context.qn === 10000 ? new Promise(resolve => { complete = resolve; }) : Promise.resolve(info(source('public'))),
    connect: async (_candidate, _signal, events) => { hooks.push(events); return { destroy() {} }; },
    onOptionsState: (state, _message, context) => phases.push({ state, qn: context?.qn, reason: context?.reason }),
    onStatus: state => statuses.push(state) });
  await flush(); hooks[0].progress?.(); session.updateQuality(10000); await flush();
  assert.deepEqual(phases.at(-1), { state: 'loading', qn: 10000, reason: 'quality' });
  assert.equal(statuses.at(-1), 'playing');
  session.setIdentityScope('account:a'); assert.equal(phases.at(-1)?.state, 'idle');
  complete(info(source('late-high', 10000))); await flush(); assert.equal(hooks.length, 1);
  assert.equal(phases.at(-1)?.state, 'idle');
  session.destroy(); assert.equal(timer.size(), 0);
});

test('retrying the saved high quality after a downgrade stops on metadata failure while a successful refresh still reconnects', async () => {
  const timer = clock(), calls: number[] = [], hooks: PlaybackConnectionEvents[] = [];
  let destroyed = 0;
  const session = createPlaybackSession({ requestedQuality: 10000, clock: timer,
    resolve: async (_signal, context) => {
      calls.push(context.qn);
      if (calls.length === 2) throw Object.assign(new Error('metadata unavailable'), { status: 503 });
      return info(source(`signature-${calls.length}`, calls.length === 1 ? 250 : 10000));
    }, connect: async (_candidate, _signal, events) => { hooks.push(events); return { destroy() { destroyed++; } }; } });
  await flush(); hooks[0].progress?.(); session.reconnect(); await flush();
  await timer.advance(120_000); assert.deepEqual(calls, [10000, 10000]); assert.equal(hooks.length, 1); assert.equal(destroyed, 0);
  hooks[0].progress?.(); session.reconnect(); await flush();
  assert.deepEqual(calls, [10000, 10000, 10000]); assert.equal(hooks.length, 2); assert.equal(destroyed, 1);
  session.destroy(); assert.equal(timer.size(), 0);
});
