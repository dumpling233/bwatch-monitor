import assert from 'node:assert/strict';
import test from 'node:test';
import { connectPlaybackSource } from '../client/multiview/playbackAdapters.js';
import type { PlaybackConnectionEvents } from '../client/multiview/playbackSession.js';
import type { PlaybackSource } from '../shared/playback.js';

function flush() { return Promise.resolve().then(() => Promise.resolve()); }

function fakeClock() {
  let time = 0;
  let next = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => time,
    setTimeout(callback: () => void, delay: number) { const id = ++next; timers.set(id, { at: time + delay, callback }); return id; },
    clearTimeout(handle: unknown) { timers.delete(handle as number); },
    skip(milliseconds: number) { time += milliseconds; },
    async advance(milliseconds: number) {
      const end = time + milliseconds;
      while (true) {
        const nextTimer = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((left, right) => left[1].at - right[1].at)[0];
        if (!nextTimer) break;
        time = nextTimer[1].at;
        timers.delete(nextTimer[0]);
        nextTimer[1].callback();
        await flush();
      }
      time = end;
      await flush();
    },
    size: () => timers.size,
  };
}

const source: PlaybackSource = {
  id: 'native', url: 'https://cdn.example/live.m3u8', protocol: 'hls', format: 'ts', codec: 'avc', actualQuality: 250,
};

class FakeVideo extends EventTarget {
  src = '';
  paused = true;
  ended = false;
  seeking = false;
  currentTime = 0;
  error: { code: number } | null = null;
  buffered: { length: number; start(index: number): number; end(index: number): number } = {
    length: 0, start: () => 0, end: () => 0,
  };
  plays = 0;
  constructor(private readonly playImpl: () => Promise<void> = async () => {}) { super(); }
  canPlayType() { return 'probably'; }
  play() { this.plays++; this.paused = false; return this.playImpl(); }
  pause() { this.paused = true; }
  removeAttribute(name: string) { if (name === 'src') this.src = ''; }
  load() {}
}

async function connect(video: FakeVideo, clock: ReturnType<typeof fakeClock>, events: Pick<PlaybackConnectionEvents, 'failed'> & Partial<PlaybackConnectionEvents>) {
  return connectPlaybackSource(video as unknown as HTMLVideoElement, source, new AbortController().signal, { playing() {}, ...events }, 'stable', { clock });
}

test('adapter reports a stall, performs one guarded soft seek, then fails only after the hard deadline', async () => {
  const clock = fakeClock();
  const video = new FakeVideo();
  video.buffered = { length: 1, start: () => 0, end: () => 20 };
  const stalled: string[] = [];
  let failed = 0;
  const connection = await connect(video, clock, {
    playing() {}, stalled: message => stalled.push(message), failed() { failed++; },
  });
  video.currentTime = 1;
  video.dispatchEvent(new Event('timeupdate'));
  await clock.advance(10_000);
  assert.deepEqual(stalled, ['画面暂时停滞，正在尝试恢复']);
  assert.equal(failed, 0);
  await clock.advance(2_000);
  assert.equal(video.currentTime, 18.5);
  assert.equal(failed, 0);
  await clock.advance(13_000);
  assert.equal(failed, 1);
  connection.destroy();
  assert.equal(clock.size(), 0);
});

test('disabled auto recovery only reports a stall and never seeks or fails silently', async () => {
  const clock = fakeClock();
  const video = new FakeVideo();
  let failed = 0;
  let stalled = 0;
  const connection = await connect(video, clock, {
    canAutoRecover: () => false,
    stalled() { stalled++; }, failed() { failed++; },
  });
  video.currentTime = 1;
  video.dispatchEvent(new Event('timeupdate'));
  await clock.advance(40_000);
  assert.equal(stalled, 1);
  assert.equal(failed, 0);
  assert.equal(video.currentTime, 1);
  connection.destroy();
});

test('starting native interruption accounting consumes a stale sample without extending the real stall deadline', async () => {
  const clock = fakeClock(), video = new FakeVideo(), buffering: string[] = [];
  let stalled = 0, failed = 0;
  const connection = await connect(video, clock, {
    buffering: state => buffering.push(state), stalled() { stalled++; }, failed() { failed++; },
  });
  try {
    video.currentTime = 1; video.dispatchEvent(new Event('timeupdate'));
    await clock.advance(9_000);
    video.currentTime = 1.2; video.dispatchEvent(new Event('waiting'));
    await clock.advance(1_000);
    assert.deepEqual(buffering, ['start']); assert.equal(stalled, 1);
    await clock.advance(15_000);
    assert.equal(failed, 1);
    assert.deepEqual(buffering, ['start', 'cancel']);
  } finally { connection.destroy(); }
  assert.equal(clock.size(), 0);
});

test('the existing startup timeout remains twenty seconds before any genuine media progress', async () => {
  const clock = fakeClock();
  const video = new FakeVideo();
  let failed = 0;
  const connection = await connect(video, clock, { failed() { failed++; } });
  await clock.advance(19_999);
  assert.equal(failed, 0);
  await clock.advance(1);
  assert.equal(failed, 1);
  connection.destroy();
  assert.equal(clock.size(), 0);
});

test('a delayed foreground check receives a grace period before watchdog actions', async () => {
  const clock = fakeClock();
  const video = new FakeVideo();
  let failed = 0;
  let stalled = 0;
  const connection = await connect(video, clock, {
    stalled() { stalled++; }, failed() { failed++; },
  });
  video.currentTime = 1;
  video.dispatchEvent(new Event('timeupdate'));
  await clock.advance(9_000);
  connection.checkHealth?.(true);
  await clock.advance(4_999);
  assert.equal(stalled, 0);
  assert.equal(failed, 0);
  await clock.advance(1);
  assert.equal(stalled, 1);
  connection.destroy();
});

test('presented frame progress excludes dropped frames and a zero counter is not evidence of a freeze', async () => {
  const clock = fakeClock();
  let total = 0;
  let dropped = 0;
  class QualityVideo extends FakeVideo {
    getVideoPlaybackQuality() { return { totalVideoFrames: total, droppedVideoFrames: dropped }; }
  }
  const video = new QualityVideo();
  let failed = 0;
  const connection = await connect(video, clock, { failed() { failed++; } });
  for (let second = 1; second <= 26; second++) {
    video.currentTime = second;
    total += 30;
    dropped += 30;
    video.dispatchEvent(new Event('timeupdate'));
    await clock.advance(1_000);
  }
  assert.equal(failed, 0);
  connection.destroy();
});

test('an advancing audio timeline cannot hide a frozen presented video frame counter', async () => {
  const clock = fakeClock();
  class QualityVideo extends FakeVideo {
    total = 0;
    dropped = 0;
    getVideoPlaybackQuality() { return { totalVideoFrames: this.total, droppedVideoFrames: this.dropped }; }
  }
  const video = new QualityVideo();
  let failed = 0;
  let stalled = 0;
  const connection = await connect(video, clock, { stalled() { stalled++; }, failed() { failed++; } });
  video.total = 30;
  video.currentTime = 1;
  video.dispatchEvent(new Event('timeupdate'));
  for (let second = 1; second <= 25; second++) {
    video.currentTime = second + 1;
    video.total += 30;
    video.dropped += 30;
    video.dispatchEvent(new Event('timeupdate'));
    await clock.advance(1_000);
  }
  assert.equal(stalled, 1);
  assert.equal(failed, 1);
  connection.destroy();
});

test('a retained but hidden tile uses its healthy media timeline without requiring presented frames', async () => {
  const clock = fakeClock();
  class QualityVideo extends FakeVideo {
    total = 30;
    getVideoPlaybackQuality() { return { totalVideoFrames: this.total, droppedVideoFrames: 0 }; }
  }
  const video = new QualityVideo();
  let failed = 0;
  const connection = await connectPlaybackSource(video as unknown as HTMLVideoElement, source, new AbortController().signal,
    { playing() {}, failed() { failed++; } }, 'stable', { clock, framesExpected: () => false });
  video.total = 60;
  video.currentTime = 1;
  video.dispatchEvent(new Event('timeupdate'));
  for (let second = 2; second <= 30; second++) {
    video.currentTime = second;
    video.dispatchEvent(new Event('timeupdate'));
    await clock.advance(1_000);
  }
  assert.equal(failed, 0);
  connection.destroy();
});

test('background video frame throttling does not interrupt a progressing media timeline', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { hidden: true } });
  const clock = fakeClock();
  class QualityVideo extends FakeVideo {
    total = 0;
    getVideoPlaybackQuality() { return { totalVideoFrames: this.total, droppedVideoFrames: 0 }; }
  }
  const video = new QualityVideo();
  let failed = 0;
  let stalled = 0;
  const connection = await connect(video, clock, { stalled() { stalled++; }, failed() { failed++; } });
  try {
    video.total = 30;
    for (let second = 1; second <= 30; second++) {
      video.currentTime = second;
      video.dispatchEvent(new Event('timeupdate'));
      await clock.advance(1_000);
    }
    assert.equal(stalled, 0);
    assert.equal(failed, 0);
  } finally {
    connection.destroy();
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});

test('a suspended health timer cannot immediately destroy the connection when it wakes', async () => {
  const clock = fakeClock();
  const video = new FakeVideo();
  let failed = 0;
  let stalled = 0;
  const connection = await connect(video, clock, { stalled() { stalled++; }, failed() { failed++; } });
  video.currentTime = 1;
  video.dispatchEvent(new Event('timeupdate'));
  clock.skip(40_000);
  connection.checkHealth?.();
  assert.equal(stalled, 0);
  assert.equal(failed, 0);
  video.currentTime = 2;
  video.dispatchEvent(new Event('timeupdate'));
  connection.checkHealth?.();
  assert.equal(failed, 0);
  connection.destroy();
});

test('pending play is guarded and a later real progress resets the pause recovery budget', async () => {
  let resolvePlay!: () => void;
  const playPromise = new Promise<void>(resolve => { resolvePlay = resolve; });
  const clock = fakeClock();
  const video = new FakeVideo(() => playPromise);
  const connection = await connect(video, clock, { failed() {} });
  video.dispatchEvent(new Event('pause'));
  video.dispatchEvent(new Event('pause'));
  assert.equal(video.plays, 1);
  resolvePlay();
  await flush();
  video.currentTime = 1;
  video.dispatchEvent(new Event('timeupdate'));
  video.paused = true;
  video.dispatchEvent(new Event('pause'));
  assert.equal(video.plays, 2);
  await flush();
  video.currentTime = 2;
  video.dispatchEvent(new Event('timeupdate'));
  video.paused = true;
  video.dispatchEvent(new Event('pause'));
  assert.equal(video.plays, 3);
  connection.destroy();
  assert.equal(clock.size(), 0);
});

test('aborting a connection cancels all later watchdog and media recovery actions', async () => {
  const clock = fakeClock();
  const video = new FakeVideo();
  const controller = new AbortController();
  let failed = 0;
  const connection = await connectPlaybackSource(video as unknown as HTMLVideoElement, source, controller.signal, {
    playing() {}, failed() { failed++; },
  }, 'stable', { clock });
  controller.abort();
  assert.equal(clock.size(), 0);
  video.dispatchEvent(new Event('pause'));
  video.dispatchEvent(new Event('error'));
  await clock.advance(60_000);
  connection.checkHealth?.(true);
  assert.equal(video.plays, 1);
  assert.equal(failed, 0);
});

function seek(video: FakeVideo, target: number, presentFrame?: () => void, timeupdateBeforeSeeked = false) {
  video.seeking = true;
  video.dispatchEvent(new Event('seeking'));
  video.currentTime = target;
  presentFrame?.();
  video.seeking = false;
  if (timeupdateBeforeSeeked) video.dispatchEvent(new Event('timeupdate'));
  video.dispatchEvent(new Event('seeked'));
  if (!timeupdateBeforeSeeked) video.dispatchEvent(new Event('timeupdate'));
}

for (const timeupdateBeforeSeeked of [false, true]) {
  const order = timeupdateBeforeSeeked ? 'before' : 'after';

  test(`repeated engine seeks with timeupdate ${order} seeked do not extend the startup deadline`, async () => {
    const clock = fakeClock();
    const video = new FakeVideo();
    let failed = 0;
    let progress = 0;
    const connection = await connect(video, clock, { progress() { progress++; }, failed() { failed++; } });
    for (let second = 1; second <= 20; second++) {
      seek(video, second * 10, undefined, timeupdateBeforeSeeked);
      await clock.advance(1_000);
    }
    assert.equal(progress, 0, 'a completed seek is not media playback');
    assert.equal(failed, 1, 'seeks must not turn the twenty second startup deadline into an endless wait');
    connection.destroy();
  });

  test(`repeated seeks presenting one frame with timeupdate ${order} seeked do not hide a stalled stream`, async () => {
    const clock = fakeClock();
    class QualityVideo extends FakeVideo {
      total = 0;
      getVideoPlaybackQuality() { return { totalVideoFrames: this.total, droppedVideoFrames: 0 }; }
    }
    const video = new QualityVideo();
    let failed = 0;
    let progress = 0;
    let stalled = 0;
    const connection = await connect(video, clock, {
      progress() { progress++; }, stalled() { stalled++; }, failed() { failed++; },
    });
    video.total = 30;
    video.currentTime = 1;
    video.dispatchEvent(new Event('timeupdate'));
    for (let second = 1; second <= 25; second++) {
      seek(video, second * 10, () => { video.total++; }, timeupdateBeforeSeeked);
      await clock.advance(1_000);
    }
    assert.equal(progress, 1, 'decoding the target frame of a seek cannot reset recovery budgets');
    assert.equal(stalled, 1);
    assert.equal(failed, 1, 'the last genuine playback still starts the twenty five second deadline');
    connection.destroy();
  });
}

for (const played of [false, true]) {
  test(`backward timeline jumps do not postpone the ${played ? 'played stream' : 'startup'} deadline`, async () => {
    const clock = fakeClock();
    const video = new FakeVideo();
    video.currentTime = 100;
    let failed = 0;
    let progress = 0;
    const connection = await connect(video, clock, { progress() { progress++; }, failed() { failed++; } });
    if (played) {
      video.currentTime++;
      video.dispatchEvent(new Event('timeupdate'));
    }
    for (let second = 1; second <= (played ? 25 : 20); second++) {
      video.currentTime -= 0.5;
      video.dispatchEvent(new Event('timeupdate'));
      await clock.advance(1_000);
    }
    assert.equal(progress, played ? 1 : 0);
    assert.equal(failed, 1, 'rebasing a counter must not refresh its last genuine progress time');
    connection.destroy();
  });
}

test('genuine timeline and frame progress after a seek restores health and rearms stall recovery', async () => {
  const clock = fakeClock();
  class QualityVideo extends FakeVideo {
    total = 0;
    getVideoPlaybackQuality() { return { totalVideoFrames: this.total, droppedVideoFrames: 0 }; }
  }
  const video = new QualityVideo();
  let failed = 0;
  let progress = 0;
  let stalled = 0;
  const connection = await connect(video, clock, {
    progress() { progress++; }, stalled() { stalled++; }, failed() { failed++; },
  });
  video.currentTime = 1;
  video.total = 30;
  video.dispatchEvent(new Event('timeupdate'));
  await clock.advance(12_000);
  assert.equal(stalled, 1);
  assert.equal(video.plays, 2);
  seek(video, 100, () => { video.total++; });
  assert.equal(progress, 1);
  for (let second = 1; second <= 30; second++) {
    await clock.advance(1_000);
    video.currentTime++;
    video.total += 30;
    video.dispatchEvent(new Event('timeupdate'));
  }
  assert.equal(progress, 31);
  assert.equal(stalled, 1);
  assert.equal(failed, 0);
  await clock.advance(10_000);
  assert.equal(stalled, 2, 'real playback must permit a later independent stall notification');
  await clock.advance(2_000);
  assert.equal(video.plays, 3, 'real playback must permit a later guarded soft recovery');
  assert.equal(failed, 0);
  connection.destroy();
});

for (const mediaMode of ['audio', 'video'] as const) {
  test(`${mediaMode === 'audio' ? 'audio' : 'a hidden video'} remains healthy on a genuine timeline after a seek without new video frames`, async () => {
    const clock = fakeClock();
    class QualityVideo extends FakeVideo {
      total = 30;
      getVideoPlaybackQuality() { return { totalVideoFrames: this.total, droppedVideoFrames: 0 }; }
    }
    const video = new QualityVideo();
    let failed = 0;
    let progress = 0;
    const flv: PlaybackSource = { ...source, protocol: 'flv', format: 'flv', url: 'https://cdn.example/live.flv' };
    const mpegts = {
      getFeatureList: () => ({ mseLivePlayback: true }), LoggingControl: {},
      Events: { ERROR: 'error' }, ErrorTypes: { NETWORK_ERROR: 'network' },
      ErrorDetails: { MEDIA_FORMAT_UNSUPPORTED: 'format', MEDIA_CODEC_UNSUPPORTED: 'codec' },
      createPlayer() { return { on() {}, attachMediaElement() {}, load() {}, destroy() {} }; },
    } as unknown as typeof import('mpegts.js')['default'];
    const connection = await connectPlaybackSource(video as unknown as HTMLVideoElement, flv, new AbortController().signal,
      { playing() {}, progress() { progress++; }, failed() { failed++; } }, 'stable',
      { clock, mediaMode, framesExpected: () => false, loadMpegts: async () => ({ default: mpegts }) });
    video.total = 60;
    video.currentTime = 1;
    video.dispatchEvent(new Event('timeupdate'));
    seek(video, 100, () => { video.total++; });
    assert.equal(progress, 1);
    for (let second = 1; second <= 30; second++) {
      await clock.advance(1_000);
      video.currentTime++;
      video.dispatchEvent(new Event('timeupdate'));
    }
    assert.equal(progress, 31);
    assert.equal(failed, 0);
    connection.destroy();
  });
}
