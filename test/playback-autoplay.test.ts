import assert from 'node:assert/strict';
import test from 'node:test';
import { connectPlaybackSource } from '../client/multiview/playbackAdapters.js';
import { createPlaybackSession, type PlaybackConnectionEvents } from '../client/multiview/playbackSession.js';
import type { PlaybackInfo, PlaybackSource } from '../shared/playback.js';

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function fakeClock() {
  let time = 0, next = 0;
  const timers = new Map<number, { callback(): void; at: number }>();
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
        time = timer[1].at; timers.delete(timer[0]); timer[1].callback(); await flush();
      }
      time = end; await flush();
    },
  };
}
const source = (id = 'one'): PlaybackSource => ({ id, protocol: 'hls', format: 'ts', codec: 'avc', actualQuality: 250,
  url: `https://${id}.cdn.example/live.m3u8`, expiresAt: 30_000 });
const info = (sources = [source()]): PlaybackInfo => ({ roomId: '1', status: 'live', requestedQuality: 250,
  qualities: [{ qn: 250, label: '超清' }], sources, resolvedAt: 0 });
const nativeHls = async () => ({ default: { isSupported: () => false } }) as unknown as typeof import('hls.js');

class Video extends EventTarget {
  src = ''; paused = true; ended = false; currentTime = 0; muted = false; volume = 0.65; loads = 0;
  plays: boolean[] = [];
  constructor(public allowPlay = false, private playResult?: () => Promise<void>) { super(); }
  canPlayType() { return 'probably'; }
  play() {
    this.plays.push(this.allowPlay);
    if (this.playResult) return this.playResult();
    if (!this.allowPlay) return Promise.reject(new DOMException('User interaction required', 'NotAllowedError'));
    this.paused = false; return Promise.resolve();
  }
  pause() { this.paused = true; }
  removeAttribute(name: string) { if (name === 'src') this.src = ''; }
  load() { this.loads++; }
}

test('one gesture resumes all blocked rooms synchronously without refetching sources or changing audio settings', async () => {
  const clock = fakeClock();
  const rooms = [0, 1].map(() => ({ video: new Video(), resume: null as (() => void) | null, resolves: 0, connects: 0, sources: 0, statuses: [] as string[] }));
  const sessions = rooms.map(room => createPlaybackSession({ clock,
    resolve: async () => { room.resolves++; return info(); },
    connect: (candidate, signal, events) => { room.connects++; return connectPlaybackSource(room.video as unknown as HTMLVideoElement,
      candidate, signal, events, 'stable', { clock, loadHls: nativeHls }); },
    onAutoplayBlockedChange: resume => { room.resume = resume; },
    onSource: () => { room.sources++; }, onStatus: status => { room.statuses.push(status); },
  }));
  await flush();
  for (const room of rooms) {
    assert.equal(room.statuses.at(-1), 'autoplay-blocked'); assert.ok(room.resume);
    assert.equal(room.video.src, source().url); assert.equal(room.sources, 0); assert.equal(room.video.loads, 0);
    room.video.dispatchEvent(new Event('canplay')); room.video.dispatchEvent(new Event('pause'));
    room.video.currentTime = 50; room.video.dispatchEvent(new Event('timeupdate'));
    assert.equal(room.sources, 0); assert.ok(room.resume); assert.equal(room.statuses.at(-1), 'autoplay-blocked');
  }
  await clock.advance(60_000);
  for (const room of rooms) assert.deepEqual(room.video.plays, [false]);
  const handles = rooms.map(room => room.resume!);
  // Simulate the finite synchronous activation window of a browser click.
  rooms.forEach(room => { room.video.allowPlay = true; });
  handles.forEach(resume => resume());
  handles.forEach(resume => resume()); // A second click while play() is pending cannot duplicate work.
  rooms.forEach(room => { room.video.allowPlay = false; });
  for (const room of rooms) assert.deepEqual(room.video.plays, [false, true]);
  await flush();
  for (const room of rooms) {
    assert.equal(room.resume, null); assert.equal(room.statuses.at(-1), 'playing');
    assert.equal(room.resolves, 1); assert.equal(room.connects, 1); assert.equal(room.video.loads, 0);
    assert.equal(room.video.muted, false); assert.equal(room.video.volume, 0.65);
    room.video.currentTime = 51; room.video.dispatchEvent(new Event('timeupdate')); assert.equal(room.sources, 1);
  }
  sessions.forEach(session => session.destroy()); assert.equal(clock.size(), 0);
  handles.forEach(resume => resume());
  for (const room of rooms) assert.deepEqual(room.video.plays, [false, true]);
});

test('a denied recovery remains available and destroying or switching source invalidates the old handle', async () => {
  const clock = fakeClock(); let resume: (() => void) | null = null; let calls = 0;
  const hooks: PlaybackConnectionEvents[] = [], statuses: string[] = [];
  const session = createPlaybackSession({ clock, resolve: async () => info([source('one'), source('two')]),
    connect: async (_candidate, _signal, events) => {
      hooks.push(events); events.failed('autoplay');
      return { destroy() {}, resumePlayback() { calls++; events.failed('autoplay'); } };
    },
    onAutoplayBlockedChange: callback => { resume = callback; }, onStatus: status => { statuses.push(status); },
  });
  await flush(); const old = resume!; assert.ok(old);
  old(); assert.equal(calls, 1); assert.ok(resume); assert.equal(statuses.at(-1), 'autoplay-blocked');
  session.selectRoute('cdn:two.cdn.example'); await flush();
  old(); assert.equal(calls, 1); assert.equal(hooks.length, 2);
  const current = resume!; current(); assert.equal(calls, 2);
  session.destroy(); assert.equal(resume, null); current(); assert.equal(calls, 2); assert.equal(clock.size(), 0);
});

test('non-policy playback failures still report network or unsupported errors instead of offering autoplay recovery', async () => {
  for (const [name, expected] of [['NotSupportedError', 'unsupported'], ['NetworkError', 'network']]) {
    const clock = fakeClock(), reasons: string[] = [];
    const video = new Video(false, () => Promise.reject({ name }));
    const connection = await connectPlaybackSource(video as unknown as HTMLVideoElement, source(), new AbortController().signal,
      { playing() {}, failed: reason => { reasons.push(typeof reason === 'string' ? reason : reason?.kind ?? 'unknown'); } },
      'stable', { clock, loadHls: nativeHls });
    await flush(); assert.deepEqual(reasons, [expected]);
    connection.resumePlayback?.(); assert.equal(video.plays.length, 1); connection.destroy(); assert.equal(clock.size(), 0);
  }
});

test('a blocked audio mode switch waits for the user without rolling back or trying another CDN', async () => {
  const clock = fakeClock(), hooks: PlaybackConnectionEvents[] = [], modes: string[] = [], rejected: string[] = [];
  let resume: (() => void) | null = null;
  const flv: PlaybackSource = { ...source('audio'), protocol: 'flv', format: 'flv' };
  const session = createPlaybackSession({ clock, resolve: async () => info([source(), flv]),
    connect: async (_candidate, _signal, events, mode) => { hooks.push(events); modes.push(mode);
      return { destroy() {}, resumePlayback() { events.playing(); events.progress?.(); } }; },
    onAutoplayBlockedChange: callback => { resume = callback; }, onMediaModeRejected: mode => { rejected.push(mode); },
  });
  await flush(); hooks[0].progress?.(); session.setMediaMode('audio'); await flush(); hooks[1].failed('autoplay');
  await clock.advance(20_000); assert.deepEqual(modes, ['video', 'audio']); assert.deepEqual(rejected, []); assert.ok(resume);
  session.resumePlayback(); assert.equal(resume, null); assert.deepEqual(rejected, []);
  session.destroy(); assert.equal(clock.size(), 0);
});

for (const outcome of ['playing-without-progress', 'pending-play', 'backup-cdn'] as const) test(`resuming a blocked mode switch restores one deadline with ${outcome}`, async () => {
  const clock = fakeClock(), hooks: PlaybackConnectionEvents[] = [], modes: string[] = [], rejected: string[] = [];
  let handle: (() => void) | null = null;
  const hls = { ...source(), expiresAt: 1_000_000 };
  const flv: PlaybackSource = { ...source('audio'), protocol: 'flv', format: 'flv', expiresAt: 1_000_000 };
  const backup = { ...flv, id: 'backup', url: 'https://backup.cdn.example/live.flv' };
  const session = createPlaybackSession({ clock, resolve: async () => info([hls, flv, backup]),
    connect: async (_candidate, _signal, events, mode) => {
      hooks.push(events); modes.push(mode);
      return { destroy() {}, resumePlayback() { if (outcome !== 'pending-play') events.playing(); } };
    },
    onAutoplayBlockedChange: callback => { handle = callback; }, onMediaModeRejected: mode => { rejected.push(mode); },
  });
  await flush(); hooks[0].progress?.(); session.setMediaMode('audio'); await flush(); hooks[1].failed('autoplay');
  await clock.advance(20_000); assert.deepEqual(rejected, []);
  const resume = handle!; assert.ok(resume); resume();
  await clock.advance(5_000);
  if (outcome === 'backup-cdn') { hooks[1].failed({ kind: 'network', httpStatus: 403 }); await flush(); }
  await clock.advance(5_000);
  resume(); session.resumePlayback(); // Repeated clicks and playing cannot restart the original 15 s budget.
  if (outcome !== 'pending-play') hooks.at(-1)!.playing();
  await clock.advance(4_999); assert.deepEqual(rejected, []);
  await clock.advance(1); assert.deepEqual(rejected, ['video']); assert.equal(modes.at(-1), 'video');
  assert.equal(modes.filter(mode => mode === 'audio').length, outcome === 'backup-cdn' ? 2 : 1);
  hooks.at(-1)!.progress?.(); session.destroy(); assert.equal(clock.size(), 0);
});
