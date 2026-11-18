import assert from 'node:assert/strict';
import test from 'node:test';
import type { PlaybackInfo, PlaybackMediaMode, PlaybackSource } from '../shared/playback.js';
import { createPlaybackRecoveryState, createPlaybackSession, playbackRouteKey, type PlaybackConnectionEvents, type PlaybackFailure } from '../client/multiview/playbackSession.js';
import { connectPlaybackSource } from '../client/multiview/playbackAdapters.js';

const flush = async () => { for (let index = 0; index < 16; index++) await Promise.resolve(); };
// Native `playing` is only an event; confirmed mode transitions need actual media advancement.
const progressed = (events: PlaybackConnectionEvents) => { events.playing(); events.progress?.(); };
function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function fakeClock() {
  let time = 0, sequence = 0;
  const timers = new Map<number, { callback(): void; at: number }>();
  return {
    now: () => time,
    setTimeout(callback: () => void, delay: number) { const id = ++sequence; timers.set(id, { callback, at: time + delay }); return id; },
    clearTimeout(handle: unknown) { timers.delete(handle as number); },
    size: () => timers.size,
    async advance(duration: number) {
      const end = time + duration;
      for (;;) {
        const next = [...timers].filter(([, value]) => value.at <= end).sort((first, second) => first[1].at - second[1].at)[0];
        if (!next) break;
        time = next[1].at; timers.delete(next[0]); next[1].callback(); await flush();
      }
      time = end; await flush();
    },
  };
}
const flv: PlaybackSource = { id: 'flv', url: 'https://flv.example/live.flv', protocol: 'flv', format: 'flv', codec: 'avc', actualQuality: 250 };
const backupFlv: PlaybackSource = { ...flv, id: 'flv-backup', url: 'https://backup.example/live.flv' };
const hls: PlaybackSource = { ...flv, id: 'hls', url: 'https://hls.example/live.m3u8', protocol: 'hls', format: 'fmp4' };
const info = (sources = [hls, flv]): PlaybackInfo => ({ roomId: '1', status: 'live', requestedQuality: 250,
  qualities: [{ qn: 250, label: '超清' }], sources, resolvedAt: 0 });

test('audio mode filters HLS, preserves the requested quality and restores the video route', async () => {
  const clock = fakeClock(), attached: Array<{ source: string; mode: PlaybackMediaMode }> = [];
  const hooks: PlaybackConnectionEvents[] = [], requested: number[] = [], reported: string[][] = [];
  let engines = 0;
  const session = createPlaybackSession({
    requestedQuality: 10000, preferredRoute: playbackRouteKey(hls), clock,
    resolve: async (_signal, context) => { requested.push(context.qn); return info(); },
    connect: async (source, _signal, events, mode) => {
      assert.equal(engines, 0); engines++;
      attached.push({ source: source.id, mode }); hooks.push(events);
      return { destroy() { engines--; } };
    }, onInfo: value => reported.push(value.sources.map(source => source.id)),
  });
  await flush(); progressed(hooks[0]);
  session.setMediaMode('audio'); await flush(); progressed(hooks[1]);
  session.setMediaMode('audio'); await flush();
  session.setMediaMode('video'); await flush(); progressed(hooks[2]);
  assert.deepEqual(attached, [{ source: 'hls', mode: 'video' }, { source: 'flv', mode: 'audio' }, { source: 'hls', mode: 'video' }]);
  assert.deepEqual(requested, [10000, 10000, 10000]);
  assert.deepEqual(reported, [['hls', 'flv'], ['flv'], ['hls', 'flv']]);
  session.destroy(); assert.equal(engines, 0); assert.equal(clock.size(), 0);
});

test('mode metadata failure keeps the previous stream and rejects the requested mode', async () => {
  const clock = fakeClock(), pending = deferred<PlaybackInfo>(), rejected: PlaybackMediaMode[] = [];
  const hooks: PlaybackConnectionEvents[] = [];
  let requests = 0, connections = 0, destroyed = 0;
  const session = createPlaybackSession({ clock, autoReconnect: false,
    resolve: async () => ++requests === 1 ? info() : pending.promise,
    connect: async (_source, _signal, events) => { connections++; hooks.push(events); return { destroy() { destroyed++; } }; },
    onMediaModeRejected: mode => rejected.push(mode),
  });
  await flush(); progressed(hooks[0]);
  session.setMediaMode('audio'); await flush();
  assert.equal(destroyed, 0);
  pending.reject(new Error('network')); await flush();
  assert.deepEqual(rejected, ['video']); assert.equal(connections, 1); assert.equal(destroyed, 0);
  session.destroy(); assert.equal(clock.size(), 0);
});

test('a room without FLV leaves the previous video playing without publishing incompatible routes', async () => {
  const clock = fakeClock(), rejected: PlaybackMediaMode[] = [];
  let requests = 0, destroyed = 0, attached = 0;
  let hooks!: PlaybackConnectionEvents;
  const session = createPlaybackSession({ clock,
    resolve: async () => ++requests === 1 ? info() : info([hls]),
    connect: async (_source, _signal, events) => { attached++; hooks = events; return { destroy() { destroyed++; } }; },
    onMediaModeRejected: mode => rejected.push(mode),
  });
  await flush(); progressed(hooks); session.setMediaMode('audio'); await flush();
  assert.equal(attached, 1); assert.equal(destroyed, 0); assert.deepEqual(rejected, ['video']);
  session.destroy(); assert.equal(clock.size(), 0);
});

test('audio adapter failure restores the previous mode with only one media engine', async () => {
  const clock = fakeClock(), rejected: PlaybackMediaMode[] = [], attached: PlaybackMediaMode[] = [];
  const hooks: PlaybackConnectionEvents[] = [];
  let engines = 0;
  const session = createPlaybackSession({ clock, autoReconnect: false, resolve: async () => info(),
    connect: async (_source, _signal, events, mode) => {
      assert.equal(engines, 0); engines++; attached.push(mode); hooks.push(events);
      return { destroy() { engines--; } };
    }, onMediaModeRejected: mode => rejected.push(mode),
  });
  await flush(); progressed(hooks[0]); session.setMediaMode('audio'); await flush();
  hooks[1].failed('unsupported'); await flush(); progressed(hooks[2]);
  assert.deepEqual(attached, ['video', 'audio', 'video']); assert.deepEqual(rejected, ['video']);
  hooks[1].failed(); await flush(); assert.equal(attached.length, 3);
  session.destroy(); assert.equal(engines, 0); assert.equal(clock.size(), 0);
});

for (const automatic of [true, false]) test(`an interactive audio switch tries a backup after the first CDN returns 403 with auto reconnect ${automatic}`, async () => {
  const clock = fakeClock(), rejected: PlaybackMediaMode[] = [];
  const hooks: PlaybackConnectionEvents[] = [], attached: Array<{ source: string; mode: PlaybackMediaMode }> = [];
  let engines = 0;
  const session = createPlaybackSession({ clock, autoReconnect: automatic, resolve: async () => info([hls, flv, backupFlv]),
    connect: async (source, _signal, events, mode) => {
      assert.equal(engines, 0); engines++; hooks.push(events); attached.push({ source: source.id, mode });
      return { destroy() { engines--; } };
    }, onMediaModeRejected: mode => rejected.push(mode),
  });
  await flush(); progressed(hooks[0]); session.setMediaMode('audio'); await flush();
  hooks[1].failed({ kind: 'network', httpStatus: 403 }); await flush();
  assert.deepEqual(attached, [{ source: 'hls', mode: 'video' }, { source: 'flv', mode: 'audio' }, { source: 'flv-backup', mode: 'audio' }]);
  assert.deepEqual(rejected, []); progressed(hooks[2]);
  await clock.advance(15_000);
  assert.deepEqual(rejected, []); assert.equal(attached.length, 3); assert.equal(engines, 1);
  session.destroy(); assert.equal(engines, 0); assert.equal(clock.size(), 0);
});

test('an interactive audio switch exhausts its compatible routes before restoring video exactly once', async () => {
  const clock = fakeClock(), rejected: PlaybackMediaMode[] = [];
  const hooks: PlaybackConnectionEvents[] = [], attached: string[] = [];
  const session = createPlaybackSession({ clock, autoReconnect: false, resolve: async () => info([hls, flv, backupFlv]),
    connect: async (source, _signal, events, mode) => { hooks.push(events); attached.push(`${mode}:${source.id}`); return { destroy() {} }; },
    onMediaModeRejected: mode => rejected.push(mode),
  });
  await flush(); progressed(hooks[0]); session.setMediaMode('audio'); await flush();
  hooks[1].failed({ kind: 'network', httpStatus: 403 }); await flush();
  assert.deepEqual(rejected, []);
  hooks[2].failed({ kind: 'media' }); await flush();
  assert.deepEqual(attached, ['video:hls', 'audio:flv', 'audio:flv-backup', 'video:hls']);
  assert.deepEqual(rejected, ['video']); progressed(hooks[3]);
  hooks[1].failed(); hooks[2].failed('unsupported'); await flush(); await clock.advance(15_000);
  assert.equal(attached.length, 4); assert.deepEqual(rejected, ['video']);
  session.destroy(); assert.equal(clock.size(), 0);
});

test('the audio switch deadline remains effective after changing CDN and is not restarted for the backup', async () => {
  const clock = fakeClock(), rejected: PlaybackMediaMode[] = [];
  const hooks: PlaybackConnectionEvents[] = [], attached: string[] = [], signals: AbortSignal[] = [];
  const session = createPlaybackSession({ clock, resolveTimeoutMs: 1_000, resolve: async () => info([hls, flv, backupFlv]),
    connect: async (source, signal, events, mode) => {
      hooks.push(events); attached.push(`${mode}:${source.id}`); signals.push(signal); return { destroy() {} };
    }, onMediaModeRejected: mode => rejected.push(mode),
  });
  await flush(); progressed(hooks[0]); session.setMediaMode('audio'); await flush();
  await clock.advance(600); hooks[1].failed({ kind: 'network', httpStatus: 403 }); await flush();
  assert.equal(signals[1].aborted, true); assert.equal(signals[2].aborted, false);
  await clock.advance(399); assert.deepEqual(rejected, []);
  await clock.advance(1);
  assert.equal(signals[2].aborted, true); assert.deepEqual(rejected, ['video']);
  assert.deepEqual(attached, ['video:hls', 'audio:flv', 'audio:flv-backup', 'video:hls']);
  progressed(hooks[3]); session.destroy(); assert.equal(clock.size(), 0);
});

const immediateModeFailures: PlaybackFailure[] = [
  { kind: 'network', httpStatus: 412, retryAfter: 30 }, { kind: 'network', httpStatus: 429, retryAfter: 30 },
];
for (const reason of immediateModeFailures) test(`an audio switch does not bypass ${reason.httpStatus ?? reason.kind} by trying another CDN`, async () => {
  const clock = fakeClock(), rejected: PlaybackMediaMode[] = [];
  const hooks: PlaybackConnectionEvents[] = [], attached: string[] = [];
  const session = createPlaybackSession({ clock, resolve: async () => info([hls, flv, backupFlv]),
    connect: async (source, _signal, events, mode) => { hooks.push(events); attached.push(`${mode}:${source.id}`); return { destroy() {} }; },
    onMediaModeRejected: mode => rejected.push(mode),
  });
  await flush(); progressed(hooks[0]); session.setMediaMode('audio'); await flush();
  hooks[1].failed(reason); await flush();
  assert.deepEqual(rejected, ['video']);
  assert.equal(attached.filter(value => value.startsWith('audio:')).length, 1);
  assert.equal(attached.includes('audio:flv-backup'), false);
  session.destroy(); assert.equal(clock.size(), 0);
});

for (const cancellation of ['reverse', 'destroy'] as const) test(`old audio CDN callbacks cannot advance a switch after ${cancellation}`, async () => {
  const clock = fakeClock(), rejected: PlaybackMediaMode[] = [];
  const hooks: PlaybackConnectionEvents[] = [], attached: string[] = [];
  const session = createPlaybackSession({ clock, resolve: async () => info([hls, flv, backupFlv]),
    connect: async (source, _signal, events, mode) => { hooks.push(events); attached.push(`${mode}:${source.id}`); return { destroy() {} }; },
    onMediaModeRejected: mode => rejected.push(mode),
  });
  await flush(); progressed(hooks[0]); session.setMediaMode('audio'); await flush();
  hooks[1].failed({ kind: 'network', httpStatus: 403 }); await flush();
  assert.equal(attached.at(-1), 'audio:flv-backup');
  if (cancellation === 'reverse') { session.setMediaMode('video'); await flush(); progressed(hooks[3]); }
  else session.destroy();
  const connections = attached.length;
  hooks[1].failed(); hooks[2].failed({ kind: 'network', httpStatus: 403 }); hooks[2].playing(); await flush();
  await clock.advance(15_000);
  assert.equal(attached.length, connections); assert.deepEqual(rejected, []);
  assert.deepEqual(attached, cancellation === 'reverse'
    ? ['video:hls', 'audio:flv', 'audio:flv-backup', 'video:hls'] : ['video:hls', 'audio:flv', 'audio:flv-backup']);
  session.destroy(); assert.equal(clock.size(), 0);
});

test('an interactive mode connection must produce playback before its transition deadline', async () => {
  const clock = fakeClock(), rejected: PlaybackMediaMode[] = [];
  const hooks: PlaybackConnectionEvents[] = [], attached: PlaybackMediaMode[] = [];
  const session = createPlaybackSession({ clock, resolveTimeoutMs: 1_000, resolve: async () => info(),
    connect: async (_source, _signal, events, mode) => { attached.push(mode); hooks.push(events); return { destroy() {} }; },
    onMediaModeRejected: mode => rejected.push(mode),
  });
  await flush(); progressed(hooks[0]); session.setMediaMode('audio'); await flush();
  hooks[1].playing(); // A false-positive native event must not commit this mode.
  await clock.advance(1_000);
  assert.deepEqual(rejected, ['video']); assert.deepEqual(attached, ['video', 'audio', 'video']);
  session.destroy(); assert.equal(clock.size(), 0);
});

test('a hanging adapter import is aborted by the mode deadline and its late connection is destroyed', async () => {
  const clock = fakeClock(), pending = deferred<{ destroy(): void }>();
  const hooks: PlaybackConnectionEvents[] = [], rejected: PlaybackMediaMode[] = [];
  let lateDestroyed = 0, signal!: AbortSignal;
  const session = createPlaybackSession({ clock, resolveTimeoutMs: 1_000, resolve: async () => info(),
    connect: async (_source, current, events, mode) => {
      hooks.push(events);
      if (mode === 'audio') { signal = current; return pending.promise; }
      return { destroy() {} };
    }, onMediaModeRejected: mode => rejected.push(mode),
  });
  await flush(); progressed(hooks[0]); session.setMediaMode('audio'); await flush();
  await clock.advance(1_000); assert.equal(signal.aborted, true); assert.deepEqual(rejected, ['video']);
  pending.resolve({ destroy() { lateDestroyed++; } }); await flush(); assert.equal(lateDestroyed, 1);
  hooks[1].failed('unsupported'); assert.deepEqual(rejected, ['video']);
  session.destroy(); assert.equal(clock.size(), 0);
});

test('a failing video restoration returns to confirmed audio without altering its preferred video route', async () => {
  const clock = fakeClock(), attached: Array<{ source: string; mode: PlaybackMediaMode }> = [];
  const hooks: PlaybackConnectionEvents[] = [], rejected: PlaybackMediaMode[] = [];
  const session = createPlaybackSession({ clock, mediaMode: 'audio', preferredRoute: playbackRouteKey(hls),
    resolve: async () => info(),
    connect: async (source, _signal, events, mode) => {
      attached.push({ source: source.id, mode }); hooks.push(events); return { destroy() {} };
    }, onMediaModeRejected: mode => rejected.push(mode),
  });
  await flush(); progressed(hooks[0]); session.setMediaMode('video'); await flush(); hooks[1].failed('unsupported'); await flush();
  assert.deepEqual(rejected, []);
  assert.deepEqual(attached.at(-1), { source: 'flv', mode: 'video' });
  hooks[2].failed('unsupported'); await flush();
  assert.deepEqual(attached, [{ source: 'flv', mode: 'audio' }, { source: 'hls', mode: 'video' }, { source: 'flv', mode: 'video' }, { source: 'flv', mode: 'audio' }]);
  assert.deepEqual(rejected, ['audio']); progressed(hooks[3]); session.setMediaMode('video'); await flush();
  assert.deepEqual(attached.at(-1), { source: 'hls', mode: 'video' });
  session.destroy(); assert.equal(clock.size(), 0);
});

test('offline mode selection is retained for the next live connection', async () => {
  const clock = fakeClock(), attached: PlaybackMediaMode[] = [], rejected: PlaybackMediaMode[] = [];
  let requests = 0;
  const session = createPlaybackSession({ clock, autoReconnect: false,
    resolve: async () => ++requests <= 2 ? { ...info([]), status: 'offline' } : info(),
    connect: async (_source, _signal, _events, mode) => { attached.push(mode); return { destroy() {} }; },
    onMediaModeRejected: mode => rejected.push(mode),
  });
  await flush(); session.setMediaMode('audio'); await flush();
  assert.equal(attached.length, 0); assert.equal(rejected.length, 0);
  session.reconnect(); await flush(); assert.deepEqual(attached, ['audio']);
  session.destroy(); assert.equal(clock.size(), 0);
});

test('rapid mode changes cancel stale metadata and retain the final intent', async () => {
  const clock = fakeClock(), pending = deferred<PlaybackInfo>(), signals: AbortSignal[] = [], rejected: PlaybackMediaMode[] = [];
  const attached: PlaybackMediaMode[] = [];
  let hooks!: PlaybackConnectionEvents;
  const session = createPlaybackSession({ clock,
    resolve: async signal => { signals.push(signal); return signals.length === 1 ? info() : pending.promise; },
    connect: async (_source, _signal, events, mode) => { attached.push(mode); hooks = events; return { destroy() {} }; },
    onMediaModeRejected: mode => rejected.push(mode),
  });
  await flush(); progressed(hooks); session.setMediaMode('audio'); await flush(); session.setMediaMode('video'); await flush();
  assert.equal(signals[1].aborted, true);
  pending.resolve(info([flv])); await flush();
  assert.deepEqual(attached, ['video']); assert.deepEqual(rejected, []);
  session.destroy(); assert.equal(clock.size(), 0);
});

test('destroying a paused or removed room cancels a pending mode change and ignores late metadata', async () => {
  const clock = fakeClock(), pending = deferred<PlaybackInfo>(), signals: AbortSignal[] = [];
  let attached = 0, rejected = 0;
  const session = createPlaybackSession({ clock,
    resolve: async signal => { signals.push(signal); return signals.length === 1 ? info() : pending.promise; },
    connect: async (_source, _signal, events) => { attached++; progressed(events); return { destroy() {} }; },
    onMediaModeRejected: () => { rejected++; },
  });
  await flush(); session.setMediaMode('audio'); await flush(); session.destroy();
  assert.equal(signals[1].aborted, true); pending.resolve(info([flv])); await flush();
  assert.equal(attached, 1); assert.equal(rejected, 0); assert.equal(clock.size(), 0);
});

test('persisted audio mode cannot silently fall back to HLS', async () => {
  const clock = fakeClock(), states: Array<{ state: string; message?: string }> = [];
  let attached = 0, rejected = 0;
  const session = createPlaybackSession({ clock, mediaMode: 'audio', resolve: async () => info([hls]),
    connect: async () => { attached++; return { destroy() {} }; },
    onStatus: (state, message) => states.push({ state, message }), onMediaModeRejected: () => { rejected++; },
  });
  await flush(); assert.equal(attached, 0); assert.equal(rejected, 0);
  assert.equal(states.at(-1)?.state, 'unsupported'); assert.match(states.at(-1)?.message ?? '', /切回视频/);
  session.setMediaMode('video'); await flush(); assert.equal(attached, 1);
  session.destroy(); assert.equal(clock.size(), 0);
});

test('audio recovery failures do not poison the remembered video route', async () => {
  const clock = fakeClock(), recovery = createPlaybackRecoveryState();
  recovery.healthyRoute = playbackRouteKey(hls);
  const hooks: PlaybackConnectionEvents[] = [];
  const session = createPlaybackSession({ clock, mediaMode: 'audio', recoveryState: recovery, resolve: async () => info(),
    connect: async (_source, _signal, events) => { hooks.push(events); return { destroy() {} }; },
  });
  await flush(); hooks[0].playing(); hooks[0].failed(); await flush();
  assert.equal(recovery.healthyRoute, playbackRouteKey(hls));
  assert.equal(recovery.routes.has(playbackRouteKey(flv)), false);
  assert.equal(recovery.routes.has(`audio:${playbackRouteKey(flv)}`), true);
  session.destroy(); assert.equal(clock.size(), 0);
});

function fakeVideo() {
  const events = new Map<string, Set<EventListener>>();
  let time = 0, frameReads = 0;
  const video = {
    currentTime: 0, paused: false, ended: false, seeking: false, error: null, buffered: { length: 0 },
    canPlayType: () => '', play: async () => {}, pause() {}, load() {}, removeAttribute() {},
    addEventListener(name: string, callback: EventListener) { const values = events.get(name) ?? new Set(); values.add(callback); events.set(name, values); },
    removeEventListener(name: string, callback: EventListener) { events.get(name)?.delete(callback); },
    getVideoPlaybackQuality() { frameReads++; return { totalVideoFrames: 0, droppedVideoFrames: 0 }; },
  };
  return { video: video as unknown as HTMLVideoElement, frameReads: () => frameReads,
    advance() { video.currentTime = ++time; }, emit(name: string) { for (const callback of events.get(name) ?? []) callback(new Event(name)); },
    listeners: () => [...events.values()].reduce((count, entries) => count + entries.size, 0) };
}

test('FLV audio mode disables video demux and never uses video frame progress', async () => {
  const clock = fakeClock(), media = fakeVideo(), controller = new AbortController();
  let data: unknown, destroyed = 0, failures = 0, progress = 0, stalls = 0;
  const mpegts = { getFeatureList: () => ({ mseLivePlayback: true }), LoggingControl: {},
    Events: { ERROR: 'error' }, ErrorTypes: { NETWORK_ERROR: 'network' },
    ErrorDetails: { MEDIA_FORMAT_UNSUPPORTED: 'format', MEDIA_CODEC_UNSUPPORTED: 'codec' },
    createPlayer(source: unknown) { data = source; return { on() {}, attachMediaElement() {}, load() {}, destroy() { destroyed++; } }; },
  } as unknown as typeof import('mpegts.js')['default'];
  const connection = await connectPlaybackSource(media.video, flv, controller.signal,
    { playing() {}, progress() { progress++; }, stalled() { stalls++; }, failed() { failures++; } }, 'stable',
    { mediaMode: 'audio', clock, loadMpegts: async () => ({ default: mpegts }) });
  assert.deepEqual(data, { type: 'flv', isLive: true, url: flv.url, cors: true, withCredentials: false, hasAudio: true, hasVideo: false });
  for (let index = 0; index < 35; index++) { media.advance(); await clock.advance(1_000); }
  assert.equal(media.frameReads(), 0); assert.equal(failures, 0); assert.equal(stalls, 0); assert.ok(progress > 0);
  controller.abort(); connection.destroy(); assert.equal(destroyed, 1); assert.equal(media.listeners(), 0); assert.equal(clock.size(), 0);
});

test('audio mode rejects HLS before loading an HLS engine', async () => {
  const clock = fakeClock(), media = fakeVideo(), failures: string[] = [];
  let loaded = 0;
  const connection = await connectPlaybackSource(media.video, hls, new AbortController().signal,
    { playing() {}, failed(reason) { failures.push(typeof reason === 'string' ? reason : reason?.kind ?? ''); } }, 'stable',
    { mediaMode: 'audio', clock, loadHls: async () => { loaded++; throw new Error('unexpected'); } });
  assert.equal(loaded, 0); assert.deepEqual(failures, ['unsupported']);
  connection.destroy(); assert.equal(clock.size(), 0);
});

for (const automatic of [true, false]) test(`stalled audio reports the timeline failure and ${automatic ? 'escalates recovery' : 'respects disabled recovery'}`, async () => {
  const clock = fakeClock(), media = fakeVideo(), messages: string[] = [];
  let failures = 0;
  const mpegts = { getFeatureList: () => ({ mseLivePlayback: true }), LoggingControl: {},
    Events: { ERROR: 'error' }, ErrorTypes: { NETWORK_ERROR: 'network' },
    ErrorDetails: { MEDIA_FORMAT_UNSUPPORTED: 'format', MEDIA_CODEC_UNSUPPORTED: 'codec' },
    createPlayer() { return { on() {}, attachMediaElement() {}, load() {}, destroy() {} }; },
  } as unknown as typeof import('mpegts.js')['default'];
  const connection = await connectPlaybackSource(media.video, flv, new AbortController().signal,
    { playing() {}, canAutoRecover: () => automatic, stalled(message) { messages.push(message); }, failed() { failures++; } }, 'stable',
    { mediaMode: 'audio', clock, loadMpegts: async () => ({ default: mpegts }) });
  media.advance(); await clock.advance(1_000); await clock.advance(10_000);
  assert.equal(messages.length, 1); assert.match(messages[0], /音频暂时停滞/); assert.equal(failures, 0);
  await clock.advance(15_000);
  assert.equal(failures, automatic ? 1 : 0); assert.equal(media.frameReads(), 0);
  connection.destroy(); assert.equal(clock.size(), 0);
});
