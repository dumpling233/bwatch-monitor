import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlaybackRecoveryState, createPlaybackSession, playbackCdnKey, playbackRouteKey, type PlaybackConnectionEvents } from '../client/multiview/playbackSession.js';
import type { PlaybackInfo, PlaybackSource } from '../shared/playback.js';
import { PlaybackMetadataController } from '../client/multiview/playbackMetadata';

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function clock() {
  let now = 0, next = 0;
  const timers = new Map<number, { at: number; run(): void }>();
  return {
    now: () => now,
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
const source = (id: string, quality = 250, format: 'flv' | 'fmp4' | 'ts' = 'flv'): PlaybackSource => ({
  id, actualQuality: quality, format, protocol: format === 'flv' ? 'flv' : 'hls', codec: 'avc', url: `https://${id}.bilivideo.com/live`,
});
const info = (sources: PlaybackSource[]): PlaybackInfo => ({ roomId: '1', status: 'live', requestedQuality: 250,
  sources, qualities: [{ qn: 250, label: '超清' }], resolvedAt: 0 });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test('actual requested quality outranks preferred and previously healthy routes, inside the chosen format', async () => {
  for (const format of ['auto', 'flv'] as const) {
    const low = source('low'), high = source('high', 10000, format === 'auto' ? 'fmp4' : 'flv');
    const recovery = createPlaybackRecoveryState(); recovery.healthyRoute = playbackRouteKey(low);
    const attached: string[] = [], timer = clock();
    const session = createPlaybackSession({ requestedQuality: 10000, preferredFormat: format, preferredRoute: playbackRouteKey(low), recoveryState: recovery,
      resolve: async () => info([low, high]), connect: async candidate => { attached.push(candidate.id); return { destroy() {} }; }, clock: timer });
    await flush(); assert.deepEqual(attached, ['high']); session.destroy(); assert.equal(timer.size(), 0);
  }
});

test('a CDN preference spans formats and chooses its exact-quality HLS branch before lower-quality FLV', async () => {
  const timer = clock(), attached: string[] = [], low = source('cdn'), high = { ...source('original', 10000, 'fmp4'), url: 'https://cdn.bilivideo.com/original.m3u8' };
  const recovery = createPlaybackRecoveryState(); recovery.healthyRoute = playbackRouteKey(low);
  assert.equal(playbackCdnKey(low), playbackCdnKey(high));
  const session = createPlaybackSession({ requestedQuality: 10000, preferredRoute: playbackCdnKey(low), recoveryState: recovery,
    resolve: async () => info([source('other', 10000), low, high]),
    connect: async candidate => { attached.push(candidate.id); return { destroy() {} }; }, clock: timer });
  await flush(); assert.deepEqual(attached, ['original']); session.destroy(); assert.equal(timer.size(), 0);
});

test('selecting a CDN never locks its current format and automatic routing releases the CDN preference', async () => {
  const timer = clock(), attached: string[] = [], selected = source('target');
  let events!: PlaybackConnectionEvents;
  const session = createPlaybackSession({ autoReconnect: false, resolve: async (_signal, context) => {
    if (context.qn === 10000) return info([selected, { ...source('original', 10000, 'fmp4'), url: 'https://target.bilivideo.com/original.m3u8' }]);
    if (context.qn === 400) return info([source('other', 400), { ...source('target-high', 400), url: selected.url }]);
    return info([source('first'), selected]);
  }, connect: async (candidate, _signal, hooks) => { attached.push(candidate.id); events = hooks; return { destroy() {} }; }, clock: timer });
  await flush(); session.selectRoute(playbackCdnKey(selected)); await flush();
  session.updateQuality(10000); await flush();
  assert.deepEqual(attached, ['first', 'target', 'original']);
  events.failed(); await flush(); // No live connection remains to retain as a healthy route.
  session.selectRoute(null); session.updateQuality(400); await flush();
  assert.deepEqual(attached, ['first', 'target', 'original', 'other']); session.destroy(); assert.equal(timer.size(), 0);
});

test('a failing preferred CDN tries its other format before falling back to a different CDN', async () => {
  const timer = clock(), attached: string[] = [], first = source('preferred');
  const alternate = { ...source('same-host', 250, 'fmp4'), url: 'https://preferred.bilivideo.com/stream.m3u8' };
  let events!: PlaybackConnectionEvents;
  const session = createPlaybackSession({ preferredRoute: playbackCdnKey(first), resolve: async () => info([first, source('backup'), alternate]),
    connect: async (candidate, _signal, hooks) => { attached.push(candidate.id); events = hooks; return { destroy() {} }; }, clock: timer });
  await flush(); events.failed({ kind: 'network' }); await flush(); events.failed({ kind: 'network' }); await flush();
  assert.deepEqual(attached, ['preferred', 'same-host', 'backup']); session.destroy(); assert.equal(timer.size(), 0);
});

test('selecting an audio CDN preserves the explicit video format when returning to video', async () => {
  const timer = clock(), attached: string[] = [], hooks: PlaybackConnectionEvents[] = [];
  const first = source('audio-one'), second = source('audio-two'), video = source('video', 250, 'fmp4');
  const session = createPlaybackSession({ preferredFormat: 'hls-fmp4',
    resolve: async () => info([first, second, video]), clock: timer,
    connect: async (candidate, _signal, events, mode) => { attached.push(`${mode}:${candidate.id}`); hooks.push(events); return { destroy() {} }; } });
  await flush(); hooks.at(-1)!.progress?.();
  session.setMediaMode('audio'); await flush(); hooks.at(-1)!.progress?.();
  session.selectRoute(playbackRouteKey(second)); await flush(); hooks.at(-1)!.progress?.();
  session.setMediaMode('video'); await flush();
  assert.deepEqual(attached, ['video:video', 'audio:audio-one', 'audio:audio-two', 'video:video']);
  session.destroy(); assert.equal(timer.size(), 0);
});

test('only true progress commits the source; playing and an unsuccessful attempt cannot claim actual playback', async () => {
  let events!: PlaybackConnectionEvents;
  const committed: string[] = [], pending: (string | null)[] = [], timer = clock();
  const session = createPlaybackSession({ resolve: async () => info([source('one')]),
    connect: async (_source, _signal, hooks) => { events = hooks; return { destroy() {} }; },
    onSource: candidate => committed.push(candidate.id), onPendingSource: candidate => pending.push(candidate?.id ?? null), clock: timer });
  await flush(); events.playing(); assert.deepEqual(committed, []); assert.deepEqual(pending, ['one']);
  events.progress?.(); assert.deepEqual(committed, ['one']); assert.equal(pending.at(-1), null);
  events.progress?.(); assert.deepEqual(committed, ['one']); session.destroy();
});

test('changing format reuses valid metadata, retains quality intent and refreshes only when the format is absent', async () => {
  const timer = clock(), attached: string[] = []; let calls = 0;
  const session = createPlaybackSession({ requestedQuality: 10000,
    resolve: async () => { calls++; return info([source('flv', 10000), source('hls', 250, 'fmp4')]); },
    connect: async candidate => { attached.push(candidate.id); return { destroy() {} }; }, clock: timer });
  await flush(); session.selectFormat('hls-fmp4'); await flush();
  assert.deepEqual(attached, ['flv', 'hls']); assert.equal(calls, 1);
  session.selectFormat('hls-ts'); await flush(); assert.equal(calls, 2); assert.deepEqual(attached, ['flv', 'hls']);
  session.destroy(); assert.equal(timer.size(), 0);
});

test('selecting a new format and CDN together connects only the requested candidate', async () => {
  const timer = clock(), attached: string[] = [], target = source('target', 250, 'fmp4');
  const session = createPlaybackSession({ resolve: async () => info([source('flv'), source('first', 250, 'fmp4'), target]),
    connect: async candidate => { attached.push(candidate.id); return { destroy() {} }; }, clock: timer });
  await flush(); session.selectFormat('hls-fmp4', playbackRouteKey(target)); session.selectRoute(playbackRouteKey(target)); await flush();
  assert.deepEqual(attached, ['flv', 'target']); session.destroy(); assert.equal(timer.size(), 0);
});

test('known browser incompatibility excludes a format without a connection attempt or a retry loop', async () => {
  const timer = clock(), states: string[] = []; let connections = 0, resolves = 0;
  const session = createPlaybackSession({ preferredFormat: 'hls-fmp4', supportsSource: () => false,
    resolve: async () => { resolves++; return info([source('hls', 250, 'fmp4')]); },
    connect: async () => { connections++; return { destroy() {} }; }, onStatus: state => states.push(state), clock: timer });
  await flush(); assert.equal(states.at(-1), 'unsupported'); await timer.advance(120_000);
  assert.equal(connections, 0); assert.equal(resolves, 1); session.destroy();
});

const metadataContext = (quality = 250) => ({ identityScope: 'account:permission1', rpcScope: 'worker1', quality,
  needed: true, visible: true, online: true, menuOpen: false });

test('independent menu requests merge callers and never reconnect healthy media for equal or different signatures', async () => {
  for (const changed of [false, true]) {
    const timer = clock(), pending = deferred<PlaybackInfo>(), committed: string[] = [];
    let mediaCalls = 0, menuCalls = 0, connections = 0, destroyed = 0; let events!: PlaybackConnectionEvents;
    const controller = new PlaybackMetadataController({ roomId: '1', clock: timer,
      resolve: () => { menuCalls++; return pending.promise; } });
    controller.setContext({ ...metadataContext(), needed: false });
    const initial = info([source('old')]);
    const session = createPlaybackSession({ resolve: async () => { mediaCalls++; return initial; },
      connect: async (_source, _signal, hooks) => { connections++; events = hooks; return { destroy() { destroyed++; } }; },
      onInfo: value => controller.observe(value), onSource: value => committed.push(value.id), clock: timer });
    await flush(); events.progress?.(); await timer.advance(31_000);
    controller.setContext(metadataContext());
    const first = controller.ensureMetadata(), second = controller.ensureMetadata(); assert.equal(first, second);
    await flush(); assert.equal(menuCalls, 1);
    pending.resolve({ ...info([source(changed ? 'fresh' : 'old')]), resolvedAt: timer.now() }); await first;
    assert.equal(controller.getSnapshot().state, 'ready'); assert.equal(mediaCalls, 1);
    assert.equal(connections, 1); assert.equal(destroyed, 0); assert.deepEqual(committed, ['old']);
    controller.dispose(); session.destroy(); assert.equal(timer.size(), 0);
  }
});

test('failed explicit menu work stays idle and preserves the scheduled media recovery deadline', async () => {
  const timer = clock(), attached: string[] = []; let events!: PlaybackConnectionEvents, mediaCalls = 0, menuCalls = 0;
  const controller = new PlaybackMetadataController({ roomId: '1', clock: timer, resolve: async () => {
    menuCalls++; throw Object.assign(new Error('unavailable'), { status: 503 });
  } });
  controller.setContext({ ...metadataContext(), needed: false });
  const session = createPlaybackSession({ resolve: async () => { mediaCalls++; return { ...info([source('old')]), resolvedAt: timer.now() }; },
    connect: async (candidate, _signal, hooks) => { attached.push(candidate.id); events = hooks; return { destroy() {} }; },
    onInfo: value => controller.observe(value), clock: timer });
  await flush(); events.progress?.(); events.failed({ kind: 'network' }); await flush();
  controller.setContext({ ...metadataContext(), rpcScope: 'worker2' });
  await assert.rejects(controller.ensureRoutes(250)); await flush();
  assert.equal(controller.getSnapshot().state, 'error');
  assert.equal(controller.getSnapshot().info?.sources[0].id, 'old');
  await timer.advance(2_000); assert.equal(menuCalls, 1); assert.equal(mediaCalls, 1);
  await timer.advance(3_000); assert.equal(mediaCalls, 2); assert.deepEqual(attached, ['old', 'old']);
  controller.dispose(); session.destroy(); assert.equal(timer.size(), 0);
});

test('loading menu metadata while media is offline does not start playback or change media status', async () => {
  const timer = clock(), states: string[] = []; let connections = 0;
  const controller = new PlaybackMetadataController({ roomId: '1', clock: timer,
    resolve: async () => info([source('fresh')]) });
  const session = createPlaybackSession({ autoReconnect: false, resolve: async () => ({ ...info([]), status: 'offline' }),
    connect: async () => { connections++; return { destroy() {} }; }, onStatus: value => states.push(value), clock: timer });
  await flush(); const before = [...states]; controller.setContext(metadataContext()); await controller.ensureMetadata();
  assert.equal(connections, 0); assert.deepEqual(states, before);
  assert.equal(controller.getSnapshot().info?.sources[0].id, 'fresh');
  controller.dispose(); session.destroy(); assert.equal(timer.size(), 0);
});

test('permission identity revocation cancels menu work and owner releases media; late data cannot restore either', async () => {
  const timer = clock(), pending = deferred<PlaybackInfo>(); let destroyed = 0, requestSignal!: AbortSignal;
  const controller = new PlaybackMetadataController({ roomId: '1', clock: timer, resolve: (_qn, signal) => {
    requestSignal = signal; return pending.promise;
  } });
  controller.setContext({ ...metadataContext(), needed: false });
  const session = createPlaybackSession({ resolve: async () => info([source('old')]),
    connect: async () => ({ destroy() { destroyed++; } }), onInfo: value => controller.observe(value), clock: timer });
  await flush(); controller.setContext({ ...metadataContext(), rpcScope: 'worker2' });
  const selection = controller.ensureRoutes(250), rejected = assert.rejects(selection, { name: 'AbortError' }); await flush();
  controller.setContext({ ...metadataContext(), identityScope: 'account:permission2', needed: false }); session.destroy();
  assert.equal(requestSignal.aborted, true); await rejected; assert.equal(destroyed, 1);
  assert.equal(controller.getSnapshot().info, undefined); assert.equal(controller.getSnapshot().state, 'idle');
  pending.resolve(info([source('late')])); await flush();
  assert.equal(controller.getSnapshot().info, undefined); assert.equal(destroyed, 1);
  controller.dispose(); assert.equal(timer.size(), 0);
});

test('explicit CDN selection adopts fresh actual-QN routes despite an original-quality preference without refetching it', async () => {
  const timer = clock(), attached: string[] = [], committed: string[] = [], metadataQns: number[] = [];
  const old = source('old'), target = source('target'); let events!: PlaybackConnectionEvents, mediaCalls = 0;
  const initial = { ...info([old]), requestedQuality: 10000 };
  const controller = new PlaybackMetadataController({ roomId: '1', clock: timer, resolve: async qn => {
    metadataQns.push(qn); return { ...info([source('backup'), target]), requestedQuality: qn, resolvedAt: timer.now() };
  } });
  controller.setContext({ ...metadataContext(), needed: false });
  const session = createPlaybackSession({ requestedQuality: 10000, resolve: async () => { mediaCalls++; return initial; },
    connect: async (candidate, _signal, hooks) => { attached.push(candidate.id); events = hooks; return { destroy() {} }; },
    onInfo: value => controller.observe(value), onSource: value => committed.push(value.id), clock: timer });
  await flush(); events.progress?.(); await timer.advance(31_000); controller.setContext(metadataContext());
  const fresh = await controller.ensureRoutes(250); session.selectRoute(playbackCdnKey(target), fresh); await flush();
  assert.deepEqual(metadataQns, [250]); assert.equal(mediaCalls, 1); assert.deepEqual(attached, ['old', 'target']);
  assert.deepEqual(committed, ['old']); events.playing(); assert.deepEqual(committed, ['old']);
  events.progress?.(); assert.deepEqual(committed, ['old', 'target']);
  controller.dispose(); session.destroy(); assert.equal(timer.size(), 0);
});

test('unusable or rate-limited menu candidates cannot claim a new actual source', async () => {
  for (const variant of ['expired', 'unsupported-quality', 'limited'] as const) {
    const timer = clock(), committed: string[] = [], attached: string[] = []; let events!: PlaybackConnectionEvents;
    const controller = new PlaybackMetadataController({ roomId: '1', clock: timer, resolve: async qn => {
      if (variant === 'limited') throw Object.assign(new Error('limited'), { status: 429, retryAfter: 40 });
      const candidate = { ...source('target', variant === 'unsupported-quality' ? 400 : 250), expiresAt: variant === 'expired' ? timer.now() + 500 : timer.now() + 60_000 };
      return { ...info([candidate]), requestedQuality: qn, resolvedAt: timer.now() };
    } });
    controller.setContext({ ...metadataContext(), needed: false });
    const session = createPlaybackSession({ resolve: async () => info([source('old')]),
      connect: async (candidate, _signal, hooks) => { attached.push(candidate.id); events = hooks; return { destroy() {} }; },
      onInfo: value => controller.observe(value), onSource: value => committed.push(value.id), clock: timer });
    await flush(); events.progress?.(); await timer.advance(31_000); controller.setContext(metadataContext());
    await assert.rejects(controller.ensureRoutes(250));
    assert.deepEqual(attached, ['old']); assert.deepEqual(committed, ['old']);
    controller.dispose(); session.destroy(); assert.equal(timer.size(), 0);
  }
});

test('format switch invalidates a late quality response and a failed new format restores the last real source once', async () => {
  const timer = clock(), pending = deferred<PlaybackInfo>(), attached: string[] = [];
  let events!: PlaybackConnectionEvents, requestSignal!: AbortSignal;
  const session = createPlaybackSession({ resolve: async (signal, context) => {
    if (context.reason === 'quality') { requestSignal = signal; return pending.promise; }
    return info([source('flv'), source('hls', 250, 'fmp4')]);
  }, connect: async (candidate, _signal, hooks) => { attached.push(candidate.id); events = hooks;
    if (candidate.id === 'hls') hooks.failed({ kind: 'media' }); return { destroy() {} }; }, clock: timer });
  await flush(); events.progress?.(); session.updateQuality(10000); session.selectFormat('hls-fmp4'); await flush();
  assert.equal(requestSignal.aborted, true); assert.deepEqual(attached, ['flv', 'hls', 'flv']);
  pending.resolve(info([source('late', 10000)])); await flush(); assert.deepEqual(attached, ['flv', 'hls', 'flv']);
  session.destroy(); assert.equal(timer.size(), 0);
});

test('returning to automatic format can restore an exact-quality branch from a forced lower-quality format', async () => {
  const timer = clock(), attached: string[] = [];
  const session = createPlaybackSession({ requestedQuality: 10000, preferredFormat: 'flv',
    resolve: async () => info([source('low'), source('original', 10000, 'fmp4')]),
    connect: async candidate => { attached.push(candidate.id); return { destroy() {} }; }, clock: timer });
  await flush(); assert.deepEqual(attached, ['low']); session.selectFormat('auto'); await flush();
  assert.deepEqual(attached, ['low', 'original']); session.destroy(); assert.equal(timer.size(), 0);
});

test('repeated short buffers use a same-quality alternate only after the startup window and cool down the old route', async () => {
  const timer = clock(), recovery = createPlaybackRecoveryState(), attached: string[] = [];
  let events!: PlaybackConnectionEvents;
  const session = createPlaybackSession({ recoveryState: recovery, resolve: async () => info([source('old'), source('next')]),
    connect: async (candidate, _signal, hooks) => { attached.push(candidate.id); events = hooks; return { destroy() {} }; }, clock: timer });
  await flush(); events.progress?.();
  events.buffering?.('start'); await timer.advance(6_000); events.buffering?.('end'); events.progress?.(); assert.deepEqual(attached, ['old']);
  await timer.advance(15_000);
  for (let i = 0; i < 3; i++) { events.buffering?.('start'); await timer.advance(5_000); events.buffering?.('end'); events.playing(); events.progress?.(); await flush(); }
  assert.deepEqual(attached, ['old', 'next']); assert.equal(recovery.routes.get(playbackRouteKey(source('old')))?.failedUntil, timer.now() + 60_000);
  session.destroy(); assert.equal(timer.size(), 0);
});

test('buffer optimization respects auto-off, foreground, media mode, format and same-actual-quality constraints', async () => {
  for (const variant of ['auto-off', 'background', 'audio', 'different-format', 'different-quality'] as const) {
    const timer = clock(), attached: string[] = []; let events!: PlaybackConnectionEvents;
    const alternate = source('next', variant === 'different-quality' ? 400 : 250, variant === 'different-format' ? 'fmp4' : 'flv');
    const session = createPlaybackSession({ autoReconnect: variant !== 'auto-off', mediaMode: variant === 'audio' ? 'audio' : 'video',
      preferredFormat: variant === 'different-format' ? 'flv' : 'auto', isForeground: () => variant !== 'background',
      resolve: async () => info([source('old'), alternate]), connect: async (candidate, _signal, hooks) => { attached.push(candidate.id); events = hooks; return { destroy() {} }; }, clock: timer });
    await flush(); events.progress?.(); await timer.advance(15_000);
    for (let i = 0; i < 3; i++) { events.buffering?.('start'); await timer.advance(5_000); events.buffering?.('end'); events.progress?.(); }
    assert.deepEqual(attached, ['old'], variant); session.destroy(); assert.equal(timer.size(), 0);
  }
});

test('a queued buffer optimization survives ordinary progress but is cancelled when the tile leaves the foreground', async () => {
  for (const leaveForeground of [false, true]) {
    const timer = clock(), attached: string[] = [], queued: { run(): void; signal: AbortSignal }[] = [];
    const recovery = createPlaybackRecoveryState(); let events!: PlaybackConnectionEvents, foreground = true;
    const session = createPlaybackSession({ recoveryState: recovery, isForeground: () => foreground,
      enqueueRecovery(action, signal) { queued.push({ run: action, signal }); return () => {}; },
      resolve: async () => info([source('old'), source('next')]),
      connect: async (candidate, _signal, hooks) => { attached.push(candidate.id); events = hooks; return { destroy() {} }; }, clock: timer });
    await flush(); events.progress?.(); await timer.advance(15_000);
    for (let i = 0; i < 3; i++) { events.buffering?.('start'); await timer.advance(5_000); events.buffering?.('end'); events.progress?.(); }
    assert.equal(queued.length, 1); assert.equal(recovery.routes.has(playbackRouteKey(source('old'))), false);
    await timer.advance(1_000); events.progress?.(); assert.equal(queued[0].signal.aborted, false);
    if (leaveForeground) { foreground = false; session.checkHealth?.(true); }
    queued[0].run(); await flush();
    assert.deepEqual(attached, leaveForeground ? ['old'] : ['old', 'next']);
    assert.equal(recovery.routes.has(playbackRouteKey(source('old'))), !leaveForeground);
    session.destroy(); assert.equal(timer.size(), 0);
  }
});

test('thirty real half-second interruptions can recover from an already returned route without another resolve', async () => {
  const timer = clock(), attached: string[] = [], committed: string[] = [];
  let events!: PlaybackConnectionEvents, resolves = 0;
  const session = createPlaybackSession({ resolve: async () => { resolves++; return info([source('old'), source('next')]); },
    connect: async (candidate, _signal, hooks) => { attached.push(candidate.id); events = hooks; return { destroy() {} }; },
    onSource: candidate => committed.push(candidate.id), clock: timer });
  await flush(); events.progress?.(); await timer.advance(15_000);
  const original = events;
  for (let i = 0; i < 30; i++) {
    original.buffering?.('start'); await timer.advance(500); original.buffering?.('end');
    original.playing(); original.progress?.(); await flush();
    if (i < 29) assert.deepEqual(attached, ['old']);
  }
  assert.deepEqual(attached, ['old', 'next']);
  assert.equal(resolves, 1);
  assert.deepEqual(committed, ['old']);
  events.playing(); assert.deepEqual(committed, ['old']);
  events.progress?.(); assert.deepEqual(committed, ['old', 'next']);
  session.destroy(); assert.equal(timer.size(), 0);
});

test('sub-two-second native interruptions accumulate but warnings and delayed progress cannot inflate their duration', async () => {
  const timer = clock(), attached: string[] = [];
  let events!: PlaybackConnectionEvents, resolves = 0;
  const session = createPlaybackSession({ resolve: async () => { resolves++; return info([source('old'), source('next')]); },
    connect: async (candidate, _signal, hooks) => { attached.push(candidate.id); events = hooks; return { destroy() {} }; }, clock: timer });
  await flush(); events.progress?.(); await timer.advance(15_000);
  // Library warnings still arrive through waiting(), without any native starvation.
  for (let i = 0; i < 4; i++) { events.waiting?.(); await timer.advance(5_000); events.progress?.(); }
  assert.deepEqual(attached, ['old']);
  const original = events;
  for (let i = 0; i < 7; i++) {
    original.buffering?.('start'); await timer.advance(1_900); original.buffering?.('end');
    original.playing(); await timer.advance(250); original.progress?.();
  }
  // Actual interruption = 13.3s; the seven delayed timeupdates must not add 1.75s.
  assert.deepEqual(attached, ['old']);
  original.buffering?.('start'); await timer.advance(1_700); original.buffering?.('end'); await flush();
  assert.deepEqual(attached, ['old', 'next']); assert.equal(resolves, 1);
  session.destroy(); assert.equal(timer.size(), 0);
});

test('cancelled and sub-half-second interruptions do not count and returning from the background clears old spans', async () => {
  const timer = clock(), attached: string[] = []; let foreground = true;
  let events!: PlaybackConnectionEvents;
  const session = createPlaybackSession({ isForeground: () => foreground, resolve: async () => info([source('old'), source('next')]),
    connect: async (candidate, _signal, hooks) => { attached.push(candidate.id); events = hooks; return { destroy() {} }; }, clock: timer });
  await flush(); events.progress?.(); await timer.advance(15_000);
  for (let i = 0; i < 40; i++) { events.buffering?.('start'); await timer.advance(499); events.buffering?.('end'); events.progress?.(); }
  for (let i = 0; i < 3; i++) { events.buffering?.('start'); await timer.advance(5_000); events.buffering?.('cancel'); events.progress?.(); }
  assert.deepEqual(attached, ['old']);
  for (let i = 0; i < 2; i++) { events.buffering?.('start'); await timer.advance(5_000); events.buffering?.('end'); events.progress?.(); }
  events.buffering?.('start'); await timer.advance(2_000);
  foreground = false; session.checkHealth?.(true); await timer.advance(30_000);
  foreground = true; events.buffering?.('end'); events.progress?.();
  events.buffering?.('start'); await timer.advance(5_000); events.buffering?.('end'); events.progress?.();
  assert.deepEqual(attached, ['old']);
  for (let i = 0; i < 2; i++) { events.buffering?.('start'); await timer.advance(5_000); events.buffering?.('end'); events.progress?.(); }
  assert.deepEqual(attached, ['old', 'next']);
  session.destroy(); const attachedBefore = [...attached];
  events.buffering?.('start'); await timer.advance(20_000); events.buffering?.('end');
  assert.deepEqual(attached, attachedBefore); assert.equal(timer.size(), 0);
});

test('actual buffer recovery keeps the sixty-second switching cooldown across connections', async () => {
  const timer = clock(), attached: string[] = [];
  let events!: PlaybackConnectionEvents, resolves = 0;
  const session = createPlaybackSession({ resolve: async () => { resolves++; return info([source('old'), source('next'), source('third')]); },
    connect: async (candidate, _signal, hooks) => { attached.push(candidate.id); events = hooks; return { destroy() {} }; }, clock: timer });
  const interrupt = async (ms: number) => { const current = events; current.buffering?.('start'); await timer.advance(ms); current.buffering?.('end'); current.progress?.(); await flush(); };
  await flush(); events.progress?.(); await timer.advance(15_000);
  for (let i = 0; i < 3; i++) await interrupt(5_000);
  assert.deepEqual(attached, ['old', 'next']);
  events.progress?.(); await timer.advance(15_000);
  for (let i = 0; i < 3; i++) await interrupt(5_000);
  assert.deepEqual(attached, ['old', 'next']);
  await timer.advance(30_000); await interrupt(500);
  assert.deepEqual(attached, ['old', 'next', 'third']); assert.equal(resolves, 1);
  session.destroy(); assert.equal(timer.size(), 0);
});

test('explicit reconnect and mode changes discard interruption history before their pending metadata completes', async () => {
  for (const action of ['reconnect', 'media-mode'] as const) {
    const timer = clock(), attached: string[] = [], pending = deferred<PlaybackInfo>();
    let events!: PlaybackConnectionEvents, resolves = 0;
    const session = createPlaybackSession({ resolve: async () => ++resolves === 1 ? info([source('old'), source('next')]) : pending.promise,
      connect: async (candidate, _signal, hooks) => { attached.push(candidate.id); events = hooks; return { destroy() {} }; }, clock: timer });
    const interrupt = async () => {
      const current = events; current.buffering?.('start'); await timer.advance(5_000); current.buffering?.('end'); current.progress?.(); await flush();
    };
    await flush(); events.progress?.(); await timer.advance(15_000);
    await interrupt(); await interrupt();
    events.buffering?.('start'); await timer.advance(1_000);
    if (action === 'reconnect') session.reconnect(); else session.setMediaMode('audio');
    await flush(); events.buffering?.('end');
    pending.reject(new Error('temporary metadata failure')); await flush();
    await interrupt(); await interrupt();
    assert.deepEqual(attached, ['old'], action);
    await interrupt(); assert.deepEqual(attached, ['old', 'next'], action);
    assert.equal(resolves, 2, action);
    session.destroy(); assert.equal(timer.size(), 0);
  }
});

test('a failed buffer optimization returns to the former source once through the recovery gate without another resolve', async () => {
  for (const failure of ['network', 'unsupported'] as const) {
    const timer = clock(), attached: string[] = [], notices: Array<string | undefined> = [];
    const queued: { run(): void; signal: AbortSignal }[] = [];
    let events!: PlaybackConnectionEvents, resolves = 0;
    const session = createPlaybackSession({
      enqueueRecovery(action, signal) { queued.push({ run: action, signal }); return () => {}; },
      resolve: async () => { resolves++; return info([source('old'), source('bad'), source('third')]); },
      connect: async (candidate, _signal, hooks) => { attached.push(candidate.id); events = hooks; return { destroy() {} }; },
      onStatus: (_state, message) => notices.push(message), clock: timer,
    });
    await flush(); events.progress?.(); await timer.advance(15_000);
    for (let i = 0; i < 3; i++) { events.buffering?.('start'); await timer.advance(5_000); events.buffering?.('end'); events.progress?.(); }
    assert.equal(queued.length, 1); assert.deepEqual(attached, ['old']);
    queued[0].run(); await flush(); assert.deepEqual(attached, ['old', 'bad']);
    const failedReplacement = events;
    failedReplacement.failed(failure === 'network' ? { kind: 'network', httpStatus: 403 } : { kind: 'unsupported' }); await flush();
    assert.equal(queued.length, 2);
    assert.deepEqual(attached, ['old', 'bad']); // Returning also waits for the shared gate.
    queued[1].run(); await flush(); assert.deepEqual(attached, ['old', 'bad', 'old']);
    assert.ok(notices.some(message => message === '备用线路暂不可用，正在恢复此前线路'));
    events.progress?.();
    failedReplacement.failed({ kind: 'network' }); await flush();
    assert.deepEqual(attached, ['old', 'bad', 'old']);
    // The one return is consumed; a real failure of the former source resumes ordinary recovery.
    events.failed({ kind: 'network' }); await flush(); assert.equal(queued.length, 3);
    queued[2].run(); await flush(); assert.deepEqual(attached, ['old', 'bad', 'old', 'third']);
    assert.equal(resolves, 1);
    session.destroy(); assert.equal(timer.size(), 0);
  }
});

test('buffer optimization keeps a return until real sustained health, then resumes ordinary hard-failure recovery', async () => {
  for (const sustained of [false, true]) {
    const timer = clock(), attached: string[] = [];
    let events!: PlaybackConnectionEvents, resolves = 0;
    const session = createPlaybackSession({ resolve: async () => { resolves++; return info([source('old'), source('next'), source('third')]); },
      connect: async (candidate, _signal, hooks) => { attached.push(candidate.id); events = hooks; return { destroy() {} }; }, clock: timer });
    await flush(); events.progress?.(); await timer.advance(15_000);
    for (let i = 0; i < 3; i++) { events.buffering?.('start'); await timer.advance(5_000); events.buffering?.('end'); events.progress?.(); }
    assert.deepEqual(attached, ['old', 'next']);
    events.playing(); events.progress?.();
    if (sustained) for (let i = 0; i < 31; i++) { await timer.advance(1_000); events.progress?.(); }
    else await timer.advance(1_000);
    events.failed({ kind: 'network' }); await flush();
    assert.deepEqual(attached, sustained ? ['old', 'next', 'third'] : ['old', 'next', 'old']);
    assert.equal(resolves, 1);
    session.destroy(); assert.equal(timer.size(), 0);
  }
});

test('expired former media and rate-limit cooldown cannot be bypassed by an optimization return', async () => {
  for (const limited of [false, true]) {
    const timer = clock(), attached: string[] = [];
    const old = limited ? source('old') : { ...source('old'), expiresAt: 120_000 };
    let events!: PlaybackConnectionEvents, resolves = 0;
    const session = createPlaybackSession({ resolve: async () => { resolves++; return info([old, source('next'), source('third')]); },
      connect: async (candidate, _signal, hooks) => { attached.push(candidate.id); events = hooks; return { destroy() {} }; }, clock: timer });
    await flush(); events.progress?.(); await timer.advance(15_000);
    for (let i = 0; i < 3; i++) { events.buffering?.('start'); await timer.advance(5_000); events.buffering?.('end'); events.progress?.(); }
    assert.deepEqual(attached, ['old', 'next']);
    if (limited) events.failed({ kind: 'cooldown', httpStatus: 429, retryAfter: 30 });
    else { await timer.advance(91_000); events.failed({ kind: 'network' }); }
    await flush();
    assert.deepEqual(attached, limited ? ['old', 'next'] : ['old', 'next', 'third']);
    assert.equal(resolves, 1);
    session.destroy(); assert.equal(timer.size(), 0);
  }
});
