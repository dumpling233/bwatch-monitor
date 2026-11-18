import assert from 'node:assert/strict';
import test from 'node:test';
import type { PlaybackInfo, PlaybackSource } from '../shared/playback.js';
import { createPlaybackSession, createPlaybackRecoveryState, playbackRouteKey, type PlaybackConnectionEvents } from '../client/multiview/playbackSession.js';
import { connectPlaybackSource } from '../client/multiview/playbackAdapters.js';
import { LocalLoginClientError } from '../client/multiview/localLoginClient.js';

const flush = async () => { for (let index = 0; index < 24; index++) await Promise.resolve(); };
const progressed = (events: PlaybackConnectionEvents) => { events.playing(); events.progress?.(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
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
        const next = [...timers].filter(([, entry]) => entry.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        time = next[1].at; timers.delete(next[0]); next[1].callback(); await flush();
      }
      time = end; await flush();
    },
  };
}
const video: PlaybackSource = { id: 'video', url: 'https://video.example/live.m3u8', protocol: 'hls', format: 'fmp4', codec: 'avc', actualQuality: 10000 };
const legacy: PlaybackSource = { ...video, id: 'legacy', url: 'https://video.example/live.flv', protocol: 'flv', format: 'flv' };
const pure: PlaybackSource = { ...legacy, id: 'pure', url: 'https://audio.example/live.flv', actualQuality: 150, mediaKind: 'audio-only', expiresAt: 40_000 };
const backup: PlaybackSource = { ...pure, id: 'pure-backup', url: 'https://audio-backup.example/live.flv' };
const info = (sources = [video, legacy]): PlaybackInfo => ({ roomId: '1', status: 'live', requestedQuality: 10000,
  qualities: [{ qn: 10000, label: '原画' }], sources, resolvedAt: 0 });

test('pure audio is lazy, anonymous, verified from media, and preserves video quality/route without periodic renewal', async () => {
  const clock = fakeClock(), hooks: PlaybackConnectionEvents[] = [], attached: string[] = [], qualities: number[] = [];
  const delivery: Array<string | null> = [null], published: PlaybackInfo[] = [], identities: string[] = [];
  let audioCalls = 0, released = 0;
  const session = createPlaybackSession({ clock, requestedQuality: 10000, identityScope: 'account:1', preferredRoute: playbackRouteKey(video),
    resolve: async (_signal, context) => { qualities.push(context.qn); return info(); },
    resolveAudioPlayback: async () => { audioCalls++; return { playback: info([pure]), release() { released++; } }; },
    connect: async (source, _signal, events) => { attached.push(source.id); hooks.push(events); return { destroy() {} }; },
    onInfo: value => published.push(value), onSource: (_source, identity) => identities.push(identity!),
    onAudioDeliveryChange: value => delivery.push(value),
  });
  await flush(); progressed(hooks[0]); assert.equal(audioCalls, 0);
  session.setMediaMode('audio'); await flush();
  assert.deepEqual(attached, ['video', 'pure']); assert.equal(published.length, 1);
  progressed(hooks[1]); assert.equal(delivery.at(-1), null);
  hooks[1].audioOnlyVerified?.(); assert.equal(delivery.at(-1), 'audio-only'); assert.equal(identities.at(-1), 'anonymous');
  session.setIdentityScope('anonymous'); await flush();
  await clock.advance(120_000);
  assert.equal(audioCalls, 1); assert.deepEqual(attached, ['video', 'pure']);
  session.setMediaMode('video'); await flush(); progressed(hooks[2]);
  assert.deepEqual(attached, ['video', 'pure', 'video']); assert.deepEqual(qualities, [10000, 10000]); assert.equal(released, 1);
  session.destroy(); assert.equal(released, 1); assert.equal(clock.size(), 0);
});

test('an unavailable extension stays in fallback until the user refreshes or enters a new audio intent', async () => {
  const clock = fakeClock(), hooks: PlaybackConnectionEvents[] = [], attached: string[] = [], delivery: Array<string | null> = [];
  let audioCalls = 0;
  const session = createPlaybackSession({ clock, mediaMode: 'audio', resolve: async () => info(),
    resolveAudioPlayback: async () => { audioCalls++; throw new Error('unsupported extension'); },
    connect: async (source, _signal, events) => { hooks.push(events); attached.push(source.id); return { destroy() {} }; },
    onAudioDeliveryChange: value => delivery.push(value),
  });
  await flush(); assert.deepEqual(attached, ['legacy']); assert.notEqual(delivery.at(-1), 'full-stream');
  progressed(hooks[0]); assert.equal(delivery.at(-1), 'full-stream');
  await clock.advance(60_000); assert.equal(audioCalls, 1);
  session.reconnect(); await flush(); progressed(hooks[1]); assert.equal(audioCalls, 2);
  session.setMediaMode('video'); await flush(); progressed(hooks[2]);
  session.setMediaMode('audio'); await flush(); assert.equal(audioCalls, 3);
  session.destroy(); assert.equal(clock.size(), 0);
});

test('installing the extension after legacy fallback can upgrade the same session through user refresh', async () => {
  const clock = fakeClock(), hooks: PlaybackConnectionEvents[] = [], attached: string[] = [], forced: boolean[] = [];
  const delivery: Array<string | null> = [];
  let installed = false, released = 0;
  const session = createPlaybackSession({ clock, mediaMode: 'audio', resolve: async () => info(),
    resolveAudioPlayback: async (_signal, context) => {
      forced.push(context.force);
      if (!installed) throw new Error('Extension unavailable');
      return { playback: info([pure]), release() { released++; } };
    },
    connect: async (source, _signal, events) => { hooks.push(events); attached.push(source.id); return { destroy() {} }; },
    onAudioDeliveryChange: value => delivery.push(value),
  });
  await flush(); progressed(hooks[0]); assert.deepEqual(attached, ['legacy']); assert.equal(delivery.at(-1), 'full-stream');
  installed = true;
  session.reconnect(); await flush();
  assert.deepEqual(forced, [false, true]); assert.deepEqual(attached, ['legacy', 'pure']);
  hooks[1].audioOnlyVerified?.(); progressed(hooks[1]); assert.equal(delivery.at(-1), 'audio-only');
  await clock.advance(120_000); assert.equal(forced.length, 2);
  session.destroy(); assert.equal(released, 1); assert.equal(clock.size(), 0);
});

test('a verified new bridge upgrades legacy audio once without touching healthy pure audio', async () => {
  const clock = fakeClock(), hooks: PlaybackConnectionEvents[] = [], attached: string[] = [];
  let installed = false, calls = 0;
  const session = createPlaybackSession({ clock, mediaMode: 'audio', resolve: async () => info(),
    resolveAudioPlayback: async () => {
      calls++;
      if (!installed) throw new Error('Extension missing');
      return { playback: info([pure]), release() {} };
    },
    connect: async (source, _signal, events) => { attached.push(source.id); hooks.push(events); return { destroy() {} }; },
  });
  await flush(); progressed(hooks[0]);
  installed = true;
  session.audioCapabilityAvailable('bridge-1');
  session.audioCapabilityAvailable('bridge-1');
  await flush();
  assert.equal(calls, 2); assert.deepEqual(attached, ['legacy', 'pure']);
  hooks[1].audioOnlyVerified?.(); progressed(hooks[1]);
  session.audioCapabilityAvailable('bridge-2'); await flush();
  await clock.advance(120_000);
  assert.equal(calls, 2); assert.deepEqual(attached, ['legacy', 'pure']);
  session.destroy(); assert.equal(clock.size(), 0);
});

test('bridge arrival during old discovery waits for legacy progress and does not miss its one upgrade', async () => {
  const clock = fakeClock(), oldDiscovery = deferred<void>(), hooks: PlaybackConnectionEvents[] = [], attached: string[] = [];
  let calls = 0;
  const session = createPlaybackSession({ clock, mediaMode: 'audio', resolve: async () => info(),
    resolveAudioPlayback: async () => {
      if (++calls === 1) { await oldDiscovery.promise; throw new Error('Old discovery failed'); }
      return { playback: info([pure]), release() {} };
    },
    connect: async (source, _signal, events) => { attached.push(source.id); hooks.push(events); return { destroy() {} }; },
  });
  session.audioCapabilityAvailable('installed'); await flush(); assert.equal(calls, 1);
  oldDiscovery.resolve(); await flush(); assert.deepEqual(attached, ['legacy']);
  progressed(hooks[0]); await flush();
  assert.equal(calls, 2); assert.deepEqual(attached, ['legacy', 'pure']);
  session.destroy(); assert.equal(clock.size(), 0);
});

test('an unavailable bridge optimization retains healthy legacy audio without reopening its stream', async () => {
  const clock = fakeClock(), hooks: PlaybackConnectionEvents[] = [], attached: string[] = [];
  let audioCalls = 0, legacyCalls = 0, destroyed = 0;
  const session = createPlaybackSession({ clock, mediaMode: 'audio',
    resolve: async () => { legacyCalls++; return info(); },
    resolveAudioPlayback: async () => { audioCalls++; throw new Error('This room has no separate audio'); },
    connect: async (source, _signal, events) => { attached.push(source.id); hooks.push(events); return { destroy() { destroyed++; } }; },
  });
  await flush(); progressed(hooks[0]);
  session.audioCapabilityAvailable('new-bridge-without-room-audio'); await flush();
  assert.equal(audioCalls, 2); assert.equal(legacyCalls, 2);
  assert.deepEqual(attached, ['legacy']); assert.equal(destroyed, 0);
  session.audioCapabilityAvailable('new-bridge-without-room-audio'); await clock.advance(120_000);
  assert.equal(audioCalls, 2); assert.equal(legacyCalls, 2); assert.equal(destroyed, 0);
  session.destroy(); assert.equal(destroyed, 1); assert.equal(clock.size(), 0);
});

test('new bridges leave video and initial audio fallback alone, and cancellation prevents a queued upgrade', async () => {
  for (const mode of ['video', 'audio'] as const) {
    const clock = fakeClock(), hooks: PlaybackConnectionEvents[] = [];
    let calls = 0;
    const session = createPlaybackSession({ clock, mediaMode: mode, audioCapabilityKey: 'already-present', resolve: async () => info(),
      resolveAudioPlayback: async () => { calls++; throw new Error('No audio in this room'); },
      connect: async (_source, _signal, events) => { hooks.push(events); return { destroy() {} }; },
    });
    await flush(); progressed(hooks[0]);
    session.audioCapabilityAvailable('already-present'); await flush();
    assert.equal(calls, mode === 'audio' ? 1 : 0);
    session.audioCapabilityAvailable('new-bridge'); session.destroy(); await flush();
    assert.equal(calls, mode === 'audio' ? 1 : 0); assert.equal(clock.size(), 0);
  }
});

test('a bridge-triggered audio upgrade obeys the existing rate-limit cooldown', async () => {
  const clock = fakeClock(), recovery = createPlaybackRecoveryState(), hooks: PlaybackConnectionEvents[] = [];
  let installed = false, calls = 0;
  const session = createPlaybackSession({ clock, recoveryState: recovery, mediaMode: 'audio', resolve: async () => info(),
    resolveAudioPlayback: async () => {
      calls++; if (!installed) throw new Error('Extension missing');
      return { playback: info([pure]), release() {} };
    },
    connect: async (_source, _signal, events) => { hooks.push(events); return { destroy() {} }; },
  });
  await flush(); progressed(hooks[0]);
  recovery.cooldownUntil = clock.now() + 30_000; installed = true;
  session.audioCapabilityAvailable('installed'); await flush(); assert.equal(calls, 1);
  await clock.advance(29_999); assert.equal(calls, 1);
  await clock.advance(1); assert.equal(calls, 2);
  session.destroy(); assert.equal(clock.size(), 0);
});

test('only two pure routes are tried before legacy fallback, with one lease release and no retry loop', async () => {
  const clock = fakeClock(), hooks: PlaybackConnectionEvents[] = [], attached: string[] = [];
  let audioCalls = 0, released = 0;
  const session = createPlaybackSession({ clock, mediaMode: 'audio', resolve: async () => info(),
    resolveAudioPlayback: async () => { audioCalls++; return { playback: info([pure, backup, { ...pure, id: 'third' }]), release() { released++; } }; },
    connect: async (source, _signal, events) => { hooks.push(events); attached.push(source.id); return { destroy() {} }; },
  });
  await flush(); hooks[0].failed({ kind: 'network', httpStatus: 403 }); await flush();
  assert.equal(released, 0); hooks[1].failed('unsupported'); await flush();
  assert.deepEqual(attached, ['pure', 'pure-backup', 'legacy']); assert.equal(released, 1);
  progressed(hooks[2]); hooks[2].failed(); await flush(); await clock.advance(5_000);
  assert.equal(audioCalls, 1);
  session.destroy(); assert.equal(released, 1); assert.equal(clock.size(), 0);
});

test('pure CDN rate limits defer legacy fallback until Retry-After instead of bypassing the limit', async () => {
  const clock = fakeClock(), hooks: PlaybackConnectionEvents[] = [];
  let legacyCalls = 0, audioCalls = 0, released = 0;
  const session = createPlaybackSession({ clock, mediaMode: 'audio',
    resolve: async () => { legacyCalls++; return info(); },
    resolveAudioPlayback: async () => { audioCalls++; return { playback: info([pure, backup]), release() { released++; } }; },
    connect: async (_source, _signal, events) => { hooks.push(events); return { destroy() {} }; },
  });
  await flush(); hooks[0].failed({ kind: 'network', httpStatus: 429, retryAfter: 30 }); await flush();
  assert.equal(legacyCalls, 0); assert.equal(hooks.length, 1); assert.equal(released, 1);
  await clock.advance(29_999); assert.equal(legacyCalls, 0);
  await clock.advance(1); assert.equal(legacyCalls, 1); assert.equal(audioCalls, 1);
  session.destroy(); assert.equal(clock.size(), 0);
});

for (const status of [412, 429]) test(`pure audio metadata ${status} defers bounded legacy fallback until Retry-After`, async () => {
  const clock = fakeClock(), hooks: PlaybackConnectionEvents[] = [], cooldowns: number[] = [];
  let legacyCalls = 0, audioCalls = 0;
  const session = createPlaybackSession({ clock, mediaMode: 'audio',
    resolve: async () => { legacyCalls++; return info(); },
    resolveAudioPlayback: async () => {
      audioCalls++;
      throw status === 429 ? new LocalLoginClientError('RATE_LIMITED', 'rate limited', 30)
        : Object.assign(new Error('rate limited'), { status, retryAfter: 30 });
    },
    onCooldown: seconds => cooldowns.push(seconds),
    connect: async (_source, _signal, events) => { hooks.push(events); return { destroy() {} }; },
  });
  await flush(); assert.equal(audioCalls, 1); assert.equal(legacyCalls, 0); assert.equal(hooks.length, 0);
  assert.deepEqual(cooldowns, [30]);
  await clock.advance(29_999); assert.equal(legacyCalls, 0); assert.equal(audioCalls, 1);
  await clock.advance(1); assert.equal(legacyCalls, 1); assert.equal(audioCalls, 1);
  progressed(hooks[0]); await clock.advance(120_000);
  assert.equal(audioCalls, 1); assert.equal(legacyCalls, 1);
  session.destroy(); assert.equal(clock.size(), 0);
});

test('a room access rejection during pure-audio initialization cannot fall back through the legacy resolver', async () => {
  for (const status of [401, 403, 404, 409]) {
    const clock = fakeClock(), statuses: string[] = [];
    let legacyCalls = 0, attached = 0;
    const session = createPlaybackSession({ clock, mediaMode: 'audio',
      resolve: async () => { legacyCalls++; return info(); },
      resolveAudioPlayback: async () => { throw Object.assign(new Error('access rejected'), { status }); },
      connect: async () => { attached++; return { destroy() {} }; },
      onStatus: status => statuses.push(status),
    });
    await flush(); await clock.advance(120_000);
    assert.equal(legacyCalls, 0); assert.equal(attached, 0); assert.equal(statuses.at(-1), 'restricted');
    session.destroy(); assert.equal(clock.size(), 0);
  }
});

test('pure metadata cooldown retains the current healthy audio stream during a bridge upgrade', async () => {
  const clock = fakeClock(), hooks: PlaybackConnectionEvents[] = [], cooldowns: number[] = [];
  let audioCalls = 0, legacyCalls = 0, destroyed = 0, limited = false;
  const session = createPlaybackSession({ clock, mediaMode: 'audio',
    resolve: async () => { legacyCalls++; return info(); },
    resolveAudioPlayback: async () => {
      audioCalls++;
      if (limited) throw Object.assign(new Error('rate limited'), { status: 429, retryAfter: 60 });
      throw new Error('Extension unavailable');
    },
    onCooldown: seconds => cooldowns.push(seconds),
    connect: async (_source, _signal, events) => { hooks.push(events); return { destroy() { destroyed++; } }; },
  });
  await flush(); progressed(hooks[0]); limited = true;
  session.audioCapabilityAvailable('new-rate-limited-bridge'); await flush();
  assert.equal(audioCalls, 2); assert.equal(legacyCalls, 1); assert.equal(destroyed, 0);
  assert.deepEqual(cooldowns, [60]);
  await clock.advance(59_999); assert.equal(legacyCalls, 1); assert.equal(destroyed, 0);
  await clock.advance(1); assert.equal(legacyCalls, 2); assert.equal(audioCalls, 2); assert.equal(destroyed, 0);
  assert.equal(hooks.length, 1);
  session.destroy(); assert.equal(destroyed, 1); assert.equal(clock.size(), 0);
});

test('a user refresh retries pure audio only after an existing rate-limit cooldown finishes', async () => {
  const clock = fakeClock(), hooks: PlaybackConnectionEvents[] = [];
  let audioCalls = 0, legacyCalls = 0, released = 0;
  const session = createPlaybackSession({ clock, mediaMode: 'audio',
    resolve: async () => { legacyCalls++; return info(); },
    resolveAudioPlayback: async () => { audioCalls++; return { playback: info([pure]), release() { released++; } }; },
    connect: async (_source, _signal, events) => { hooks.push(events); return { destroy() {} }; },
  });
  await flush(); hooks[0].failed({ kind: 'network', httpStatus: 429, retryAfter: 30 }); await flush();
  session.reconnect(); await flush();
  assert.equal(audioCalls, 1); assert.equal(legacyCalls, 0);
  await clock.advance(29_999); assert.equal(audioCalls, 1);
  await clock.advance(1); assert.equal(audioCalls, 2); assert.equal(legacyCalls, 0);
  hooks[1].audioOnlyVerified?.(); progressed(hooks[1]);
  session.destroy(); assert.equal(released, 2); assert.equal(clock.size(), 0);
});

for (const action of ['reverse', 'destroy'] as const) test(`late pure-audio lease is released exactly once after ${action}`, async () => {
  const clock = fakeClock(), pending = deferred<{ playback: PlaybackInfo; release(): void }>(), hooks: PlaybackConnectionEvents[] = [];
  let released = 0, audioSignal!: AbortSignal, attached = 0;
  const session = createPlaybackSession({ clock, resolve: async () => info(),
    resolveAudioPlayback: async signal => { audioSignal = signal; return pending.promise; },
    connect: async (_source, _signal, events) => { attached++; hooks.push(events); return { destroy() {} }; },
  });
  await flush(); progressed(hooks[0]); session.setMediaMode('audio'); await flush();
  if (action === 'reverse') session.setMediaMode('video'); else session.destroy();
  await flush(); assert.equal(audioSignal.aborted, true);
  pending.resolve({ playback: info([pure]), release() { released++; } }); await flush();
  assert.equal(released, 1); assert.equal(attached, 1);
  session.destroy(); assert.equal(clock.size(), 0);
});

test('queued pure-audio initialization does not spend its deadline and identity changes do not cancel it', async () => {
  const clock = fakeClock(), pending = deferred<{ playback: PlaybackInfo; release(): void }>();
  const attached: string[] = [];
  let start!: () => void, signal!: AbortSignal, released = 0, legacyCalls = 0;
  const session = createPlaybackSession({ clock, mediaMode: 'audio', identityScope: 'account:1',
    resolve: async () => { legacyCalls++; return info(); },
    resolveAudioPlayback: async (current, context) => { signal = current; context.onQueued?.(); start = () => context.onStarted?.(); return pending.promise; },
    connect: async (source, _signal, events) => { attached.push(source.id); progressed(events); return { destroy() {} }; },
  });
  await flush(); session.setIdentityScope('account:2'); await clock.advance(30_000);
  assert.equal(signal.aborted, false); assert.equal(legacyCalls, 0); assert.deepEqual(attached, []);
  start(); pending.resolve({ playback: info([{ ...pure, expiresAt: 100_000 }]), release() { released++; } }); await flush();
  assert.deepEqual(attached, ['pure']); session.destroy(); assert.equal(released, 1); assert.equal(clock.size(), 0);
});

test('video preferences change without resolving or replacing a healthy pure-audio connection', async () => {
  const clock = fakeClock(), hooks: PlaybackConnectionEvents[] = [], attached: string[] = [], qualities: number[] = [];
  const alternate = { ...video, id: 'video-alternate', url: 'https://video-alternate.example/live.m3u8' };
  let audioCalls = 0;
  const session = createPlaybackSession({ clock, mediaMode: 'audio', requestedQuality: 10000,
    resolve: async (_signal, context) => { qualities.push(context.qn); return info([video, legacy, alternate]); },
    resolveAudioPlayback: async () => { audioCalls++; return { playback: info([pure]), release() {} }; },
    connect: async (source, _signal, events) => { attached.push(source.id); hooks.push(events); return { destroy() {} }; },
  });
  await flush(); hooks[0].audioOnlyVerified?.(); progressed(hooks[0]);
  session.updateQuality(400);
  session.selectRoute('cdn:video-alternate.example', info([alternate]));
  session.selectFormat('hls-fmp4', 'cdn:video-alternate.example');
  await flush(); assert.deepEqual(attached, ['pure']); assert.equal(audioCalls, 1); assert.deepEqual(qualities, []);
  session.setMediaMode('video'); await flush();
  assert.deepEqual(attached, ['pure', 'video-alternate']); assert.deepEqual(qualities, [400]);
  session.destroy(); assert.equal(clock.size(), 0);
});

test('logout during public audio initialization immediately stops the previous personal video', async () => {
  const clock = fakeClock(), pending = deferred<{ playback: PlaybackInfo; release(): void }>();
  const hooks: PlaybackConnectionEvents[] = [], attached: string[] = [];
  let audioSignal!: AbortSignal, destroyed = 0, released = 0;
  const session = createPlaybackSession({ clock, identityScope: 'account:1', resolve: async () => info(),
    resolveAudioPlayback: async signal => { audioSignal = signal; return pending.promise; },
    connect: async (source, _signal, events) => { attached.push(source.id); hooks.push(events); return { destroy() { destroyed++; } }; },
  });
  await flush(); progressed(hooks[0]); session.setMediaMode('audio'); await flush();
  session.setIdentityScope('anonymous'); await flush();
  assert.equal(destroyed, 1); assert.equal(audioSignal.aborted, false);
  pending.resolve({ playback: info([pure]), release() { released++; } }); await flush();
  assert.deepEqual(attached, ['video', 'pure']); hooks[1].audioOnlyVerified?.(); progressed(hooks[1]);
  session.destroy(); assert.equal(released, 1); assert.equal(clock.size(), 0);
});

test('pure initialization times out into legacy and releases any late result', async () => {
  const clock = fakeClock(), pending = deferred<{ playback: PlaybackInfo; release(): void }>(), attached: string[] = [];
  let released = 0, signal!: AbortSignal;
  const session = createPlaybackSession({ clock, mediaMode: 'audio', resolve: async () => info(),
    resolveAudioPlayback: async current => { signal = current; return pending.promise; },
    connect: async (source, _signal, events) => { attached.push(source.id); progressed(events); return { destroy() {} }; },
  });
  await flush(); await clock.advance(8_000);
  assert.equal(signal.aborted, true); assert.deepEqual(attached, ['legacy']);
  pending.resolve({ playback: info([pure]), release() { released++; } }); await flush(); assert.equal(released, 1);
  session.destroy(); assert.equal(clock.size(), 0);
});

test('a failed return to video retains the old pure-audio lease for rollback', async () => {
  const clock = fakeClock(), hooks: PlaybackConnectionEvents[] = [], attached: string[] = [];
  let released = 0;
  const session = createPlaybackSession({ clock, mediaMode: 'audio', resolve: async () => info([video]),
    resolveAudioPlayback: async () => ({ playback: info([pure]), release() { released++; } }),
    connect: async (source, _signal, events) => { attached.push(source.id); hooks.push(events); return { destroy() {} }; },
  });
  await flush(); hooks[0].audioOnlyVerified?.(); progressed(hooks[0]);
  session.setMediaMode('video'); await flush(); assert.equal(released, 0);
  hooks[1].failed('unsupported'); await flush();
  assert.deepEqual(attached, ['pure', 'video', 'pure']); assert.equal(released, 0);
  session.destroy(); assert.equal(released, 1); assert.equal(clock.size(), 0);
});

test('reversing a pending return to video retains the pure-audio fallback lease', async () => {
  const clock = fakeClock(), hooks: PlaybackConnectionEvents[] = [], attached: string[] = [];
  let released = 0;
  const session = createPlaybackSession({ clock, mediaMode: 'audio', resolve: async () => info([video]),
    resolveAudioPlayback: async () => ({ playback: info([pure]), release() { released++; } }),
    connect: async (source, _signal, events) => { attached.push(source.id); hooks.push(events); return { destroy() {} }; },
  });
  await flush(); hooks[0].audioOnlyVerified?.(); progressed(hooks[0]);
  session.setMediaMode('video'); await flush(); session.setMediaMode('audio'); await flush();
  assert.deepEqual(attached, ['pure', 'video', 'pure']); assert.equal(released, 0);
  session.destroy(); assert.equal(released, 1); assert.equal(clock.size(), 0);
});

for (const hasVideo of [true, false]) test(`pure adapter discovers actual FLV tracks and ${hasVideo ? 'rejects video' : 'confirms audio'}`, async () => {
  const clock = fakeClock(), listeners = new Map<string, (...args: unknown[]) => void>();
  const media = { currentTime: 0, paused: false, buffered: { length: 0 }, canPlayType: () => '', play: async () => {},
    pause() {}, load() {}, removeAttribute() {}, addEventListener() {}, removeEventListener() {} } as unknown as HTMLVideoElement;
  let input: Record<string, unknown> = {}, verified = 0, failed = 0;
  const mpegts = { getFeatureList: () => ({ mseLivePlayback: true }), LoggingControl: {},
    Events: { ERROR: 'error', MEDIA_INFO: 'media_info' }, ErrorTypes: { NETWORK_ERROR: 'network' },
    ErrorDetails: { MEDIA_FORMAT_UNSUPPORTED: 'format', MEDIA_CODEC_UNSUPPORTED: 'codec' },
    createPlayer(source: Record<string, unknown>) { input = source; return {
      on(name: string, callback: (...args: unknown[]) => void) { listeners.set(name, callback); },
      attachMediaElement() {}, load() {}, destroy() {},
    }; },
  } as unknown as typeof import('mpegts.js')['default'];
  const connection = await connectPlaybackSource(media, pure, new AbortController().signal,
    { playing() {}, audioOnlyVerified() { verified++; }, failed() { failed++; } }, 'stable',
    { mediaMode: 'audio', clock, loadMpegts: async () => ({ default: mpegts }) });
  assert.equal('hasVideo' in input, false);
  listeners.get('media_info')?.({ hasAudio: true, hasVideo });
  assert.equal(verified, hasVideo ? 0 : 1); assert.equal(failed, hasVideo ? 1 : 0);
  connection.destroy(); assert.equal(clock.size(), 0);
});
