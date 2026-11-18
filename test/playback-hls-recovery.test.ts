import assert from 'node:assert/strict';
import test from 'node:test';
import { connectPlaybackSource, type PlaybackMode } from '../client/multiview/playbackAdapters.js';
import type { PlaybackConnectionEvents } from '../client/multiview/playbackSession.js';
import type { PlaybackSource } from '../shared/playback.js';

const source: PlaybackSource = {
  id: 'fmp4', url: 'https://cdn.example/live.m3u8', protocol: 'hls', format: 'fmp4', codec: 'avc', actualQuality: 10000,
};

class FakeVideo extends EventTarget {
  src = '';
  currentTime = 0;
  paused = false;
  ended = false;
  seeking = false;
  totalVideoFrames = 0;
  readyState = 2;
  error = null;
  buffered = { length: 0, start: () => 0, end: () => 0 };
  canPlayType() { return ''; }
  async play() { this.paused = false; }
  pause() { this.paused = true; }
  load() {}
  removeAttribute(name: string) { if (name === 'src') this.src = ''; }
  getVideoPlaybackQuality() { return { totalVideoFrames: this.totalVideoFrames, droppedVideoFrames: 0 }; }
}

function fragment(sn: number | 'initSegment', type = 'main') {
  return { type, level: 0, cc: 0, sn, url: `https://cdn.example/${sn}.m4s`, relurl: `${sn}.m4s` };
}

async function fixture(mode: PlaybackMode = 'stable', automatic = true, framesExpected = () => true) {
  const video = new FakeVideo();
  const controller = new AbortController();
  const failures: Array<Parameters<PlaybackConnectionEvents['failed']>[0]> = [];
  let progress = 0;
  const buffering: string[] = [];
  const interruptionDurations: number[] = [];
  let now = 0, interruptionStart: number | undefined;
  let nextTimer = 0;
  const timers = new Map<number, () => void>();
  let hls!: FakeHls;
  class FakeHls {
    static isSupported = () => true;
    static Events = { ERROR: 'error', MANIFEST_PARSED: 'manifest', FRAG_LOADED: 'fragLoaded' };
    static ErrorTypes = { NETWORK_ERROR: 'network', MEDIA_ERROR: 'media' };
    readonly handlers = new Map<string, (event: string, data: unknown) => void>();
    stops = 0;
    destroyed = 0;
    constructor(readonly config: Record<string, unknown>) { hls = this; }
    on(name: string, callback: (event: string, data: unknown) => void) { this.handlers.set(name, callback); }
    emit(name: string, data: unknown) { this.handlers.get(name)?.(name, data); }
    loadSource() {}
    attachMedia() { video.src = 'blob:fake-hls'; }
    recoverMediaError() {}
    startLoad() {}
    stopLoad() { this.stops++; }
    // Retain callbacks to model an already queued event arriving after destruction.
    destroy() { this.destroyed++; }
  }
  const connection = await connectPlaybackSource(video as unknown as HTMLVideoElement, source, controller.signal, {
    playing() {}, progress() { progress++; }, failed: reason => failures.push(reason),
    buffering(state) {
      buffering.push(state);
      if (state === 'start') interruptionStart = now;
      else {
        if (state === 'end' && interruptionStart !== undefined) interruptionDurations.push(now - interruptionStart);
        interruptionStart = undefined;
      }
    },
    canAutoRecover: () => automatic,
  }, mode, {
    clock: {
      now: () => now,
      setTimeout(callback: () => void) { const id = ++nextTimer; timers.set(id, callback); return id; },
      clearTimeout(handle: unknown) { timers.delete(handle as number); },
    },
    loadHls: async () => ({ default: FakeHls }) as never,
    framesExpected,
  });
  return {
    video, controller, connection, hls, failures, timers, buffering, interruptionDurations,
    elapse(ms: number) { now += ms; },
    get progress() { return progress; },
    loaded(sn: number | 'initSegment', part?: { index: number }, type = 'main') {
      hls.emit(FakeHls.Events.FRAG_LOADED, { frag: fragment(sn, type), ...(part ? { part } : {}) });
    },
    playForward() {
      video.currentTime++;
      video.totalVideoFrames += 30;
      video.dispatchEvent(new Event('timeupdate'));
    },
    seek(target: number) {
      video.seeking = true;
      video.dispatchEvent(new Event('seeking'));
      video.currentTime = target;
      video.totalVideoFrames++;
      video.seeking = false;
      video.dispatchEvent(new Event('seeked'));
      video.dispatchEvent(new Event('timeupdate'));
    },
  };
}

for (const mode of ['stable', 'low-latency'] as const) {
  test(`HLS ${mode} synchronizes against the available media buffer`, async () => {
    const f = await fixture(mode);
    try { assert.equal(f.hls.config.liveSyncMode, 'buffered'); }
    finally { f.connection.destroy(); }
  });
}

test('a fourth download of the same complete fragment stops its loop and fails the connection once', async () => {
  const f = await fixture();
  try {
    for (let count = 0; count < 3; count++) f.loaded(101);
    assert.deepEqual(f.failures, []);
    assert.equal(f.hls.stops, 0);
    f.loaded(101);
    assert.deepEqual(f.failures, [{ kind: 'network' }]);
    assert.equal(f.hls.stops, 1);
    for (let count = 0; count < 8; count++) f.loaded(101);
    assert.equal(f.failures.length, 1);
    assert.equal(f.hls.stops, 1);
    assert.equal(f.timers.size, 0);
  } finally { f.connection.destroy(); }
});

test('alternating two fragments cannot evade the repeated download limit', async () => {
  const f = await fixture();
  try {
    for (let count = 0; count < 3; count++) { f.loaded(101); f.loaded(102); }
    assert.deepEqual(f.failures, []);
    f.loaded(101);
    assert.deepEqual(f.failures, [{ kind: 'network' }]);
    assert.equal(f.hls.stops, 1);
  } finally { f.connection.destroy(); }
});

test('main and alternate audio fragments with the same sequence keep independent repeat budgets', async () => {
  const f = await fixture();
  try {
    for (let count = 0; count < 3; count++) {
      f.loaded(101, undefined, 'main');
      f.loaded(101, undefined, 'audio');
    }
    assert.deepEqual(f.failures, []);
    assert.equal(f.hls.stops, 0);
    f.loaded(101, undefined, 'audio');
    assert.deepEqual(f.failures, [{ kind: 'network' }]);
    assert.equal(f.hls.stops, 1);
  } finally { f.connection.destroy(); }
});

test('disabling automatic recovery still stops a runaway fragment download loop', async () => {
  const f = await fixture('stable', false);
  try {
    for (let count = 0; count < 4; count++) f.loaded(101);
    assert.deepEqual(f.failures, [{ kind: 'network' }]);
    assert.equal(f.hls.stops, 1);
    assert.equal(f.timers.size, 0);
  } finally { f.connection.destroy(); }
});

test('a sequence of new complete fragments does not count as a download loop', async () => {
  const f = await fixture();
  try {
    for (let sn = 1; sn <= 40; sn++) f.loaded(sn);
    assert.deepEqual(f.failures, []);
    assert.equal(f.hls.stops, 0);
  } finally { f.connection.destroy(); }
});

test('initialization segments and low latency parts do not consume the complete fragment budget', async () => {
  const f = await fixture('low-latency');
  try {
    for (let count = 0; count < 3; count++) f.loaded(101);
    for (let count = 0; count < 12; count++) {
      f.loaded('initSegment');
      f.loaded(101, { index: count });
    }
    assert.deepEqual(f.failures, []);
    assert.equal(f.hls.stops, 0);
    f.loaded(101);
    assert.deepEqual(f.failures, [{ kind: 'network' }]);
  } finally { f.connection.destroy(); }
});

test('an engine seek presenting a target frame does not reset the repeated fragment budget', async () => {
  const f = await fixture();
  try {
    for (let count = 0; count < 3; count++) f.loaded(101);
    f.seek(100);
    assert.equal(f.progress, 0);
    f.loaded(101);
    assert.deepEqual(f.failures, [{ kind: 'network' }]);
    assert.equal(f.hls.stops, 1);
  } finally { f.connection.destroy(); }
});

test('genuine playback progress resets the repeated fragment budget for a later independent stall', async () => {
  const f = await fixture();
  try {
    for (let cycle = 0; cycle < 2; cycle++) {
      for (let count = 0; count < 3; count++) f.loaded(101);
      assert.deepEqual(f.failures, []);
      f.playForward();
    }
    assert.equal(f.progress, 2);
    for (let count = 0; count < 3; count++) f.loaded(101);
    assert.deepEqual(f.failures, []);
    f.loaded(101);
    assert.deepEqual(f.failures, [{ kind: 'network' }]);
    assert.equal(f.hls.stops, 1);
  } finally { f.connection.destroy(); }
});

test('queued fragment events after abort cannot restart recovery or report failure', async () => {
  const f = await fixture();
  try {
    for (let count = 0; count < 3; count++) f.loaded(101);
    f.controller.abort();
    assert.equal(f.hls.destroyed, 1);
    assert.equal(f.timers.size, 0);
    for (let count = 0; count < 8; count++) f.loaded(101);
    assert.deepEqual(f.failures, []);
    assert.equal(f.hls.stops, 0);
    assert.equal(f.hls.destroyed, 1);
    assert.equal(f.video.src, '');
  } finally { f.connection.destroy(); }
});

test('only native playback starvation starts an interruption, while engine warnings and stalled events do not', async () => {
  const f = await fixture();
  try {
    f.hls.emit('error', { fatal: false, type: 'media', details: 'bufferStalledError' });
    f.video.dispatchEvent(new Event('stalled'));
    assert.deepEqual(f.buffering, []);
    f.video.dispatchEvent(new Event('waiting'));
    f.video.dispatchEvent(new Event('waiting'));
    f.hls.emit('error', { fatal: false, type: 'network' });
    assert.deepEqual(f.buffering, ['start']);
    f.video.dispatchEvent(new Event('playing'));
    f.playForward();
    assert.deepEqual(f.buffering, ['start', 'end']);
  } finally { f.connection.destroy(); }
});

test('paused, seeking, buffered and hidden tiles do not start native interruption accounting', async () => {
  let visible = true;
  const f = await fixture('stable', true, () => visible);
  try {
    f.video.paused = true; f.video.dispatchEvent(new Event('waiting'));
    f.video.paused = false; f.video.seeking = true; f.video.dispatchEvent(new Event('waiting'));
    f.video.seeking = false; f.video.readyState = 3; f.video.dispatchEvent(new Event('waiting'));
    f.video.readyState = 2; visible = false; f.video.dispatchEvent(new Event('waiting'));
    assert.deepEqual(f.buffering, []);
    visible = true; f.video.dispatchEvent(new Event('waiting'));
    assert.deepEqual(f.buffering, ['start']);
  } finally { f.connection.destroy(); }
});

test('native interruption accounting is cancelled by pause, foreground resumption and disposal', async () => {
  const f = await fixture();
  try {
    f.video.dispatchEvent(new Event('waiting'));
    f.video.pause(); f.video.dispatchEvent(new Event('pause'));
    f.video.paused = false; f.video.dispatchEvent(new Event('waiting'));
    f.connection.checkHealth?.(true);
    f.video.dispatchEvent(new Event('waiting'));
    f.controller.abort();
    f.video.dispatchEvent(new Event('playing'));
    assert.deepEqual(f.buffering, ['start', 'cancel', 'start', 'cancel', 'start', 'cancel']);
  } finally { f.connection.destroy(); }
});

test('genuine progress ends an interruption once even before a delayed native playing event', async () => {
  const f = await fixture();
  try {
    f.video.dispatchEvent(new Event('waiting'));
    f.playForward();
    f.video.dispatchEvent(new Event('playing'));
    assert.deepEqual(f.buffering, ['start', 'end']);
    assert.equal(f.progress, 1);
  } finally { f.connection.destroy(); }
});

test('progress sampled before native waiting cannot end its interruption on a delayed timeupdate or health tick', async () => {
  const f = await fixture();
  try {
    f.playForward();
    // The element advances between its last timeupdate and its waiting event.
    f.video.currentTime += 0.2;
    f.video.totalVideoFrames += 6;
    f.video.dispatchEvent(new Event('waiting'));
    f.video.dispatchEvent(new Event('timeupdate'));
    f.connection.checkHealth?.();
    assert.deepEqual(f.buffering, ['start']);
    assert.equal(f.progress, 1);
    f.video.dispatchEvent(new Event('playing'));
    assert.deepEqual(f.buffering, ['start', 'end']);
    assert.equal(f.progress, 1);
  } finally { f.connection.destroy(); }
});

test('healthy engine seeks and their target frames never manufacture native buffering intervals', async () => {
  const f = await fixture();
  try {
    f.playForward();
    for (const target of [10, 20, 30]) {
      f.elapse(800); f.seek(target); f.video.dispatchEvent(new Event('playing'));
      f.connection.checkHealth?.();
    }
    assert.deepEqual(f.buffering, []);
    assert.deepEqual(f.interruptionDurations, []);
    assert.equal(f.progress, 1);
    f.playForward(); assert.equal(f.progress, 2);
  } finally { f.connection.destroy(); }
});

test('native starvation survives an engine gap seek and is measured once until actual playback resumes', async () => {
  const f = await fixture();
  try {
    f.playForward();
    f.video.dispatchEvent(new Event('waiting')); f.elapse(500);
    f.video.seeking = true; f.video.dispatchEvent(new Event('seeking'));
    f.video.currentTime = 100; f.video.totalVideoFrames++;
    f.video.dispatchEvent(new Event('timeupdate'));
    f.video.dispatchEvent(new Event('playing'));
    assert.deepEqual(f.buffering, ['start']); assert.equal(f.progress, 1);
    f.elapse(300);
    f.video.seeking = false; f.video.dispatchEvent(new Event('seeked'));
    f.video.dispatchEvent(new Event('timeupdate')); f.connection.checkHealth?.();
    assert.deepEqual(f.buffering, ['start']); assert.equal(f.progress, 1);
    f.elapse(400); f.video.dispatchEvent(new Event('playing'));
    f.playForward(); f.video.dispatchEvent(new Event('playing'));
    assert.deepEqual(f.buffering, ['start', 'end']);
    assert.deepEqual(f.interruptionDurations, [1_200]);
    assert.equal(f.progress, 2);
  } finally { f.connection.destroy(); }
});
