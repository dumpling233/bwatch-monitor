import type { PlaybackMediaMode, PlaybackSource } from '../../shared/playback';
import { observePlaybackHealth } from './playbackHealth';
import type { PlaybackConnection, PlaybackConnectionEvents, PlaybackFailure } from './playbackSession';

export type PlaybackMode = 'stable' | 'low-latency';
export { playbackRouteKey } from './playbackSession';
export interface PlaybackAdapterDependencies {
  loadHls?: () => Promise<typeof import('hls.js')>;
  loadMpegts?: () => Promise<typeof import('mpegts.js')>;
  mediaMode?: PlaybackMediaMode;
  framesExpected?: () => boolean;
  clock?: { now(): number; setTimeout(callback: () => void, delay: number): unknown; clearTimeout(handle: unknown): void };
}

export function hasMseAvcSupport(): boolean {
  try {
    const runtime = globalThis as typeof globalThis & { ManagedMediaSource?: typeof MediaSource; WebKitMediaSource?: typeof MediaSource };
    const mediaSource = runtime.ManagedMediaSource ?? runtime.MediaSource ?? runtime.WebKitMediaSource;
    return typeof mediaSource?.isTypeSupported === 'function'
      && mediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E,mp4a.40.2"');
  } catch { return false; }
}

export function orderPlaybackSources(video: HTMLVideoElement, sources: PlaybackSource[], mseSupported = hasMseAvcSupport()): PlaybackSource[] {
  const nativeOnly = !mseSupported && Boolean(video.canPlayType('application/vnd.apple.mpegurl'));
  return sources.map((source, index) => ({ source, index })).sort((a, b) => {
    // Short HLS requests release per-origin HTTP/1.1 slots between segments.
    // Continuous FLV requests can exhaust those slots when many rooms share a CDN.
    const score = (source: PlaybackSource) => source.protocol === 'flv' ? 2
      : source.format === (nativeOnly ? 'ts' : 'fmp4') ? 0 : 1;
    return score(a.source) - score(b.source) || a.index - b.index;
  }).map(({ source }) => source);
}

/** Only codec/MIME evidence rules a format out; CDN failures never change this. */
export function supportsPlaybackSource(video: HTMLVideoElement, source: Pick<PlaybackSource, 'protocol' | 'format'>): boolean {
  return hasMseAvcSupport() || (source.protocol === 'hls' && Boolean(video.canPlayType('application/vnd.apple.mpegurl')));
}

/** Media requests stay in the browser. Library imports and recovery are bounded per connection. */
export async function connectPlaybackSource(video: HTMLVideoElement, source: PlaybackSource,
  signal: AbortSignal, events: PlaybackConnectionEvents, mode: PlaybackMode = 'stable',
  dependencies: PlaybackAdapterDependencies = {}): Promise<PlaybackConnection> {
  const mediaMode = dependencies.mediaMode ?? 'video';
  const clock = dependencies.clock ?? {
    now: Date.now,
    setTimeout: (callback: () => void, delay: number) => globalThis.setTimeout(callback, delay),
    clearTimeout: (handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  let disposed = false;
  let failedOnce = false;
  let destroyEngine: (() => void) | undefined;
  let watchTimer: unknown;
  let unobserveHealth: (() => void) | undefined;
  let lastTime = video.currentTime || 0;
  let lastFrames = frames();
  let lastTimelineProgress = clock.now();
  let lastFrameProgress = lastTimelineProgress;
  let lastCheck = lastTimelineProgress;
  let graceUntil = 0;
  let frameEvidence = false;
  let hasProgress = false;
  let stalledNotified = false;
  let softRecoveryAttempted = false;
  let softRecoveryAt = 0;
  let pauseResumeAttempted = false;
  let playPending = false;
  let autoplayBlocked = false;
  let recoverySeeking = false;
  let seekPending = false;
  let internalRecoveries = 0;
  let buffering = false;
  let acknowledgeHlsProgress: (() => void) | undefined;
  const hidden = () => typeof document !== 'undefined' && document.hidden;
  const framesExpected = () => mediaMode === 'video' && !hidden() && dependencies.framesExpected?.() !== false;
  const canAutoRecover = () => events.canAutoRecover?.() !== false;
  function frames(): number | undefined {
    if (mediaMode === 'audio') return;
    try {
      const quality = video.getVideoPlaybackQuality?.();
      if (!quality || !Number.isFinite(quality.totalVideoFrames)) return;
      const dropped = Number.isFinite(quality.droppedVideoFrames) ? quality.droppedVideoFrames : 0;
      return Math.max(0, quality.totalVideoFrames - dropped);
    }
    catch { return undefined; }
  }
  function clearTimers() {
    if (watchTimer !== undefined) clock.clearTimeout(watchTimer);
    watchTimer = undefined;
    unobserveHealth?.(); unobserveHealth = undefined;
  }
  function failed(reason?: PlaybackFailure) {
    if (disposed || failedOnce || signal.aborted) return;
    finishBuffering('cancel');
    if (reason?.kind === 'autoplay') {
      autoplayBlocked = true;
      events.failed(reason);
      return;
    }
    failedOnce = true; clearTimers();
    events.failed(reason ?? { kind: video.error?.code === 4 ? 'unsupported' : video.error?.code === 3 ? 'media' : 'network' });
  }
  function resumed() {
    if (!autoplayBlocked) return;
    autoplayBlocked = false;
    const now = clock.now();
    lastCheck = lastTimelineProgress = lastFrameProgress = now;
    graceUntil = now + 5_000;
    resetSeekBaseline();
    pauseResumeAttempted = softRecoveryAttempted = stalledNotified = false;
  }
  function finishBuffering(state: 'end' | 'cancel') {
    if (!buffering) return;
    buffering = false;
    events.buffering?.(state);
  }
  const playing = () => {
    if (!disposed && !failedOnce) {
      resumed();
      if (!framesExpected() || video.paused) finishBuffering('cancel');
      else if (!video.seeking && !seekPending) finishBuffering('end');
      events.playing();
    }
  };
  const waiting = () => { if (!disposed && !failedOnce && !autoplayBlocked) events.waiting?.(); };
  const mediaWaiting = () => {
    waiting();
    if (disposed || failedOnce || signal.aborted || autoplayBlocked || buffering
      || video.paused || video.seeking || seekPending || video.readyState >= 3 || !framesExpected()) return;
    // Consume the last sample before starvation. A delayed timeupdate or health
    // tick must not mistake pre-waiting progress for recovery of this interval.
    // Keep the real last-progress timestamps unchanged for the stall watchdog.
    resetSeekBaseline();
    buffering = true;
    events.buffering?.('start');
  };
  function resetSeekBaseline() {
    lastFrames = frames();
    if (Number.isFinite(video.currentTime)) lastTime = video.currentTime;
  }
  // Engine gap-skips do not erase starvation already confirmed by native waiting.
  // A seek alone never starts an interval and never counts as playback progress.
  const seeking = () => { seekPending = true; resetSeekBaseline(); };
  const seeked = () => { resetSeekBaseline(); seekPending = false; };
  function progress() {
    // Live engines may seek a paused element to bound its buffer; that is not playback.
    if (disposed || failedOnce || video.paused) return;
    const now = clock.now(), currentFrames = frames(), time = video.currentTime;
    if (recoverySeeking || seekPending || video.seeking || (Number.isFinite(time) && time < lastTime)) {
      lastFrames = currentFrames;
      if (Number.isFinite(time)) lastTime = time;
      return;
    }
    if (currentFrames === undefined || lastFrames === undefined || currentFrames < lastFrames) {
      frameEvidence = false; lastFrameProgress = now;
    }
    const framesAdvanced = currentFrames !== undefined && lastFrames !== undefined && currentFrames > lastFrames;
    if (framesAdvanced) { frameEvidence = true; lastFrameProgress = now; }
    lastFrames = currentFrames;
    const timelineAdvanced = Number.isFinite(time) && time > lastTime + 0.01;
    if (timelineAdvanced) { lastTime = time; lastTimelineProgress = now; }
    if (!timelineAdvanced || (framesExpected() && frameEvidence && now - lastFrameProgress >= 2_000)) return;
    resumed();
    acknowledgeHlsProgress?.();
    hasProgress = true;
    pauseResumeAttempted = false; softRecoveryAttempted = false; stalledNotified = false;
    finishBuffering(framesExpected() ? 'end' : 'cancel');
    events.progress?.();
  }
  function play(fromUserGesture = false) {
    if (disposed || failedOnce || signal.aborted || playPending || autoplayBlocked && !fromUserGesture) return;
    playPending = true;
    const rejected = (error: unknown) => {
      if (disposed || failedOnce || signal.aborted) return;
      const name = (error as { name?: string }).name;
      if (name === 'NotAllowedError') failed({ kind: 'autoplay' });
      else if (name === 'NotSupportedError') failed({ kind: 'unsupported' });
      else if (name !== 'AbortError') failed();
    };
    // Keep video.play() in this call stack so one click can unlock every blocked room.
    try { void Promise.resolve(video.play()).then(() => {
      playPending = false;
      if (!disposed && !failedOnce && !signal.aborted && autoplayBlocked) { resumed(); events.playing(); }
    }, error => { playPending = false; rejected(error); }); }
    catch (error) { playPending = false; rejected(error); }
  }
  const canplay = () => { progress(); play(); };
  const ended = () => failed({ kind: 'network' });
  const mediaError = () => failed();
  const paused = () => {
    finishBuffering('cancel');
    if (disposed || failedOnce || autoplayBlocked) return;
    if (video.ended) { ended(); return; }
    waiting();
    if (canAutoRecover() && !pauseResumeAttempted && !playPending) { pauseResumeAttempted = true; play(); }
  };
  function softRecover() {
    softRecoveryAttempted = true; softRecoveryAt = clock.now();
    try {
      const buffered = video.buffered;
      if (buffered?.length && !video.seeking) {
        const index = buffered.length - 1, start = buffered.start(index), end = buffered.end(index);
        const target = Math.max(start + 0.05, end - (mode === 'stable' ? 1.5 : 0.5));
        if (Number.isFinite(target) && target < end - 0.05 && target > video.currentTime + 0.25) {
          recoverySeeking = true;
          try { video.currentTime = target; }
          finally { lastTime = video.currentTime; lastFrames = frames(); recoverySeeking = false; }
        }
      }
    } catch {}
    play();
  }
  function checkHealth(resumed = false) {
    if (disposed || failedOnce || signal.aborted || autoplayBlocked) return;
    if (resumed || !framesExpected()) finishBuffering('cancel');
    const now = clock.now(), delayed = now - lastCheck > 10_000;
    lastCheck = now;
    progress();
    if (resumed || delayed) { graceUntil = now + 5_000; lastFrameProgress = now; }
    if (now < graceUntil) return;
    if (video.ended) { ended(); return; }
    if (video.paused) paused();
    const lastProgress = framesExpected() && frameEvidence ? Math.min(lastTimelineProgress, lastFrameProgress) : lastTimelineProgress;
    const stagnant = now - lastProgress;
    if (stagnant >= 10_000 && !stalledNotified) {
      stalledNotified = true;
      const label = mediaMode === 'audio' ? '音频' : '画面';
      events.stalled?.(canAutoRecover() ? `${label}暂时停滞，正在尝试恢复` : `${label}暂时停滞，自动重连已关闭`);
    }
    if (!canAutoRecover()) return;
    if (stagnant >= 12_000 && !softRecoveryAttempted) { softRecover(); return; }
    if (stagnant >= (hasProgress ? 25_000 : 20_000) && now - softRecoveryAt >= 2_000) failed({ kind: 'network' });
  }
  const connection: PlaybackConnection = {
    checkHealth,
    resumePlayback() { play(true); },
    destroy() {
      if (disposed) return;
      disposed = true;
      finishBuffering('cancel');
      signal.removeEventListener('abort', connection.destroy);
      for (const [name, listener] of listeners) video.removeEventListener(name, listener);
      clearTimers();
      try { destroyEngine?.(); } catch { /* Release the element even when an engine has already failed. */ }
      video.pause(); video.removeAttribute('src'); video.load();
    },
  };
  const listeners: Array<[string, EventListener]> = [
    ['playing', playing], ['timeupdate', progress], ['canplay', canplay], ['error', mediaError],
    ['waiting', mediaWaiting], ['stalled', waiting], ['ended', ended], ['pause', paused],
    ['seeking', seeking], ['seeked', seeked],
  ];
  signal.addEventListener('abort', connection.destroy, { once: true });
  if (signal.aborted) { connection.destroy(); return connection; }
  for (const [name, listener] of listeners) video.addEventListener(name, listener);
  if (dependencies.clock) {
    const watch = () => {
      watchTimer = undefined; checkHealth();
      if (!disposed && !failedOnce) watchTimer = clock.setTimeout(watch, 1_000);
    };
    watchTimer = clock.setTimeout(watch, 1_000);
  } else unobserveHealth = observePlaybackHealth(checkHealth);
  function networkFailure(code?: number, retryAfter?: number): PlaybackFailure {
    return { kind: code === 412 || code === 429 ? 'cooldown' : 'network',
      ...(Number.isFinite(code) ? { httpStatus: code } : {}), ...(retryAfter ? { retryAfter } : {}) };
  }
  function readRetryAfter(network: unknown): number | undefined {
    try {
      const detail = network as { headers?: { get(name: string): string | null }; getResponseHeader?(name: string): string | null } | undefined;
      const header = detail?.headers?.get('retry-after') ?? detail?.getResponseHeader?.('retry-after');
      if (!header) return;
      const seconds = /^\d+(?:\.\d+)?$/.test(header) ? Number(header) : (Date.parse(header) - clock.now()) / 1_000;
      return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : undefined;
    } catch { return; }
  }
  try {
    if (mediaMode === 'audio' && source.protocol !== 'flv') {
      failed({ kind: 'unsupported' }); return connection;
    }
    if (source.protocol === 'hls') {
      const { default: Hls } = await (dependencies.loadHls?.() ?? import('hls.js'));
      if (disposed || signal.aborted) return connection;
      if (!Hls.isSupported()) {
        if (video.canPlayType('application/vnd.apple.mpegurl')) { video.src = source.url; play(); return connection; }
        failed({ kind: 'unsupported' }); return connection;
      }
      const hls = new Hls({
        lowLatencyMode: mode === 'low-latency', backBufferLength: 5,
        maxBufferLength: mode === 'stable' ? 20 : 12, maxMaxBufferLength: 30,
        liveSyncDurationCount: mode === 'stable' ? 4 : 3,
        liveSyncMode: 'buffered',
        xhrSetup(xhr) { xhr.withCredentials = false; },
      });
      const fragmentLoads = new Map<string, number>();
      acknowledgeHlsProgress = () => fragmentLoads.clear();
      destroyEngine = () => { acknowledgeHlsProgress = undefined; fragmentLoads.clear(); hls.destroy(); };
      hls.on(Hls.Events.FRAG_LOADED, (_event, { frag, part }) => {
        if (disposed || failedOnce || signal.aborted || autoplayBlocked || part || typeof frag.sn !== 'number') return;
        // Alternate audio and main fragments can share every sequence field.
        const key = `${frag.type}:${frag.level}:${frag.cc}:${frag.sn}`;
        const loads = (fragmentLoads.get(key) ?? 0) + 1;
        fragmentLoads.set(key, loads);
        if (fragmentLoads.size > 8) fragmentLoads.delete(fragmentLoads.keys().next().value!);
        // PARTIAL fMP4 fragments may be loaded indefinitely without a fatal hls.js error.
        // Bound completed repeats without playback progress, then use the session's route recovery.
        if (loads >= 4) {
          hls.stopLoad();
          failed({ kind: 'network' });
        }
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (disposed || failedOnce) return;
        const code = data.response?.code;
        if (code === 412 || code === 429) { failed(networkFailure(code, readRetryAfter(data.networkDetails))); return; }
        if (!data.fatal) { waiting(); return; }
        try {
          if (internalRecoveries++ === 0 && data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            waiting(); hls.recoverMediaError(); return;
          }
          if (internalRecoveries === 1 && data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            waiting(); hls.startLoad(-1); return;
          }
        } catch { /* Escalate an unsuccessful library recovery to this room's session. */ }
        failed(data.type === Hls.ErrorTypes.MEDIA_ERROR ? { kind: 'media' } : networkFailure(code));
      });
      hls.on(Hls.Events.MANIFEST_PARSED, () => play());
      hls.loadSource(source.url); hls.attachMedia(video);
      return connection;
    }
    const { default: mpegts } = await (dependencies.loadMpegts?.() ?? import('mpegts.js'));
    if (disposed || signal.aborted) return connection;
    if (!mpegts.getFeatureList().mseLivePlayback) { failed({ kind: 'unsupported' }); return connection; }
    mpegts.LoggingControl.enableAll = false;
    const pureAudio = mediaMode === 'audio' && source.mediaKind === 'audio-only';
    const player = mpegts.createPlayer({ type: 'flv', isLive: true, url: source.url, cors: true, withCredentials: false,
      // Keep actual FLV track discovery for pure sources. Overriding hasVideo=false
      // would conceal an upstream mixed stream and incorrectly advertise savings.
      ...(mediaMode === 'audio' && !pureAudio ? { hasAudio: true, hasVideo: false } : {}) }, {
      referrerPolicy: 'no-referrer', enableWorker: false, enableStashBuffer: mode === 'stable', stashInitialSize: 64 * 1024,
      // A policy-blocked element can wait for a click while retaining this connection.
      // Keep its live position advancing so backward buffer cleanup remains bounded.
      lazyLoad: false, liveBufferLatencyChasing: true, liveBufferLatencyChasingOnPaused: true,
      liveBufferLatencyMaxLatency: mode === 'stable' ? 6 : 3, liveBufferLatencyMinRemain: mode === 'stable' ? 1.5 : 0.5,
      autoCleanupSourceBuffer: true, autoCleanupMaxBackwardDuration: 10, autoCleanupMinBackwardDuration: 5,
    });
    destroyEngine = () => player.destroy();
    if (pureAudio) player.on(mpegts.Events.MEDIA_INFO, (info: { hasAudio?: boolean; hasVideo?: boolean }) => {
      if (disposed || failedOnce || signal.aborted) return;
      if (info.hasVideo === true || info.hasAudio === false) { failed({ kind: 'unsupported' }); return; }
      if (info.hasAudio === true && info.hasVideo === false) events.audioOnlyVerified?.();
    });
    player.on(mpegts.Events.ERROR, (type: string, detail: string, info?: { code?: number; retryAfter?: number }) => {
      if (disposed || failedOnce) return;
      if ([mpegts.ErrorDetails.MEDIA_FORMAT_UNSUPPORTED, mpegts.ErrorDetails.MEDIA_CODEC_UNSUPPORTED].includes(detail)) failed({ kind: 'unsupported' });
      else failed(type === mpegts.ErrorTypes.NETWORK_ERROR ? networkFailure(info?.code, info?.retryAfter) : { kind: 'media' });
    });
    player.attachMediaElement(video); player.load(); play();
    return connection;
  } catch (error) {
    connection.destroy();
    throw error;
  }
}
