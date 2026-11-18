import { playbackFormatKey, type PlaybackFormatPreference, type PlaybackInfo, type PlaybackMediaMode, type PlaybackSource } from '../../shared/playback';
import { enqueuePlaybackRecovery } from './playbackHealth';

export type PlayerStatus = 'loading' | 'playing' | 'stalled' | 'paused' | 'offline' | 'restricted' | 'retrying' | 'error' | 'unsupported' | 'autoplay-blocked';
export type PlaybackResolveReason = 'initial' | 'quality' | 'recovery' | 'expiry' | 'manual' | 'media-mode' | 'format';
export interface PlaybackOptionsState {
  state: 'idle' | 'loading' | 'ready' | 'error';
  qn?: number;
  reason?: PlaybackResolveReason;
  message?: string;
}
export interface PlaybackResolveContext {
  qn: number; reason: PlaybackResolveReason; force: boolean;
  /** A bounded request pool suspends the network deadline while this request waits for a slot. */
  onQueued?(): void;
  onStarted?(): void;
}
export interface PlaybackConnection { destroy(): void; checkHealth?(resumed?: boolean): void; resumePlayback?(): void }
export interface PlaybackFailure {
  kind: 'network' | 'media' | 'unsupported' | 'autoplay' | 'cooldown';
  httpStatus?: number;
  retryAfter?: number;
}
export interface PlaybackConnectionEvents {
  playing(): void;
  progress?(): void;
  waiting?(): void;
  /** Native waiting interval; engine gap-seeks preserve it, explicit lifecycle changes cancel it. */
  buffering?(state: 'start' | 'end' | 'cancel'): void;
  stalled?(message: string): void;
  canAutoRecover?(): boolean;
  /** Reported by the demuxer for the downloaded stream, never inferred from the URL. */
  audioOnlyVerified?(): void;
  failed(reason?: PlaybackFailure | 'unsupported' | 'autoplay'): void;
}
export interface PlaybackRecoveryState {
  failures: number;
  cooldownUntil: number;
  healthyRoute?: string;
  audioHealthyRoute?: string;
  routes: Map<string, { failures: number; failedUntil: number }>;
}
export const createPlaybackRecoveryState = (): PlaybackRecoveryState => ({ failures: 0, cooldownUntil: 0, routes: new Map() });

/** A route preference never contains a signed URL or a quality-specific token. */
export function playbackRouteKey(source: PlaybackSource): string {
  let host = '';
  try { host = new URL(source.url).hostname; } catch { host = source.id; }
  return [source.protocol, source.format, source.codec, host].join(':');
}
/** A user-facing CDN choice spans all compatible media formats on that host. */
export function playbackCdnKey(source: PlaybackSource): string {
  try { return `cdn:${new URL(source.url).hostname}`; } catch { return `cdn:${source.id}`; }
}
function matchesRoutePreference(source: PlaybackSource, preference?: string | null): boolean {
  return Boolean(preference && (preference.startsWith('cdn:') ? playbackCdnKey(source) : playbackRouteKey(source)) === preference);
}
export interface PlaybackSession extends PlaybackConnection {
  /** Must call the current media element synchronously inside the user's click. */
  resumePlayback(): void;
  updateQuality(qn: number): void;
  setMediaMode(mode: PlaybackMediaMode): void;
  /** Only call after a new document bridge has passed HELLO capability validation. */
  audioCapabilityAvailable(key: string | undefined): void;
  reconnect(): void;
  selectRoute(key: string | null, info?: PlaybackInfo): void;
  selectFormat(format: PlaybackFormatPreference, route?: string | null): void;
  setAutoReconnect(enabled: boolean): void;
  networkRestored(): void;
  setIdentityScope(scope: string): void;
}
export interface PlaybackSessionOptions {
  initialReason?: 'initial' | 'manual';
  identityScope?: string;
  audioCapabilityKey?: string;
  requestedQuality?: number;
  mediaMode?: PlaybackMediaMode;
  preferredRoute?: string | null;
  preferredFormat?: PlaybackFormatPreference;
  autoReconnect?: boolean;
  resolveTimeoutMs?: number;
  enqueueRecovery?(action: () => void, signal: AbortSignal): () => void;
  recoveryState?: PlaybackRecoveryState;
  resolve(signal: AbortSignal, context: PlaybackResolveContext): Promise<PlaybackInfo>;
  resolveAudioPlayback?(signal: AbortSignal, context: PlaybackResolveContext): Promise<{ playback: PlaybackInfo; release(): void }>;
  connect(source: PlaybackSource, signal: AbortSignal, events: PlaybackConnectionEvents, mediaMode: PlaybackMediaMode): Promise<PlaybackConnection>;
  orderSources?(sources: PlaybackSource[]): PlaybackSource[];
  supportsSource?(source: PlaybackSource): boolean;
  isForeground?(): boolean;
  onInfo?(info: PlaybackInfo, identityScope?: string): void;
  onSource?(source: PlaybackSource, identityScope?: string): void;
  onSourceCleared?(): void;
  onPendingSource?(source: PlaybackSource | null): void;
  onOptionsState?(state: PlaybackOptionsState['state'], message?: string, context?: Pick<PlaybackResolveContext, 'qn' | 'reason'>): void;
  onCooldown?(seconds: number): void;
  onStatus?(status: PlayerStatus, message?: string): void;
  onAutoplayBlockedChange?(resume: (() => void) | null): void;
  onMediaModeRejected?(mode: PlaybackMediaMode, message: string): void;
  onAudioDeliveryChange?(delivery: 'audio-only' | 'full-stream' | null): void;
  clock?: { now(): number; setTimeout(callback: () => void, delay: number): unknown; clearTimeout(handle: unknown): void };
}

/** One room owns independent metadata requests and a stable media connection. */
export function createPlaybackSession(options: PlaybackSessionOptions): PlaybackSession {
  const clock = options.clock ?? {
    now: Date.now,
    setTimeout: (callback: () => void, delay: number) => globalThis.setTimeout(callback, delay),
    clearTimeout: (handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const recovery = options.recoveryState ?? createPlaybackRecoveryState();
  const enqueueRecovery = options.enqueueRecovery ?? (typeof window === 'undefined' ? undefined : enqueuePlaybackRecovery);
  let requestedQuality = options.requestedQuality ?? 250;
  let resolveQuality = requestedQuality;
  const failedQualities = new Set<number>();
  let mediaMode = options.mediaMode ?? 'video';
  let committedMediaMode = mediaMode;
  let preferredRoute = options.preferredRoute ?? null;
  let preferredFormat = options.preferredFormat ?? 'auto';
  let autoReconnect = options.autoReconnect ?? true;
  let stopped = false;
  let identityScope = options.identityScope ?? 'anonymous';
  const sourceIdentities = new WeakMap<PlaybackSource, string>();
  let requestVersion = 0;
  let connectionVersion = 0;
  let request: { automatic: boolean; cancel(): void } | undefined;
  let inFlightResolve: Promise<void> | undefined;
  let sources: PlaybackSource[] = [];
  let sourcesQuality: number | undefined;
  let attempted = new Set<string>();
  let unsupported = new Set<string>();
  let qualityFallback: PlaybackSource | undefined;
  let qualityFallbackInfo: PlaybackInfo | undefined;
  const optimizationFallbacks = new WeakSet<PlaybackSource>();
  let currentInfo: PlaybackInfo | undefined;
  type AudioLease = { playback: PlaybackInfo; release(): void };
  let audioFallbackDisabled = false;
  let pureRequestVersion: number | undefined;
  let audioDelivery: 'audio-only' | 'full-stream' | null = null;
  let audioCapabilityKey = options.audioCapabilityKey;
  let pendingAudioCapability: string | undefined;
  let audioCapabilityQueued = false;
  let currentAudioLease: AudioLease | undefined;
  const audioLeases = new Set<AudioLease>();
  const releasedAudioLeases = new WeakSet<AudioLease>();
  const sourceAudioLeases = new WeakMap<PlaybackSource, AudioLease>();
  let mediaTransition: {
    target: PlaybackMediaMode; previous: PlaybackMediaMode; fallback?: PlaybackSource;
    sources: PlaybackSource[]; info?: PlaybackInfo; sourcesQuality?: number;
  } | undefined;
  let mediaTransitionTimer: unknown;
  let lastInstabilitySwitch = -Infinity;
  let active: {
    source: PlaybackSource; identityScope: string; mediaMode: PlaybackMediaMode; controller: AbortController; connection?: PlaybackConnection;
    audioLease?: AudioLease; audioVerified?: boolean;
    version: number; lastProgress?: number; healthySince?: number; healthReset: boolean; hasPlayed: boolean; stalled: boolean; autoplayBlocked: boolean;
    firstProgressAt?: number; waitingSince?: number; interruptions: { start: number; end: number }[];
  } | undefined;
  let retryTimer: unknown;
  let expiryTimer: unknown;
  let retryContext: PlaybackResolveContext | undefined;
  let retryAt = 0;
  let recoveryWork: { controller: AbortController; started: boolean; optimization?: boolean; cancel?: () => void } | undefined;

  const status = (state: PlayerStatus, message?: string) => { if (!stopped) options.onStatus?.(state, message); };
  const healthKey = (source: PlaybackSource, mode = mediaMode) => `${mode === 'audio' ? source.mediaKind === 'audio-only' ? 'pure-audio:' : 'audio:' : ''}${playbackRouteKey(source)}`;
  const foreground = () => options.isForeground?.() ?? (typeof document === 'undefined' || !document.hidden);
  const sourceIdentity = (source: PlaybackSource) => active?.source === source ? active.identityScope : sourceIdentities.get(source) ?? identityScope;
  const copySource = (source: PlaybackSource, patch?: Partial<PlaybackSource>) => {
    const copy = { ...source, ...patch }; sourceIdentities.set(copy, sourceIdentity(source));
    const lease = sourceAudioLeases.get(source); if (lease) sourceAudioLeases.set(copy, lease);
    return copy;
  };
  const publishInfo = (info: PlaybackInfo) => options.onInfo?.(info, info.sources[0] ? sourceIdentity(info.sources[0]) : identityScope);
  const resetInterruptions = () => {
    if (active) { active.waitingSince = undefined; active.interruptions = []; }
    if (recoveryWork?.optimization && !recoveryWork.started) releaseRecovery();
    maybeUpgradeAudio();
  };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', resetInterruptions);
  function clearMediaTransition() {
    if (mediaTransitionTimer !== undefined) clock.clearTimeout(mediaTransitionTimer);
    mediaTransitionTimer = undefined;
    mediaTransition = undefined;
    pruneAudioLeases();
  }
  function releaseAudioLease(lease: AudioLease) {
    if (!audioLeases.delete(lease)) return;
    disposeAudioLease(lease);
  }
  function disposeAudioLease(lease: AudioLease) {
    if (releasedAudioLeases.has(lease)) return;
    releasedAudioLeases.add(lease);
    try { lease.release(); } catch { /* A released extension lease never blocks playback cleanup. */ }
  }
  function pruneAudioLeases() {
    const fallbackLease = mediaTransition?.fallback ? sourceAudioLeases.get(mediaTransition.fallback) : undefined;
    for (const lease of audioLeases) if (lease !== currentAudioLease && lease !== active?.audioLease && lease !== fallbackLease) releaseAudioLease(lease);
  }
  function useAudioLease(lease?: AudioLease) {
    currentAudioLease = lease;
    if (lease) audioLeases.add(lease);
    pruneAudioLeases();
  }
  function publishAudioDelivery(delivery: 'audio-only' | 'full-stream' | null) {
    if (audioDelivery === delivery) return;
    audioDelivery = delivery;
    options.onAudioDeliveryChange?.(delivery);
    maybeUpgradeAudio();
  }
  function maybeUpgradeAudio() {
    if (stopped || audioCapabilityQueued || !pendingAudioCapability || mediaMode !== 'audio' || audioDelivery !== 'full-stream'
      || !active || active.source.mediaKind === 'audio-only' || typeof document !== 'undefined' && document.hidden) return;
    // Finish the current media callback before starting one optional upgrade. A
    // bridge arriving during legacy initialization is consumed after real progress.
    audioCapabilityQueued = true;
    queueMicrotask(() => {
      audioCapabilityQueued = false;
      if (stopped || !pendingAudioCapability || mediaMode !== 'audio' || audioDelivery !== 'full-stream'
        || !active || active.source.mediaKind === 'audio-only' || typeof document !== 'undefined' && document.hidden) return;
      pendingAudioCapability = undefined;
      reconnectPlayback('media-mode');
    });
  }
  const usingPureAudio = () => mediaMode === 'audio' && !audioFallbackDisabled
    && (active?.source.mediaKind === 'audio-only' || pureRequestVersion === requestVersion || Boolean(currentAudioLease));
  function fallbackToFullAudio() {
    audioFallbackDisabled = true;
    if (active?.source.mediaKind === 'audio-only') clearConnection();
    useAudioLease();
    sources = []; sourcesQuality = undefined; attempted.clear(); unsupported.clear();
    publishAudioDelivery(null);
    void resolve(context('media-mode', false));
  }
  function startMediaTransitionDeadline() {
    const transition = mediaTransition;
    if (stopped || !transition || transition.target !== mediaMode || mediaTransitionTimer !== undefined) return;
    mediaTransitionTimer = clock.setTimeout(() => {
      mediaTransitionTimer = undefined;
      if (!stopped && mediaTransition === transition) {
        if (transition.target === 'audio' && options.resolveAudioPlayback && !audioFallbackDisabled) fallbackToFullAudio();
        else rollbackMediaMode('播放模式切换超时，已恢复原模式');
      }
    }, options.resolveTimeoutMs ?? 15_000);
  }
  function resumeBlockedPlayback() {
    if (stopped || !active?.autoplayBlocked || !active.connection?.resumePlayback) return;
    // Include a hanging play() promise in the switch deadline. Repeated clicks
    // and later playing events must not extend an already running deadline.
    startMediaTransitionDeadline();
    active.connection.resumePlayback();
  }
  function commitMediaMode(mode: PlaybackMediaMode) {
    if (mode !== mediaMode) return;
    committedMediaMode = mode;
    clearMediaTransition();
  }
  function releaseRecovery() {
    const previous = recoveryWork;
    recoveryWork = undefined;
    previous?.controller.abort();
    previous?.cancel?.();
  }
  function queueRecovery(action: () => void, optimization = false) {
    releaseRecovery();
    if (stopped || !autoReconnect) return;
    if (!enqueueRecovery) { action(); return; }
    const controller = new AbortController(), work = { controller, started: false, optimization } as NonNullable<typeof recoveryWork>;
    recoveryWork = work;
    work.cancel = enqueueRecovery(() => {
      if (recoveryWork !== work || work.started) return;
      if (stopped || controller.signal.aborted || !autoReconnect) { releaseRecovery(); return; }
      work.started = true;
      action();
    }, controller.signal);
    if (controller.signal.aborted) work.cancel();
  }
  function recoverResolve(next: PlaybackResolveContext) {
    const automatic = !(next.reason === 'expiry' && active?.hasPlayed);
    const action = () => { void resolve(next, automatic); };
    if (active) action();
    else queueRecovery(action);
  }
  function clearRetry() {
    if (retryTimer !== undefined) clock.clearTimeout(retryTimer);
    retryTimer = undefined; retryContext = undefined; retryAt = 0;
  }
  function clearExpiry() {
    if (expiryTimer !== undefined) clock.clearTimeout(expiryTimer);
    expiryTimer = undefined;
  }
  function clearConnection() {
    const previous = active;
    active = undefined;
    connectionVersion++;
    clearExpiry();
    previous?.controller.abort();
    previous?.connection?.destroy();
    pruneAudioLeases();
    if (previous?.mediaMode === 'audio') publishAudioDelivery(null);
    if (previous?.autoplayBlocked) options.onAutoplayBlockedChange?.(null);
    if (previous) options.onPendingSource?.(null);
  }
  function context(reason: PlaybackResolveReason, force = ['recovery', 'expiry', 'manual'].includes(reason)): PlaybackResolveContext {
    return { qn: resolveQuality, reason, force };
  }
  const validSource = (source: PlaybackSource) => source.expiresAt === undefined
    || !Number.isFinite(source.expiresAt) || source.expiresAt > clock.now() + 1_000;
  function scheduleExpiry(source?: PlaybackSource) {
    clearExpiry();
    if (active?.autoplayBlocked) return;
    // A progressing audio FLV stays open beyond URL expiry; renew only after a real failure.
    if (source?.mediaKind === 'audio-only') return;
    if (!source?.expiresAt || !Number.isFinite(source.expiresAt)) return;
    const remaining = source.expiresAt - clock.now();
    const delay = remaining > 30_000 ? remaining - 30_000 : Math.max(0, remaining - 1_000);
    expiryTimer = clock.setTimeout(() => { expiryTimer = undefined; void resolve(context('expiry')); }, delay);
  }
  function schedule(next: PlaybackResolveContext, minimum = 0, countFailure = true) {
    if (stopped) return;
    releaseRecovery();
    clearRetry();
    if (!autoReconnect && !(next.reason === 'expiry' && active?.hasPlayed)) {
      const message = recovery.cooldownUntil > clock.now()
        ? '播放请求暂时受限，冷却后可手动重新连接' : '自动重连已关闭，可手动重新连接';
      if (!active?.autoplayBlocked && (!active || active.hasPlayed)) status(active?.stalled ? 'stalled' : active ? 'playing' : 'error', message);
      return;
    }
    const backoff = countFailure ? Math.min(30_000, 1_000 * 2 ** Math.min(recovery.failures++, 5)) : 0;
    retryAt = clock.now() + Math.max(minimum, backoff, recovery.cooldownUntil - clock.now());
    retryContext = next;
    const seconds = Math.ceil((retryAt - clock.now()) / 1_000);
    const cause = recovery.cooldownUntil > clock.now() ? '播放请求暂时受限'
      : next.reason === 'quality' ? '清晰度获取失败' : next.reason === 'expiry' ? '播放地址刷新失败' : '当前线路暂不可用';
    if (!active?.autoplayBlocked && (!active || active.hasPlayed)) status(active?.stalled ? 'stalled' : active ? 'playing' : 'retrying', cause + '，' + seconds + ' 秒后重试');
    retryTimer = clock.setTimeout(() => {
      retryTimer = undefined;
      const pending = retryContext;
      retryContext = undefined; retryAt = 0;
      if (pending) recoverResolve({ ...pending, qn: resolveQuality });
    }, Math.max(0, retryAt - clock.now()));
  }
  function cooldown(seconds?: number) {
    const duration = Number.isFinite(seconds) && seconds! > 0 ? seconds! * 1_000 : 30_000;
    recovery.cooldownUntil = Math.max(recovery.cooldownUntil, clock.now() + duration);
    options.onCooldown?.(Math.ceil((recovery.cooldownUntil - clock.now()) / 1_000));
  }
  const matchesFormat = (source: PlaybackSource) => mediaMode === 'audio' ? source.protocol === 'flv'
    : preferredFormat === 'auto' || playbackFormatKey(source) === preferredFormat;
  function orderedAvailable() {
    const usable = sources.filter(source => (mediaMode !== 'audio' || source.protocol === 'flv')
      && matchesFormat(source)
      && (options.supportsSource?.(source) ?? true)
      && validSource(source) && !attempted.has(source.id) && !unsupported.has(source.id)
      && (recovery.routes.get(healthKey(source))?.failedUntil ?? 0) <= clock.now());
    const order = options.orderSources?.(usable) ?? usable;
    return order.map((source, index) => ({ source, index })).sort((a, b) => {
      const rank = (source: PlaybackSource) => matchesRoutePreference(source, preferredRoute) ? 0
        : playbackRouteKey(source) === (mediaMode === 'audio' ? recovery.audioHealthyRoute : recovery.healthyRoute) ? 1 : 2;
      const qualityRank = (source: PlaybackSource) => source.actualQuality === requestedQuality ? 0 : 1;
      return qualityRank(a.source) - qualityRank(b.source) || rank(a.source) - rank(b.source) || a.index - b.index;
    }).map(item => item.source);
  }
  function allUnsupported() {
    const selected = sources.filter(matchesFormat);
    return selected.length > 0 && selected.every(source => unsupported.has(source.id) || !(options.supportsSource?.(source) ?? true));
  }
  function restoreQualityFallback(): boolean {
    const fallback = qualityFallback;
    qualityFallback = undefined;
    const info = qualityFallbackInfo; qualityFallbackInfo = undefined;
    if (!fallback || sourceIdentity(fallback) !== 'anonymous' && sourceIdentity(fallback) !== identityScope) return false;
    const retaining = active?.source.url === fallback.url && active.hasPlayed && !active.stalled;
    // URL expiry rejects a new request; it does not stop an already progressing FLV connection.
    if (!retaining && !validSource(fallback)) return false;
    if (!retaining && !autoReconnect) return false;
    const optimization = optimizationFallbacks.has(fallback);
    resolveQuality = fallback.actualQuality;
    sources = info?.sources.filter(validSource) ?? [fallback];
    sourcesQuality = resolveQuality;
    if (!optimization) { attempted = new Set(); unsupported = new Set(); }
    if (info) { currentInfo = info; publishInfo(info); }
    if (retaining && active) {
      releaseRecovery(); clearRetry();
      options.onSource?.(active.source, active.identityScope);
      status('playing', optimization ? '备用线路暂不可用，已继续此前线路' : '新清晰度暂不可用，已继续此前实际画质');
    } else {
      const action = () => { void connect(fallback, optimization ? '备用线路暂不可用，正在恢复此前线路' : '新清晰度暂不可用，正在恢复此前实际画质'); };
      queueRecovery(action);
    }
    return true;
  }
  function downgradeQuality(): boolean {
    if (!autoReconnect || mediaMode === 'audio' || mediaTransition || !currentInfo) return false;
    failedQualities.add(resolveQuality);
    if (failedQualities.size > 3) return false;
    const next = currentInfo.qualities.map(quality => quality.qn)
      .filter(qn => qn < resolveQuality && !failedQualities.has(qn)).sort((a, b) => b - a)[0];
    if (!next) return false;
    resolveQuality = next;
    // This runs only after an actual selection/startup failed, never to probe a menu in advance.
    void resolve(context('quality', false));
    return true;
  }
  function nextSource() {
    if (stopped) return;
    if (recovery.cooldownUntil > clock.now()) {
      if (mediaTransition) rollbackMediaMode('播放请求正在冷却，请稍后重试，已恢复原模式');
      else schedule(context('recovery'), 0, false);
      return;
    }
    if (!autoReconnect) { status('error', '自动重连已关闭，可手动重新连接'); return; }
    const candidate = orderedAvailable()[0];
    if (candidate) { queueRecovery(() => { void connect(candidate); }); return; }
    if (mediaMode === 'audio' && !audioFallbackDisabled && sources.some(source => source.mediaKind === 'audio-only')) { fallbackToFullAudio(); return; }
    if (mediaTransition) { rollbackMediaMode('所选播放模式的线路暂时不可用，已恢复原模式'); return; }
    if (preferredFormat !== 'auto' && !sources.some(matchesFormat)) {
      status('error', '所选格式本次未提供可用线路，请切回自动格式');
      return;
    }
    if (restoreQualityFallback()) return;
    if (allUnsupported()) {
      status('unsupported', mediaMode === 'audio' ? '当前浏览器不支持仅听声音，可切回视频模式' : '当前浏览器不支持这些直播格式');
      return;
    }
    if (downgradeQuality()) return;
    const waits = sources.filter(validSource).map(source => recovery.routes.get(healthKey(source))?.failedUntil ?? 0)
      .filter(until => until > clock.now());
    schedule(context('recovery'), waits.length ? Math.min(...waits) - clock.now() : 0);
  }
  async function connect(source: PlaybackSource, notice?: string) {
    if (stopped) return;
    clearConnection();
    attempted.add(source.id);
    const controller = new AbortController();
    const item = { source, identityScope: sourceIdentity(source), mediaMode, controller, audioLease: sourceAudioLeases.get(source),
      version: ++connectionVersion, healthReset: false, hasPlayed: false, stalled: false, autoplayBlocked: false, interruptions: [] } as NonNullable<typeof active>;
    active = item;
    status(recovery.failures || attempted.size > 1 ? 'retrying' : 'loading', notice ?? (mediaMode === 'audio' ? '正在连接音频' : '正在连接直播'));
    options.onPendingSource?.(source);
    const current = () => !stopped && active === item && !controller.signal.aborted;
    const resume = () => { if (current()) resumeBlockedPlayback(); };
    const resumed = () => {
      if (!item.autoplayBlocked) return;
      item.autoplayBlocked = false;
      options.onAutoplayBlockedChange?.(null);
      startMediaTransitionDeadline();
      scheduleExpiry(item.source);
    };
    const fail = (reason?: PlaybackFailure | 'unsupported' | 'autoplay') => {
      if (!current()) return;
      releaseRecovery();
      const error: PlaybackFailure = typeof reason === 'string' ? { kind: reason } : reason ?? { kind: 'network' };
      if (error.kind === 'autoplay') {
        item.autoplayBlocked = true;
        item.healthySince = undefined;
        item.stalled = false;
        clearRetry(); clearExpiry(); resetInterruptions();
        if (mediaTransitionTimer !== undefined) clock.clearTimeout(mediaTransitionTimer);
        mediaTransitionTimer = undefined;
        if (item.connection?.resumePlayback) options.onAutoplayBlockedChange?.(resume);
        status('autoplay-blocked', '浏览器阻止了自动播放，点击恢复播放');
        return;
      }
      clearConnection();
      if (item.mediaMode !== mediaMode) return;
      if (source.mediaKind === 'audio-only' && item.mediaMode === 'audio') {
        // Pure-audio attempts are bounded to this snapshot. Do not poison the legacy FLV route.
        unsupported.add(source.id);
        if (error.kind === 'cooldown' || error.httpStatus === 412 || error.httpStatus === 429) {
          audioFallbackDisabled = true;
          useAudioLease(); sources = []; sourcesQuality = undefined;
          if (mediaTransitionTimer !== undefined) clock.clearTimeout(mediaTransitionTimer);
          mediaTransitionTimer = undefined;
          cooldown(error.retryAfter); schedule(context('recovery'), 0, false);
          return;
        }
        const candidate = orderedAvailable()[0];
        if (candidate) void connect(candidate);
        else fallbackToFullAudio();
        return;
      }
      if (mediaTransition?.target === item.mediaMode) {
        if (error.kind === 'cooldown' || error.httpStatus === 412 || error.httpStatus === 429) {
          cooldown(error.retryAfter);
          rollbackMediaMode('播放请求正在冷却，请稍后重试，已恢复原模式');
          return;
        }
        if (error.kind === 'unsupported') unsupported.add(source.id);
        else {
          const key = healthKey(source, item.mediaMode), failures = (recovery.routes.get(key)?.failures ?? 0) + 1;
          recovery.routes.delete(key);
          recovery.routes.set(key, { failures, failedUntil: clock.now() + Math.min(30_000, 5_000 * 2 ** Math.min(failures - 1, 3)) });
          if (recovery.routes.size > 32) recovery.routes.delete(recovery.routes.keys().next().value!);
        }
        const candidate = orderedAvailable()[0];
        if (candidate) {
          void connect(candidate, '当前线路暂不可用，正在尝试备用线路');
          return;
        }
        rollbackMediaMode(error.kind === 'unsupported' ? '当前浏览器或线路暂不支持所选播放模式，已恢复原模式'
          : '所选播放模式暂时无法连接，已恢复原模式');
        return;
      }
      if (error.kind === 'unsupported') unsupported.add(source.id);
      else {
        const key = healthKey(source, item.mediaMode), failures = (recovery.routes.get(key)?.failures ?? 0) + 1;
        recovery.routes.delete(key);
        recovery.routes.set(key, { failures, failedUntil: clock.now() + Math.min(30_000, 5_000 * 2 ** Math.min(failures - 1, 3)) });
        if (recovery.routes.size > 32) recovery.routes.delete(recovery.routes.keys().next().value!);
      }
      if (error.kind === 'cooldown' || error.httpStatus === 412 || error.httpStatus === 429) {
        qualityFallback = undefined;
        cooldown(error.retryAfter); schedule(context('recovery'), 0, false); return;
      }
      if (restoreQualityFallback()) return;
      nextSource();
    };
    try {
      if (mediaTransition?.target === item.mediaMode) startMediaTransitionDeadline();
      const connection = await options.connect(source, controller.signal, {
        playing() { if (current()) { resumed(); if (!item.stalled) status('playing', notice); } },
        waiting() {
          if (!current() || item.autoplayBlocked) return;
          item.healthySince = undefined;
        },
        buffering(state) {
          if (!current()) return;
          if (state === 'cancel') { item.waitingSince = undefined; return; }
          if (item.autoplayBlocked || !foreground() || item.mediaMode === 'audio') { resetInterruptions(); return; }
          const now = clock.now();
          if (state === 'start') {
            if (item.firstProgressAt !== undefined && now - item.firstProgressAt >= 15_000 && item.waitingSince === undefined) item.waitingSince = now;
            return;
          }
          const start = item.waitingSince;
          item.waitingSince = undefined;
          if (start === undefined) return;
          if (now - start >= 500) item.interruptions.push({ start, end: now });
          // At least 500ms per admitted interval means 128 entries cover a full minute.
          item.interruptions = item.interruptions.filter(span => span.end > now - 60_000).slice(-128);
          const interruptedFor = item.interruptions.reduce((sum, span) => sum + span.end - Math.max(span.start, now - 60_000), 0);
          if (autoReconnect && !mediaTransition && !request && !recoveryWork?.optimization && now - lastInstabilitySwitch >= 60_000
            && item.interruptions.length >= 3 && interruptedFor >= 15_000) {
            const candidate = orderedAvailable().find(alternate => alternate.actualQuality === item.source.actualQuality
              && playbackRouteKey(alternate) !== playbackRouteKey(item.source));
            if (candidate) {
              item.interruptions = [];
              queueRecovery(() => {
                if (!current() || !foreground() || !validSource(candidate)) { releaseRecovery(); return; }
                lastInstabilitySwitch = clock.now();
                // This is an optional optimization of a still usable source.
                // Give a failed replacement one gated return to that source.
                qualityFallback = copySource(item.source);
                qualityFallbackInfo = currentInfo;
                optimizationFallbacks.add(qualityFallback);
                const key = healthKey(item.source, item.mediaMode), failures = recovery.routes.get(key)?.failures ?? 0;
                recovery.routes.set(key, { failures, failedUntil: clock.now() + 60_000 });
                if (recovery.routes.size > 32) recovery.routes.delete(recovery.routes.keys().next().value!);
                void connect(candidate, '当前线路反复缓冲，正在尝试同画质备用线路');
              }, true);
            }
          }
        },
        stalled(message) {
          if (!current() || item.stalled || item.autoplayBlocked) return;
          item.stalled = true;
          item.healthySince = undefined;
          status('stalled', message);
        },
        canAutoRecover() { return current() && !item.autoplayBlocked && autoReconnect; },
        audioOnlyVerified() {
          if (!current() || item.source.mediaKind !== 'audio-only') return;
          item.audioVerified = true;
          if (item.hasPlayed) { commitMediaMode(item.mediaMode); publishAudioDelivery('audio-only'); }
        },
        progress() {
          if (!current()) return;
          const wasBlocked = item.autoplayBlocked;
          resumed();
          const firstProgress = !item.hasPlayed;
          item.hasPlayed = true;
          if (source.mediaKind !== 'audio-only') resolveQuality = source.actualQuality;
          if (item.mediaMode === 'audio') publishAudioDelivery(source.mediaKind === 'audio-only' ? item.audioVerified ? 'audio-only' : null : 'full-stream');
          if (source.mediaKind !== 'audio-only' || item.audioVerified) commitMediaMode(item.mediaMode);
          if (!recoveryWork?.optimization || recoveryWork.started) releaseRecovery();
          if (firstProgress) { options.onPendingSource?.(null); options.onSource?.(item.source, item.identityScope); }
          if (item.stalled || firstProgress || wasBlocked) {
            item.stalled = false;
            status('playing', source.mediaKind !== 'audio-only' && source.actualQuality !== requestedQuality ? '请求的清晰度未返回，当前播放上游实际提供的档位' : notice);
          }
          const now = clock.now();
          if (firstProgress) item.firstProgressAt = now;
          if (!foreground() || item.mediaMode === 'audio') resetInterruptions();
          if (item.healthySince === undefined || item.lastProgress === undefined || now - item.lastProgress > 5_000) item.healthySince = now;
          item.lastProgress = now;
          if (!item.healthReset && now - item.healthySince >= 30_000) {
            item.healthReset = true; recovery.failures = 0;
            if (item.mediaMode === 'audio') recovery.audioHealthyRoute = playbackRouteKey(source);
            else recovery.healthyRoute = playbackRouteKey(source);
            recovery.routes.delete(healthKey(source, item.mediaMode));
            qualityFallback = undefined; qualityFallbackInfo = undefined;
          }
        },
        failed: fail,
      }, item.mediaMode);
      if (!current()) { connection.destroy(); return; }
      item.connection = connection;
      if (item.autoplayBlocked && connection.resumePlayback) options.onAutoplayBlockedChange?.(resume);
      if (item.mediaMode === mediaMode && !item.autoplayBlocked) scheduleExpiry(source);
    } catch (error) {
      if (current()) fail((error as { name?: string }).name === 'NotSupportedError' ? 'unsupported' : undefined);
    }
  }
  function rollbackMediaMode(message: string) {
    const previous = mediaTransition;
    if (stopped || !previous || previous.target !== mediaMode) return;
    currentAudioLease = previous.fallback ? sourceAudioLeases.get(previous.fallback) : undefined;
    clearMediaTransition();
    requestVersion++;
    request?.cancel();
    releaseRecovery();
    clearRetry();
    qualityFallback = undefined;
    mediaMode = previous.previous;
    useAudioLease(previous.fallback ? sourceAudioLeases.get(previous.fallback) : undefined);
    committedMediaMode = mediaMode;
    sources = previous.sources;
    sourcesQuality = previous.sourcesQuality;
    attempted = new Set(); unsupported = new Set();
    currentInfo = previous.info;
    if (currentInfo) publishInfo(currentInfo);
    options.onMediaModeRejected?.(mediaMode, message);
    if (active?.mediaMode === mediaMode) {
      if (active.hasPlayed) options.onSource?.(active.source, active.identityScope);
      status(active.stalled ? 'stalled' : active.hasPlayed ? 'playing' : 'loading');
      scheduleExpiry(active.source);
      return;
    }
    clearConnection();
    if (previous.fallback && validSource(previous.fallback) && recovery.cooldownUntil <= clock.now()) {
      void connect(previous.fallback);
    } else void resolve(context('media-mode', false));
  }
  function resolve(next: PlaybackResolveContext, automatic = false): Promise<void> {
    const pending = resolveRequest(next, automatic);
    inFlightResolve = pending;
    void pending.finally(() => { if (inFlightResolve === pending) inFlightResolve = undefined; });
    return pending;
  }
  async function resolveRequest(next: PlaybackResolveContext, automatic = false) {
    if (stopped) return;
    if (automatic && !autoReconnect) { releaseRecovery(); return; }
    if (recovery.cooldownUntil > clock.now()) {
      if (mediaTransition) rollbackMediaMode('播放请求正在冷却，请稍后重试，已恢复原模式');
      else schedule(next, 0, false);
      return;
    }
    clearRetry();
    request?.cancel();
    const controller = new AbortController(), version = ++requestVersion, resolvingMode = mediaMode, resolvingIdentity = identityScope;
    let timedOut = false;
    let timeout: unknown;
    let cancelDeadline!: (reason: Error) => void;
    const deadline = new Promise<never>((_resolve, reject) => {
      cancelDeadline = reject;
      const startTimeout = () => { timeout = clock.setTimeout(() => {
        timeout = undefined;
        timedOut = true;
        controller.abort();
        reject(new Error('Playback metadata request timed out'));
      }, options.resolveTimeoutMs ?? 15_000); };
      startTimeout();
      next = { ...next,
        onQueued() { if (timeout !== undefined) clock.clearTimeout(timeout); timeout = undefined; },
        onStarted() { if (!controller.signal.aborted && version === requestVersion && timeout === undefined) startTimeout(); },
      };
    });
    const finishRequest = () => {
      if (timeout !== undefined) clock.clearTimeout(timeout);
      timeout = undefined;
      if (request === pending) request = undefined;
    };
    const pending = { automatic, cancel() {
      const wasCurrent = request === pending;
      finishRequest();
      controller.abort();
      cancelDeadline(new DOMException('Playback metadata request cancelled', 'AbortError'));
      if (wasCurrent) options.onOptionsState?.('idle', undefined, next);
    } };
    request = pending;
    options.onOptionsState?.('loading', undefined, next);
    if (!active) status(recovery.failures ? 'retrying' : 'loading', mediaMode === 'audio' ? '正在获取直播音频' : '正在获取直播画面');
    try {
      if (resolvingMode === 'audio' && options.resolveAudioPlayback && !audioFallbackDisabled) {
        pureRequestVersion = version;
        const audioController = new AbortController();
        const cancelAudio = () => audioController.abort();
        controller.signal.addEventListener('abort', cancelAudio, { once: true });
        let accepted = false, finished = false, audioTimedOut = false;
        let audioTimer: unknown;
        let rejectAudioTimeout!: (reason: Error) => void;
        const startAudioTimer = () => {
          if (audioTimer !== undefined || audioController.signal.aborted) return;
          audioTimer = clock.setTimeout(() => {
            audioTimedOut = true;
            rejectAudioTimeout(new Error('Audio source timed out'));
            audioController.abort();
          }, 8_000);
        };
        const audioDeadline = new Promise<never>((_resolve, reject) => { rejectAudioTimeout = reject; startAudioTimer(); });
        const audioContext = { ...next,
          onQueued() { next.onQueued?.(); if (audioTimer !== undefined) clock.clearTimeout(audioTimer); audioTimer = undefined; },
          onStarted() { next.onStarted?.(); startAudioTimer(); },
        };
        const audioWork = Promise.resolve().then(() => options.resolveAudioPlayback!(audioController.signal, audioContext)).then(lease => {
          if (finished || stopped || controller.signal.aborted || version !== requestVersion) {
            disposeAudioLease(lease);
          }
          return lease;
        });
        try {
          const lease = await Promise.race([audioWork, audioDeadline, deadline]);
          if (audioTimer !== undefined) clock.clearTimeout(audioTimer);
          audioTimer = undefined;
          if (stopped || controller.signal.aborted || version !== requestVersion || resolvingMode !== mediaMode) {
            finished = true;
            disposeAudioLease(lease);
            return;
          }
          const audioSources = lease.playback.sources.filter(source => source.mediaKind === 'audio-only' && source.protocol === 'flv'
            && validSource(source) && (options.supportsSource?.(source) ?? true)).slice(0, 2);
          if (lease.playback.status === 'live' && audioSources.length) {
            accepted = true;
            for (const source of audioSources) { sourceIdentities.set(source, 'anonymous'); sourceAudioLeases.set(source, lease); }
            useAudioLease(lease);
            sources = audioSources; sourcesQuality = undefined; attempted = new Set(); unsupported = new Set();
            finishRequest();
            options.onOptionsState?.('ready', undefined, next);
            await connect(orderedAvailable()[0] ?? audioSources[0]);
            return;
          }
          disposeAudioLease(lease);
        } catch (error) {
          if (stopped || controller.signal.aborted || version !== requestVersion) return;
          const detail = error as { name?: string; status?: number };
          if (detail.name === 'AbortError' && !audioTimedOut || [401, 403, 404, 409].includes(detail.status ?? 0)) throw error;
          if (detail.status === 412 || detail.status === 429) {
            // An extension metadata limit applies before any CDN exists. Let
            // the shared cooldown run before bounded legacy fallback as well.
            audioFallbackDisabled = true;
            useAudioLease();
            throw error;
          }
        } finally {
          if (pureRequestVersion === version) pureRequestVersion = undefined;
          finished = !accepted;
          if (audioTimer !== undefined) clock.clearTimeout(audioTimer);
          controller.signal.removeEventListener('abort', cancelAudio);
          if (!accepted) audioController.abort();
        }
        audioFallbackDisabled = true;
        useAudioLease();
        // Queuing and the bounded optional optimization must not spend the legacy resolver's deadline.
        if (timeout !== undefined) clock.clearTimeout(timeout);
        timeout = undefined; next.onStarted?.();
        if (resolvingIdentity !== identityScope) { void resolve(context(next.reason, next.force)); return; }
      }
      const info = await Promise.race([options.resolve(controller.signal, next), deadline]);
      if (stopped || version !== requestVersion || controller.signal.aborted || resolvingMode !== mediaMode || resolvingIdentity !== identityScope) return;
      finishRequest();
      options.onOptionsState?.('ready', undefined, next);
      const availableSources = info.sources.filter(source => validSource(source) && (mediaMode !== 'audio' || source.protocol === 'flv'));
      for (const source of availableSources) sourceIdentities.set(source, resolvingIdentity);
      if (info.status === 'offline' || info.status === 'restricted') {
        commitMediaMode(mediaMode);
        currentInfo = { ...info, sources: [] };
        sources = []; sourcesQuality = undefined; attempted.clear(); unsupported.clear();
        publishInfo(currentInfo);
        releaseRecovery();
        qualityFallback = undefined;
        clearConnection();
        status(info.status, info.status === 'offline' ? '主播暂未开播' : '当前直播暂时无法播放');
        if (info.status === 'offline' && autoReconnect) schedule(context('recovery', false), 30_000, false);
        return;
      }
      if (mediaMode === 'audio' && !availableSources.length) {
        if (mediaTransition) rollbackMediaMode('当前直播间没有可用的仅音频线路，已恢复原模式');
        else {
          currentInfo = { ...info, sources: [] };
          publishInfo(currentInfo);
          clearConnection();
          status('unsupported', '当前直播间没有可用的仅音频线路，可切回视频模式');
        }
        return;
      }
      currentInfo = mediaMode === 'audio' ? { ...info, sources: availableSources } : info;
      publishInfo(currentInfo);
      sources = availableSources;
      sourcesQuality = next.qn;
      attempted = new Set(); unsupported = new Set();
      if (recovery.cooldownUntil > clock.now()) { schedule(next, 0, false); return; }
      if (!sources.length) {
        if (restoreQualityFallback() || downgradeQuality()) return;
        schedule(next, 10_000); return;
      }
      let candidate = orderedAvailable()[0];
      if (!candidate) {
        if (mediaTransition) rollbackMediaMode('所选播放模式的线路暂时不可用，已恢复原模式');
        else if (allUnsupported()) { releaseRecovery(); status('unsupported', '当前浏览器不支持这些直播格式'); }
        else if (preferredFormat !== 'auto') status(active?.hasPlayed ? active.stalled ? 'stalled' : 'playing' : 'error', '所选格式本次未提供可用线路，请切回自动格式');
        else schedule(context('recovery'), 5_000);
        return;
      }
      if (active?.mediaMode === mediaMode && next.reason !== 'manual' && (!preferredRoute || !matchesRoutePreference(candidate, preferredRoute))) {
        candidate = orderedAvailable().find(source => playbackRouteKey(source) === playbackRouteKey(active!.source)
          && source.actualQuality === candidate!.actualQuality) ?? candidate;
      }
      const sameActual = active?.mediaMode === mediaMode && active.source.actualQuality === candidate.actualQuality
        && active.source.codec === candidate.codec;
      const routeMatches = !preferredRoute || matchesRoutePreference(active?.source ?? candidate, preferredRoute)
        || !matchesRoutePreference(candidate, preferredRoute);
      const retain = active && sameActual && routeMatches && matchesFormat(active.source) && next.reason !== 'manual'
        && (next.reason !== 'expiry' || active.source.protocol === 'flv' || active.source.url === candidate.url);
      if (retain && active) {
        releaseRecovery();
        resolveQuality = active.source.actualQuality;
        qualityFallback = undefined; qualityFallbackInfo = undefined;
        const matching = sources.find(source => source.protocol === active!.source.protocol
          && source.format === active!.source.format && source.codec === active!.source.codec);
        active.source = copySource(active.source, { qualities: matching?.qualities ?? active.source.qualities });
        if (active.hasPlayed) options.onSource?.(active.source, active.identityScope);
        if (next.reason === 'expiry' || active.source.url === candidate.url) scheduleExpiry(candidate);
        return;
      }
      if (['quality', 'format'].includes(next.reason) && active?.mediaMode === mediaMode && active.hasPlayed && active.lastProgress !== undefined
        && clock.now() - active.lastProgress < 25_000 && validSource(active.source) && !qualityFallback) qualityFallback = copySource(active.source);
      await connect(candidate);
    } catch (error) {
      if (stopped || version !== requestVersion || controller.signal.aborted && !timedOut) return;
      finishRequest();
      options.onOptionsState?.('error', timedOut ? '获取所选清晰度超时' : '暂时无法获取所选清晰度', next);
      const detail = (timedOut ? {} : error) as { status?: number; retryAfter?: number; name?: string };
      if (detail.name === 'AbortError' || [401, 403, 404, 409].includes(detail.status ?? 0)) {
        clearMediaTransition();
        releaseRecovery();
        qualityFallback = undefined;
        sources = []; sourcesQuality = undefined; attempted.clear(); unsupported.clear();
        if (currentInfo) {
          currentInfo = { ...currentInfo, status: 'restricted', requestedQuality, sources: [], qualities: [], capabilities: [], resolvedAt: clock.now(),
            message: '房间访问权限已变化，请刷新房间列表' };
          publishInfo(currentInfo);
        }
        clearConnection(); status('restricted', '房间访问权限已变化，请刷新房间列表'); return;
      }
      if (detail.status === 412 || detail.status === 429) cooldown(detail.retryAfter);
      if (mediaTransition?.target === resolvingMode) {
        rollbackMediaMode(timedOut ? '获取播放模式信息超时，已恢复原模式' : '暂时无法获取所选播放模式，已恢复原模式');
        return;
      }
      if (detail.status !== 412 && detail.status !== 429 && ['quality', 'manual'].includes(next.reason) && restoreQualityFallback()) return;
      schedule(next);
    } finally {
      finishRequest();
    }
  }
  function reconnectPlayback(reason: 'manual' | 'media-mode' = 'manual') {
    if (stopped) return;
    pendingAudioCapability = undefined;
    // Explicit refresh and a verified new bridge each allow one new attempt.
    // A bridge is an optional upgrade: ordinary fallback may retain healthy media.
    if (mediaMode === 'audio') audioFallbackDisabled = false;
    resetInterruptions();
    releaseRecovery();
    qualityFallback = active?.hasPlayed && !active.stalled && active.lastProgress !== undefined
      && clock.now() - active.lastProgress < 25_000 ? copySource(active.source) : undefined;
    qualityFallbackInfo = qualityFallback ? currentInfo : undefined;
    resolveQuality = requestedQuality; failedQualities.clear();
    void resolve(context(reason, true));
  }
  const session: PlaybackSession = {
    resumePlayback: resumeBlockedPlayback,
    audioCapabilityAvailable(key) {
      if (stopped || !key || key === audioCapabilityKey) return;
      audioCapabilityKey = key;
      if (mediaMode !== 'audio' || active?.source.mediaKind === 'audio-only') return;
      pendingAudioCapability = key;
      maybeUpgradeAudio();
    },
    setIdentityScope(scope) {
      if (stopped || scope === identityScope) return;
      // Pure audio is a public extension capability. Account checks must not cancel
      // its initialization or reload it when login, logout or account change occurs.
      if (usingPureAudio()) {
        identityScope = scope;
        const allowed = (source: PlaybackSource) => sourceIdentity(source) === 'anonymous' || sourceIdentity(source) === scope;
        // The public audio request survives, but a previous personal video must
        // stop immediately and cannot be resurrected by a failed mode switch.
        if (active && !allowed(active.source)) { clearConnection(); options.onSourceCleared?.(); }
        sources = sources.filter(allowed);
        if (currentInfo?.sources.some(source => !allowed(source))) currentInfo = undefined;
        if (mediaTransition) {
          if (mediaTransition.fallback && !allowed(mediaTransition.fallback)) mediaTransition.fallback = undefined;
          mediaTransition.sources = mediaTransition.sources.filter(allowed);
          if (mediaTransition.info?.sources.some(source => !allowed(source))) mediaTransition.info = undefined;
        }
        return;
      }
      identityScope = scope;
      resolveQuality = requestedQuality; failedQualities.clear();
      requestVersion++; request?.cancel(); request = undefined;
      releaseRecovery(); clearRetry(); clearMediaTransition(); qualityFallback = undefined; qualityFallbackInfo = undefined;
      sources = []; sourcesQuality = undefined; currentInfo = undefined; attempted.clear(); unsupported.clear();
      recovery.failures = 0; recovery.routes.clear(); recovery.healthyRoute = undefined; recovery.audioHealthyRoute = undefined;
      // A verified account becoming available does not invalidate a healthy public CDN connection.
      // Personal signed media must stop immediately on logout, account change or revocation.
      const preserveAnonymous = active?.identityScope === 'anonymous' && active.hasPlayed && !active.stalled
        && (active.autoplayBlocked || active.lastProgress !== undefined && clock.now() - active.lastProgress < 25_000);
      if (preserveAnonymous && active) {
        // Keep the existing renewal plan, which may refer to a newer prefetched signature.
        options.onSource?.(active.source, active.identityScope);
        status(active.autoplayBlocked ? 'autoplay-blocked' : 'playing', active.autoplayBlocked ? '浏览器阻止了自动播放，点击恢复播放' : undefined);
        return;
      }
      clearConnection(); options.onAutoplayBlockedChange?.(null); options.onSourceCleared?.();
      void resolve(context('initial', false));
    },
    checkHealth(resumed = false) {
      if (resumed || !foreground()) resetInterruptions();
      active?.connection?.checkHealth?.(resumed);
    },
    destroy() {
      if (stopped) return;
      stopped = true; requestVersion++;
      pendingAudioCapability = undefined;
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', resetInterruptions);
      clearMediaTransition();
      releaseRecovery();
      request?.cancel(); request = undefined;
      clearRetry(); clearConnection(); sources = []; attempted.clear(); unsupported.clear(); qualityFallback = undefined; qualityFallbackInfo = undefined;
      currentAudioLease = undefined;
      for (const lease of [...audioLeases]) releaseAudioLease(lease);
    },
    updateQuality(qn) {
      if (stopped || qn === requestedQuality) return;
      if (usingPureAudio()) { requestedQuality = qn; resolveQuality = qn; failedQualities.clear(); return; }
      releaseRecovery();
      qualityFallback = active?.hasPlayed && !active.stalled && active.lastProgress !== undefined
        && clock.now() - active.lastProgress < 25_000 ? copySource(active.source) : undefined;
      qualityFallbackInfo = qualityFallback ? currentInfo : undefined;
      requestedQuality = qn;
      resolveQuality = qn; failedQualities.clear();
      void resolve(context('quality', false));
    },
    setMediaMode(mode) {
      if (stopped || mode === mediaMode) return;
      pendingAudioCapability = undefined;
      resetInterruptions();
      resolveQuality = requestedQuality; failedQualities.clear();
      const previousTransition = mediaTransition;
      const previousMode = active?.hasPlayed ? active.mediaMode : committedMediaMode;
      const fallback = active?.hasPlayed && active.mediaMode === previousMode ? active.source : previousTransition?.fallback;
      const previousSources = active?.mediaMode === previousMode ? sources : previousTransition?.sources ?? sources;
      const previousInfo = active?.mediaMode === previousMode ? currentInfo : previousTransition?.info ?? currentInfo;
      const previousSourcesQuality = active?.mediaMode === previousMode ? sourcesQuality : previousTransition?.sourcesQuality ?? sourcesQuality;
      if (mode === 'audio' && fallback?.mediaKind === 'audio-only') currentAudioLease = sourceAudioLeases.get(fallback);
      clearMediaTransition();
      requestVersion++;
      request?.cancel();
      releaseRecovery();
      clearRetry(); clearExpiry();
      qualityFallback = undefined;
      mediaMode = mode;
      if (mode === 'audio') audioFallbackDisabled = false;
      else useAudioLease();
      publishAudioDelivery(null);
      attempted = new Set(); unsupported = new Set();
      if (active?.mediaMode === mode) {
        if (mode === 'audio') {
          useAudioLease(active.audioLease);
          if (active.hasPlayed) publishAudioDelivery(active.source.mediaKind === 'audio-only' ? active.audioVerified ? 'audio-only' : null : 'full-stream');
        }
        committedMediaMode = mode;
        status(active.stalled ? 'stalled' : active.hasPlayed ? 'playing' : 'loading');
        scheduleExpiry(active.source);
        return;
      }
      if (previousMode !== mode) mediaTransition = { target: mode, previous: previousMode, fallback,
        sources: previousSources, info: previousInfo, sourcesQuality: previousSourcesQuality };
      if (active && !active.hasPlayed) clearConnection();
      if (!mediaTransition && fallback && validSource(fallback) && recovery.cooldownUntil <= clock.now()) {
        sources = previousSources;
        currentInfo = previousInfo;
        if (currentInfo) publishInfo(currentInfo);
        void connect(fallback);
      } else void resolve(context('media-mode', false));
    },
    reconnect: reconnectPlayback,
    selectRoute(key, info) {
      if (stopped || preferredRoute === key && !info) return;
      if (usingPureAudio()) { preferredRoute = key; return; }
      releaseRecovery();
      preferredRoute = key;
      // An explicit route selection may carry a fresh snapshot for the actual
      // playing QN, even when the saved quality preference was downgraded.
      // Only this user action adopts it; background menu updates never touch media.
      const routeQuality = active?.source.actualQuality ?? info?.requestedQuality;
      const fresh = info?.status === 'live' ? info.sources.filter(source => source.actualQuality === routeQuality
        && validSource(source) && (mediaMode !== 'audio' || source.protocol === 'flv')) : undefined;
      if (fresh?.length) {
        for (const source of fresh) sourceIdentities.set(source, identityScope);
        requestVersion++;
        request?.cancel();
        clearRetry();
        sources = fresh;
        sourcesQuality = info!.requestedQuality;
        currentInfo = info;
        publishInfo(info!);
      }
      const selected = key && !key.startsWith('cdn:') ? sources.find(source => playbackRouteKey(source) === key) : undefined;
      if (selected && mediaMode !== 'audio') preferredFormat = playbackFormatKey(selected);
      qualityFallback = undefined;
      if (!key) return;
      attempted = new Set();
      const candidate = orderedAvailable()[0];
      if (active && matchesRoutePreference(active.source, key) && matchesFormat(active.source)
        && (!candidate || active.source.actualQuality === requestedQuality || candidate.actualQuality === active.source.actualQuality)) return;
      if (candidate && (fresh?.length || sourcesQuality === requestedQuality) && recovery.cooldownUntil <= clock.now()) void connect(candidate);
      else void resolve(context('manual'));
    },
    selectFormat(format, route) {
      if (stopped) return;
      if (usingPureAudio()) {
        preferredFormat = format;
        if (route !== undefined) preferredRoute = route;
        else if (format === 'auto') preferredRoute = null;
        return;
      }
      if (preferredFormat === format) { if (route !== undefined) session.selectRoute(route); return; }
      releaseRecovery();
      preferredFormat = format;
      if (route !== undefined) preferredRoute = route;
      else if (format === 'auto' || preferredRoute && !sources.some(source => matchesFormat(source) && matchesRoutePreference(source, preferredRoute))) preferredRoute = null;
      qualityFallback = undefined;
      if (sourcesQuality !== requestedQuality) { void resolve(context('format', false)); return; }
      requestVersion++;
      request?.cancel();
      clearRetry();
      attempted = new Set();
      const candidate = orderedAvailable()[0];
      const routeMatches = !route || !candidate || active && matchesRoutePreference(active.source, route)
        || !matchesRoutePreference(candidate, route);
      if (active && matchesFormat(active.source) && routeMatches && (!candidate || candidate.actualQuality === active.source.actualQuality
        || active.source.actualQuality === requestedQuality)) return;
      if (candidate && recovery.cooldownUntil <= clock.now()) {
        if (active?.hasPlayed && active.lastProgress !== undefined && clock.now() - active.lastProgress < 25_000 && validSource(active.source)) qualityFallback = copySource(active.source);
        void connect(candidate);
      } else void resolve(context('format', false));
    },
    setAutoReconnect(enabled) {
      if (stopped || enabled === autoReconnect) return;
      autoReconnect = enabled;
      if (!enabled) {
        releaseRecovery();
        if (request?.automatic) {
          requestVersion++;
          request.cancel();
          if (!active) status('error', '自动重连已关闭，可手动重新连接');
        }
      }
      if (!enabled && !(retryContext?.reason === 'expiry' && active?.hasPlayed)) clearRetry();
      if (enabled) {
        active?.connection?.checkHealth?.();
        if (!active && !request && !recoveryWork && !retryContext) recoverResolve(context('recovery'));
      }
    },
    networkRestored() {
      if (!stopped && autoReconnect && retryContext && retryAt <= clock.now() && recovery.cooldownUntil <= clock.now()) {
        const pending = retryContext; clearRetry(); recoverResolve(pending);
      }
    },
  };
  void resolve(context(options.initialReason ?? 'initial'));
  return session;
}
