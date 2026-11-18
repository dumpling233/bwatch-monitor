import type { PlaybackInfo } from '../../shared/playback';
import type { LocalPlaybackResolver, PlaybackResolveRequest } from './localLoginProvider';

const cancelled = () => new DOMException('Playback request cancelled', 'AbortError');
interface Work {
  key: string;
  request: PlaybackResolveRequest;
  controller: AbortController;
  consumers: Set<{ resolve(value: PlaybackInfo): void; reject(error: unknown): void; cleanup(): void; started?(): void }>;
  started: boolean;
  priority: 'media' | 'metadata';
}

/** Keep one budget for the page, including across identity/permission pool replacements. */
export class PlaybackRequestBudget {
  private blockedUntil = 0;
  private blockedStatus?: number;
  private metadataRequests: number[] = [];

  error(): (Error & { status?: number; retryAfter: number }) | undefined {
    if (this.blockedUntil <= Date.now()) return;
    return Object.assign(new Error('Playback requests are temporarily limited'), {
      status: this.blockedStatus, retryAfter: Math.max(1, Math.ceil((this.blockedUntil - Date.now()) / 1_000)),
    });
  }

  block(retryAfter: number, status = 429): void { this.remember({ status, retryAfter }); }

  /** Local menu work has a rolling budget; media startup and user quality switches do not spend it. */
  admitMetadata(): Error | undefined {
    const now = Date.now();
    this.metadataRequests = this.metadataRequests.filter(at => at > now - 60_000 && at <= now);
    if (this.metadataRequests.length >= 30) return Object.assign(new Error('播放选项稍后自动更新'), {
      metadataBudget: true, retryAfter: Math.max(1, Math.ceil((this.metadataRequests[0] + 60_000 - now) / 1_000)),
    });
    this.metadataRequests.push(now);
  }

  remember(error: unknown): void {
    const detail = error as { status?: number; httpStatus?: number; retryAfter?: number; metadataBudget?: boolean } | null;
    if (!detail || typeof detail !== 'object') return;
    if (detail.metadataBudget) return;
    const status = detail.status ?? detail.httpStatus;
    const after = Number.isFinite(detail.retryAfter) && detail.retryAfter! > 0 ? Math.min(86_400, detail.retryAfter!) : 0;
    if (!after && status !== 412 && status !== 429) return;
    this.blockedUntil = Math.max(this.blockedUntil, Date.now() + (after || 30) * 1_000);
    this.blockedStatus = status;
  }
}

/** Survives permission-driven Panel remounts for this document, without storing account data. */
export const pagePlaybackRequestBudget = new PlaybackRequestBudget();

/** A page/identity scope owns this pool. Signed results are never cached here. */
export class PlaybackRequestPool {
  private work = new Map<string, Work>();
  private queue: Work[] = [];
  private active = 0;
  private activeMetadata = 0;
  private disposed = false;
  constructor(private readonly resolver: LocalPlaybackResolver, private readonly concurrency = 2,
    private readonly budget = new PlaybackRequestBudget()) {}

  resolve = (request: PlaybackResolveRequest, rpcScope = '', priority: 'media' | 'metadata' = 'media'): Promise<PlaybackInfo> => {
    if (this.disposed || request.signal.aborted) return Promise.reject(cancelled());
    const cooldown = this.budget.error();
    if (cooldown) return Promise.reject(cooldown);
    const key = `${rpcScope}:${request.source}:${request.roomId}:${request.qn}`;
    let work = this.work.get(key);
    if (!work) {
      work = { key, request, controller: new AbortController(), consumers: new Set(), started: false, priority };
      this.work.set(key, work); this.queue.push(work);
    } else if (!work.started) {
      if (request.force) work.request = { ...work.request, force: true };
      if (priority === 'media') work.priority = 'media';
    }
    const item = work;
    request.onQueued?.();
    return new Promise((resolve, reject) => {
      const abort = () => {
        consumer.cleanup(); item.consumers.delete(consumer); reject(cancelled());
        if (!item.consumers.size) {
          item.controller.abort();
          if (this.work.get(key) === item) this.work.delete(key);
          this.queue = this.queue.filter(queued => queued !== item);
        }
      };
      const consumer = { resolve, reject, cleanup: () => request.signal.removeEventListener('abort', abort), started: request.onStarted };
      item.consumers.add(consumer);
      request.signal.addEventListener('abort', abort, { once: true });
      if (item.started) consumer.started?.();
      this.drain();
    });
  };

  private drain() {
    while (!this.disposed && this.active < this.concurrency && this.queue.length) {
      const index = this.queue.findIndex(item => item.priority === 'media');
      if (index < 0 && this.activeMetadata >= 1) break;
      const item = this.queue.splice(index < 0 ? 0 : index, 1)[0];
      if (!item.consumers.size || item.controller.signal.aborted) continue;
      this.active++; item.started = true;
      for (const consumer of item.consumers) consumer.started?.();
      const metadata = item.priority === 'metadata';
      if (metadata) this.activeMetadata++;
      const finish = (value?: PlaybackInfo, error?: unknown) => {
        if (this.work.get(item.key) === item) this.work.delete(item.key);
        for (const consumer of item.consumers) {
          consumer.cleanup();
          if (item.controller.signal.aborted || this.disposed) consumer.reject(cancelled());
          else if (error !== undefined) consumer.reject(error);
          else consumer.resolve(value!);
        }
        item.consumers.clear();
      };
      // Cancellation releases the queue even if an adapter ignores AbortSignal.
      const execution = new Promise<PlaybackInfo>((resolve, reject) => {
        const abort = () => reject(cancelled());
        item.controller.signal.addEventListener('abort', abort, { once: true });
        if (item.controller.signal.aborted) { reject(cancelled()); return; }
        void Promise.resolve().then(() => {
          const cooldown = this.budget.error();
          if (cooldown) throw cooldown;
          const metadataLimit = metadata ? this.budget.admitMetadata() : undefined;
          if (metadataLimit) throw metadataLimit;
          return this.resolver({ ...item.request, signal: item.controller.signal });
        })
          .then(resolve, reject).finally(() => item.controller.signal.removeEventListener('abort', abort));
      });
      void execution
        .then(value => finish(value), error => { this.budget.remember(error); finish(undefined, error); })
        .finally(() => { this.active--; if (metadata) this.activeMetadata--; this.drain(); });
    }
  }

  /** Media CDN rate limits share the same page budget as metadata/API requests. */
  block(retryAfter: number, status = 429): void {
    this.budget.block(retryAfter, status);
  }

  dispose() {
    this.disposed = true;
    for (const item of this.work.values()) {
      item.controller.abort();
      for (const consumer of item.consumers) { consumer.cleanup(); consumer.reject(cancelled()); }
      item.consumers.clear();
    }
    this.work.clear(); this.queue = [];
  }
}
