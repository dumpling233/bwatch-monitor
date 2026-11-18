import { isPlaybackQuality, type PlaybackInfo } from '../../shared/playback';

export interface PlaybackMetadataContext {
  /** Includes the account, room binding, permission and compatibility scope. */
  identityScope: string;
  /** A worker restart changes this without changing the verified account. */
  rpcScope: string;
  quality: number;
  needed: boolean;
  visible: boolean;
  online: boolean;
  menuOpen: boolean;
}

export interface PlaybackMetadataSnapshot {
  info?: PlaybackInfo;
  state: 'idle' | 'loading' | 'ready' | 'error' | 'cooldown';
  stale: boolean;
  message?: string;
  retryAt?: number;
  /** Explicit authentication/access failures forbid falling back to an old media/menu snapshot. */
  invalidated?: boolean;
}

export interface PlaybackMetadataClock {
  now(): number;
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface PlaybackMetadataOptions {
  roomId: string;
  resolve(qn: number, signal: AbortSignal, lifecycle: { onQueued(): void; onStarted(): void }): Promise<PlaybackInfo>;
  onChange?(snapshot: PlaybackMetadataSnapshot): void;
  clock?: PlaybackMetadataClock;
}

interface CachedRoutes { info: PlaybackInfo; rpcScope: string; validUntil: number }
interface ActiveRequest { id: number; quality: number; abort: AbortController; promise: Promise<PlaybackInfo> }
const cancelled = () => new DOMException('Playback metadata request cancelled', 'AbortError');
const DEFAULT_TTL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_ROUTE_SNAPSHOTS = 8;

/** Metadata has its own lifetime and never owns or mutates a media session. */
export class PlaybackMetadataController {
  private readonly clock: PlaybackMetadataClock;
  private context?: PlaybackMetadataContext;
  private info?: PlaybackInfo;
  private routes = new Map<number, CachedRoutes>();
  private infoScope = '';
  private inheritedDescription = false;
  private infoValidUntil = 0;
  private state: PlaybackMetadataSnapshot['state'] = 'idle';
  private message?: string;
  private retryAt = 0;
  private failures = 0;
  private requestId = 0;
  private active?: ActiveRequest;
  private timer?: unknown;
  private disposed = false;
  private invalidated = false;
  private invalidatedAt = 0;

  constructor(private readonly options: PlaybackMetadataOptions) {
    this.clock = options.clock ?? { now: Date.now,
      setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
      clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>) };
  }

  getSnapshot(): PlaybackMetadataSnapshot {
    return { info: this.info, state: this.state,
      stale: !this.info || this.infoScope !== this.context?.rpcScope || this.infoValidUntil <= this.clock.now(),
      message: this.message, retryAt: this.retryAt || undefined, invalidated: this.invalidated };
  }

  setContext(next: PlaybackMetadataContext): void {
    if (this.disposed) return;
    const previous = this.context;
    this.context = { ...next };
    if (previous && previous.identityScope !== next.identityScope) {
      this.cancel(); this.routes.clear(); this.info = undefined; this.infoScope = ''; this.infoValidUntil = 0;
      this.inheritedDescription = false;
      this.invalidated = false; this.invalidatedAt = 0;
      this.failures = 0; this.retryAt = 0; this.state = 'idle'; this.message = undefined; this.emit();
    } else if (previous && previous.rpcScope !== next.rpcScope) {
      this.cancel(); this.routes.clear(); this.infoValidUntil = 0;
      // A transport renewal does not revoke the same account's descriptive snapshot.
      this.state = this.info ? 'ready' : 'idle'; this.message = undefined; this.emit();
    } else if (previous && previous.quality !== next.quality) {
      this.cancel();
    }
    if (!this.canRequest()) { this.cancel(); this.clearTimer(); return; }
    this.wake();
  }

  /** Only missing demanded descriptions recover automatically; TTL is not a polling interval. */
  wake(): void {
    if (!this.canRequest()) return;
    if (this.active) return;
    if (this.retryAt > this.clock.now()) { this.schedule(); return; }
    // A stale directory is still useful UI data. Fetch fresh signed addresses only
    // after an explicit route choice; playback itself resolves explicit qualities.
    if (!this.info || this.inheritedDescription && this.context!.menuOpen) {
      void this.ensureMetadata().catch(() => {});
    } else this.schedule();
  }

  /** Adopt ordinary playback results; late results from an old RPC scope are ignored. */
  observe(info: PlaybackInfo, rpcScope = this.context?.rpcScope): void {
    if (this.disposed || !this.context || rpcScope !== this.context.rpcScope || info.roomId !== this.options.roomId) return;
    if (this.invalidated && info.resolvedAt <= this.invalidatedAt) return;
    this.remember(info, rpcScope);
    if (!this.active) {
      if (this.state !== 'cooldown') { this.retryAt = 0; this.failures = 0; }
      this.state = this.retryAt > this.clock.now() ? 'cooldown' : 'ready'; this.message = undefined;
    }
    this.emit(); this.schedule();
  }

  /**
   * Healthy anonymous media may survive authorization. Its directory can describe
   * the menu, but its signed addresses must never become current-account routes.
   */
  observeDescription(info: PlaybackInfo): void {
    if (this.disposed || !this.context || info.roomId !== this.options.roomId || this.invalidated
      || this.info && this.infoScope === this.context.rpcScope) return;
    this.info = info;
    this.inheritedDescription = true;
    this.infoScope = ''; this.infoValidUntil = 0;
    if (!this.active) this.state = this.retryAt > this.clock.now() ? this.state : 'ready';
    this.emit();
  }

  ensureMetadata(quality = this.context?.quality ?? 250): Promise<PlaybackInfo> {
    return this.ensure(quality, false);
  }

  /** Returned addresses always belong to the requested actual QN and current RPC scope. */
  ensureRoutes(quality: number): Promise<PlaybackInfo> {
    return this.ensure(quality, true);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.cancel(); this.clearTimer(); this.routes.clear(); this.info = undefined;
  }

  private canRequest(): boolean {
    return !this.disposed && Boolean(this.context?.needed && this.context.visible && this.context.online);
  }

  private ensure(quality: number, routesRequired: boolean): Promise<PlaybackInfo> {
    if (!this.canRequest() || !isPlaybackQuality(quality)) return Promise.reject(cancelled());
    const cached = this.validRoutes(quality);
    if (cached && (!this.getSnapshot().stale || routesRequired)) return Promise.resolve(cached);
    if (!routesRequired && this.info && !this.getSnapshot().stale && this.info.requestedQuality === quality)
      return Promise.resolve(this.info);
    if (this.active?.quality === quality) return routesRequired
      ? this.active.promise.then(info => this.requireRoutes(info, quality)) : this.active.promise;
    if (this.retryAt > this.clock.now()) {
      this.schedule();
      return Promise.reject(Object.assign(new Error(this.message ?? '播放选项暂不可用，请稍后再试'), {
        retryAfter: Math.ceil((this.retryAt - this.clock.now()) / 1_000) }));
    }
    this.cancel(); this.clearTimer();
    const id = ++this.requestId, rpcScope = this.context!.rpcScope;
    const abort = new AbortController();
    this.state = 'loading'; this.message = undefined;
    // Start on a microtask so active always exists before adapters can settle synchronously.
    const promise = Promise.resolve().then(() => this.resolveWithDeadline(quality, abort.signal)).then(info => {
      if (this.disposed || id !== this.requestId || rpcScope !== this.context?.rpcScope) throw cancelled();
      if (info.roomId !== this.options.roomId || info.requestedQuality !== quality)
        throw new Error('播放选项响应与当前房间不匹配');
      if (!Number.isFinite(info.resolvedAt) || Math.min(this.clock.now(), info.resolvedAt) + DEFAULT_TTL_MS <= this.clock.now())
        throw new Error('播放选项已过期，正在重新获取');
      this.remember(info, rpcScope);
      this.state = 'ready'; this.message = undefined; this.failures = 0; this.retryAt = 0;
      return info;
    }).catch(error => {
      if (this.disposed || id !== this.requestId) throw error;
      if ((error as Error)?.name === 'AbortError') {
        this.state = this.info ? 'ready' : 'idle'; this.message = undefined;
      } else {
        const detail = error as { status?: number; httpStatus?: number; retryAfter?: number };
        const status = detail?.status ?? detail?.httpStatus ?? 0;
        const limited = [412, 429].includes(status);
        const accessChanged = [401, 403, 404, 409].includes(status);
        if (accessChanged) {
          this.routes.clear(); this.info = undefined; this.infoScope = ''; this.infoValidUntil = 0;
          this.inheritedDescription = false;
          this.invalidated = true; this.invalidatedAt = this.clock.now();
        }
        const after = Number.isFinite(detail?.retryAfter) && detail.retryAfter! > 0 ? Math.min(86_400, detail.retryAfter!) * 1_000 : 0;
        const backoff = Math.min(60_000, 2_000 * 2 ** Math.min(this.failures++, 5));
        this.retryAt = this.clock.now() + Math.max(after, limited ? 30_000 : backoff);
        this.state = limited || after > 0 ? 'cooldown' : 'error';
        this.message = accessChanged ? '播放权限已变化'
          : this.state === 'cooldown' ? '播放选项暂不可用，请稍后再试' : '暂时无法获取播放选项';
      }
      throw error;
    }).finally(() => {
      if (this.disposed || id !== this.requestId) return;
      this.active = undefined; this.emit(); this.schedule();
    });
    this.active = { id, quality, abort, promise }; this.emit();
    return routesRequired ? promise.then(info => this.requireRoutes(info, quality)) : promise;
  }

  private requireRoutes(info: PlaybackInfo, quality: number): PlaybackInfo {
    if (info.status === 'live' && this.usableRoutes(info, quality).length) return info;
    // A valid response may be a downgrade/offline result. Do not hot-loop on an absent route.
    this.retryAt = Math.max(this.retryAt, this.clock.now() + DEFAULT_TTL_MS);
    this.message = '当前清晰度的线路暂时不可用';
    this.emit(); this.schedule();
    throw new Error(this.message);
  }

  private remember(info: PlaybackInfo, rpcScope: string): void {
    const now = this.clock.now();
    const resolved = Number.isFinite(info.resolvedAt) ? Math.min(now, info.resolvedAt) : now;
    this.invalidated = false;
    this.inheritedDescription = false;
    if (this.infoScope !== rpcScope || !this.info || info.resolvedAt >= this.info.resolvedAt) {
      this.info = info; this.infoScope = rpcScope; this.infoValidUntil = resolved + DEFAULT_TTL_MS;
    }
    const actualQualities = new Set(info.status === 'live' ? info.sources.map(source => source.actualQuality) : []);
    if (info.status !== 'live' && this.info === info) this.routes.clear();
    const requestedRoutes = this.routes.get(info.requestedQuality);
    if (!actualQualities.has(info.requestedQuality) && requestedRoutes && requestedRoutes.info.resolvedAt <= info.resolvedAt)
      this.routes.delete(info.requestedQuality);
    for (const qn of actualQualities) {
      const sources = this.usableRoutes(info, qn);
      if (!sources.length) continue;
      const validUntil = Math.min(resolved + DEFAULT_TTL_MS, ...sources.map(source => (source.expiresAt ?? Infinity) - 1_000));
      const previous = this.routes.get(qn);
      if (previous && previous.rpcScope === rpcScope && previous.info.resolvedAt > info.resolvedAt) continue;
      this.routes.delete(qn); this.routes.set(qn, { info: { ...info, sources }, rpcScope, validUntil });
    }
    while (this.routes.size > MAX_ROUTE_SNAPSHOTS) this.routes.delete(this.routes.keys().next().value!);
  }

  private usableRoutes(info: PlaybackInfo, quality: number) {
    return info.sources.filter(source => source.actualQuality === quality
      && (source.expiresAt === undefined || source.expiresAt > this.clock.now() + 1_000));
  }

  private validRoutes(quality: number): PlaybackInfo | undefined {
    const cached = this.routes.get(quality);
    return cached && cached.info.status === 'live' && cached.rpcScope === this.context?.rpcScope && cached.validUntil > this.clock.now()
      && this.usableRoutes(cached.info, quality).length ? cached.info : undefined;
  }

  private schedule(): void {
    this.clearTimer();
    if (!this.canRequest() || this.active) return;
    // A still-open empty/error menu may recover without a manual refresh button.
    // Existing descriptions and failed route choices never create polling work.
    const next = this.context!.menuOpen && (!this.info || this.inheritedDescription) && this.retryAt > this.clock.now() ? this.retryAt : 0;
    if (!next) return;
    this.timer = this.clock.setTimeout(() => { this.timer = undefined; this.wake(); }, Math.max(1, next - this.clock.now()));
  }

  private cancel(): void {
    if (!this.active) return;
    const previous = this.active; this.active = undefined; this.requestId++; previous.abort.abort();
    this.state = this.info ? 'ready' : 'idle'; this.message = undefined; this.emit();
  }

  private clearTimer(): void {
    if (this.timer !== undefined) { this.clock.clearTimeout(this.timer); this.timer = undefined; }
  }

  private emit(): void { if (!this.disposed) this.options.onChange?.(this.getSnapshot()); }

  private resolveWithDeadline(quality: number, signal: AbortSignal): Promise<PlaybackInfo> {
    return new Promise((resolve, reject) => {
      const request = new AbortController(); let settled = false;
      let deadline: unknown;
      const startDeadline = () => {
        if (settled || request.signal.aborted || deadline !== undefined) return;
        deadline = this.clock.setTimeout(() => {
          deadline = undefined;
          request.abort(); finish(undefined, new DOMException('Playback metadata request timed out', 'TimeoutError'));
        }, REQUEST_TIMEOUT_MS);
      };
      const finish = (info?: PlaybackInfo, error?: unknown) => {
        if (settled) return; settled = true;
        if (deadline !== undefined) this.clock.clearTimeout(deadline);
        deadline = undefined; signal.removeEventListener('abort', cancel);
        if (error !== undefined) reject(error); else resolve(info!);
      };
      const cancel = () => { request.abort(); finish(undefined, cancelled()); };
      // Direct resolvers still have a deadline; a pooled resolver suspends it
      // while queued and starts it only after acquiring an execution slot.
      startDeadline();
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) { cancel(); return; }
      void Promise.resolve().then(() => { if (!settled) return this.options.resolve(quality, request.signal, {
        onQueued: () => { if (deadline !== undefined) this.clock.clearTimeout(deadline); deadline = undefined; },
        onStarted: startDeadline,
      }); })
        .then(info => { if (!settled) finish(info); }, error => finish(undefined, error));
    });
  }
}
