import type { LocalPublicProfile } from '../../shared/localDanmaku';
import { LocalLoginClientError } from './localLoginClient';

export const LOCAL_PROFILE_LIMITS = Object.freeze({ concurrent: 2, perMinute: 20, waiting: 128, cached: 2048, bytes: 2 * 1024 * 1024 });
export const LOCAL_PROFILE_FRESH_MS = 86_400_000;
export const LOCAL_PROFILE_IDLE_MS = 86_400_000;
export const LOCAL_PROFILE_NEGATIVE_MS = 600_000;
export const LOCAL_PROFILE_RETRY_MS = [3_000, 15_000, 60_000, 300_000] as const;
type Consumer = { resolve(value: LocalPublicProfile | null): void; signal?: AbortSignal; cancel(): void };
type Task = { uid: string; consumers: Set<Consumer>; controller: AbortController; running: boolean; failures: number; after: number };
type Cached = { value: LocalPublicProfile | null; until: number; usedAt: number; bytes: number; rejectedUntil?: number };

/** Only live, visible consumers keep work queued. Temporary failure is not missing data. */
export class LocalProfileQueue {
  private readonly cache = new Map<string, Cached>();
  private cacheBytes = 0;
  private nextExpiry = Infinity;
  private readonly tasks = new Map<string, Task>();
  private admissions: number[] = [];
  private active = 0;
  private cooldownUntil = 0;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private readonly fetchProfile: (uid: string, signal: AbortSignal) => Promise<LocalPublicProfile | null>, private readonly now = () => Date.now()) {}

  invalidate(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.cache.clear();
    this.cacheBytes = 0; this.nextExpiry = Infinity;
    for (const task of [...this.tasks.values()]) { this.complete(task, null); task.controller.abort(); }
    // A scope change must not reset the page's upstream request budget/cooldown.
  }

  remember(uid: string, face: string): void {
    this.prune();
    const cached = this.cache.get(uid);
    // Repeated messages/image mounts are uses, not another upstream validation.
    const value = cached?.value?.face === face ? cached.value : { uid, face };
    if (cached?.value?.face === face) { cached.rejectedUntil = undefined; this.touch(uid, cached); }
    else this.write(uid, value);
    const pending = this.tasks.get(uid);
    if (pending) { this.complete(pending, value); pending.controller.abort(); this.pump(); }
  }
  forget(uid: string, face: string): void {
    const cached = this.cache.get(uid);
    // A CDN failure does not prove the public profile is wrong. Keep its URL for
    // the image loader's bounded retry, rather than deleting/refetching in a loop.
    if (cached?.value?.face === face && !cached.rejectedUntil) cached.rejectedUntil = this.now() + LOCAL_PROFILE_NEGATIVE_MS;
  }

  snapshot(): { cached: number; bytes: number } { this.prune(); return { cached: this.cache.size, bytes: this.cacheBytes }; }

  request(uid: string, signal?: AbortSignal): Promise<LocalPublicProfile | null> {
    if (signal?.aborted) return Promise.resolve(null);
    this.prune();
    const cached = this.cache.get(uid);
    if (cached && cached.until > this.now() && cached.value && (!cached.rejectedUntil || cached.rejectedUntil > this.now())) {
      this.touch(uid, cached);
      return Promise.resolve(cached.value);
    }
    if (cached?.value) this.remove(uid);
    let task = this.tasks.get(uid);
    if (!task) {
      if (this.tasks.size >= LOCAL_PROFILE_LIMITS.waiting) return Promise.resolve(null);
      task = { uid, consumers: new Set(), controller: new AbortController(), running: false, failures: 0, after: cached?.value === null ? cached.until : 0 };
      this.tasks.set(uid, task);
    }
    const shared = task;
    return new Promise(resolve => {
      const consumer: Consumer = { resolve, signal, cancel: () => {
        shared.consumers.delete(consumer); signal?.removeEventListener('abort', consumer.cancel); resolve(null);
        if (!shared.consumers.size && this.tasks.get(uid) === shared) {
          this.tasks.delete(uid); shared.controller.abort(); this.pump();
        }
      } };
      shared.consumers.add(consumer);
      signal?.addEventListener('abort', consumer.cancel, { once: true });
      this.pump();
    });
  }

  private write(uid: string, value: LocalPublicProfile | null): void {
    this.prune();
    this.remove(uid);
    // Store only avatar data, never message names or room-specific identities.
    const projected = value ? { uid, face: value.face, ...(value.avatarFetchedAt !== undefined ? { avatarFetchedAt: value.avatarFetchedAt } : {}) } : null;
    const fetchedAt = projected?.avatarFetchedAt ?? this.now();
    const until = value ? Math.min(this.now(), fetchedAt) + LOCAL_PROFILE_FRESH_MS : this.now() + LOCAL_PROFILE_NEGATIVE_MS;
    const usedAt = this.now();
    const bytes = JSON.stringify({ uid, value: projected, until, usedAt }).length * 2 + 32;
    if (until <= this.now() || bytes > LOCAL_PROFILE_LIMITS.bytes) return;
    this.cache.set(uid, { value: projected, until, usedAt, bytes }); this.cacheBytes += bytes;
    this.nextExpiry = Math.min(this.nextExpiry, until, usedAt + LOCAL_PROFILE_IDLE_MS);
    while (this.cache.size > LOCAL_PROFILE_LIMITS.cached || this.cacheBytes > LOCAL_PROFILE_LIMITS.bytes) this.remove(this.cache.keys().next().value!);
  }
  private remove(uid: string): void {
    const cached = this.cache.get(uid); if (!cached) return;
    this.cacheBytes -= cached.bytes; this.cache.delete(uid);
  }
  private touch(uid: string, cached: Cached): void {
    cached.usedAt = this.now(); this.cache.delete(uid); this.cache.set(uid, cached);
  }
  private prune(): void {
    if (this.now() < this.nextExpiry) return;
    this.nextExpiry = Infinity;
    for (const [uid, cached] of this.cache) {
      const expires = Math.min(cached.until, cached.usedAt + LOCAL_PROFILE_IDLE_MS);
      if (expires <= this.now()) this.remove(uid);
      else this.nextExpiry = Math.min(this.nextExpiry, expires);
    }
  }
  private complete(task: Task, value: LocalPublicProfile | null): void {
    if (this.tasks.get(task.uid) !== task) return;
    this.tasks.delete(task.uid);
    for (const consumer of task.consumers) { consumer.signal?.removeEventListener('abort', consumer.cancel); consumer.resolve(value); }
    task.consumers.clear();
  }
  private pump(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const now = this.now();
    this.admissions = this.admissions.filter(time => now - time < 60_000);
    if (typeof document !== 'undefined' && document.hidden) return;
    const quotaAt = this.admissions.length >= LOCAL_PROFILE_LIMITS.perMinute ? this.admissions[0] + 60_000 : 0;
    for (const task of this.tasks.values()) {
      if (this.active >= LOCAL_PROFILE_LIMITS.concurrent) break;
      if (task.running || task.controller.signal.aborted || !task.consumers.size || Math.max(task.after, this.cooldownUntil, quotaAt) > now) continue;
      if (this.admissions.length >= LOCAL_PROFILE_LIMITS.perMinute) break;
      task.running = true; this.active++; this.admissions.push(now);
      void this.fetchProfile(task.uid, task.controller.signal).then(value => {
        // An extension-local cache read spent no Bilibili HTTP quota. Refund
        // only explicit cache hits; older extensions keep the conservative cap.
        if (value?.avatarCacheHit === true) { const index = this.admissions.indexOf(now); if (index >= 0) this.admissions.splice(index, 1); }
        if (this.tasks.get(task.uid) !== task || task.controller.signal.aborted) return;
        this.write(task.uid, value);
        if (value) this.complete(task, value);
        else task.after = this.now() + 600_000;
      }).catch(error => {
        if (this.tasks.get(task.uid) !== task || task.controller.signal.aborted) return;
        const delay = LOCAL_PROFILE_RETRY_MS[Math.min(task.failures++, LOCAL_PROFILE_RETRY_MS.length - 1)];
        task.after = this.now() + delay;
        if (error instanceof LocalLoginClientError && error.code === 'RATE_LIMITED') {
          const retry = typeof error.retryAfter === 'number' && Number.isFinite(error.retryAfter) ? Math.max(0, error.retryAfter * 1000) : 0;
          this.cooldownUntil = Math.max(this.cooldownUntil, this.now() + Math.max(60_000, retry));
        }
      }).finally(() => { task.running = false; this.active--; this.pump(); });
    }
    if (this.active >= LOCAL_PROFILE_LIMITS.concurrent) return;
    const waiting = [...this.tasks.values()].filter(task => !task.running && task.consumers.size);
    if (!waiting.length) return;
    const quota = this.admissions.length >= LOCAL_PROFILE_LIMITS.perMinute ? this.admissions[0] + 60_000 : 0;
    const next = Math.min(...waiting.map(task => Math.max(task.after, this.cooldownUntil, quota)));
    if (next > now) this.timer = setTimeout(() => { this.timer = undefined; this.pump(); }, next - now);
  }
}
