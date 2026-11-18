import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { danmakuAssetUrl } from './normalize';
import { isDanmakuAvatarPreview } from './avatarPreview';

export const DANMAKU_IMAGE_LIMITS = Object.freeze({ loading: 4, active: 64, avatarReserved: 32, dynamic: 4, waiting: 128 });
export const DANMAKU_IMAGE_LOAD_TIMEOUT_MS = 12_000;
export type DanmakuImagePriority = 'content' | 'avatar' | 'decorative' | 'picker';
export type DanmakuImageFailure = 'error' | 'budget' | 'dynamic' | 'capacity';
type Ticket = { url: string; dynamic: boolean; priority: DanmakuImagePriority; released: boolean; granted: boolean; loading: boolean; fallbackOnDynamicLimit: boolean; waitDeadline?: ReturnType<typeof setTimeout>; onReady?: () => void; onFailure?: (reason: DanmakuImageFailure) => void };
type ImageLoad = { tickets: Set<Ticket>; image: HTMLImageElement; deadline?: ReturnType<typeof setTimeout> };
const priorityOrder: Record<DanmakuImagePriority, number> = { content: 0, avatar: 1, decorative: 2, picker: 3 };

/** Bounded stills load through native img elements, outside the fallback budget. */
export function isDanmakuPickerPreview(value: string): boolean {
  const safe = danmakuAssetUrl(value);
  if (!safe) return false;
  const path = new URL(safe).pathname;
  return path.startsWith('/bfs/') && path.endsWith('@96w_96h.png');
}

/** Only unknown-size originals and animations need conservative admission. */
export class DanmakuImageBudget {
  private tickets = new Set<Ticket>();
  private loading = 0;
  private active = 0;
  private dynamic = 0;
  private nonAvatar = 0;
  private loads = new Map<string, ImageLoad>();
  private pumpQueued = false;
  constructor(private createImage: () => HTMLImageElement = () => new Image()) {}
  snapshot() { return { loading: this.loading, active: this.active, dynamic: this.dynamic, waiting: [...this.tickets].filter(ticket => !ticket.granted && !ticket.released).length }; }
  request(url: string, dynamic: boolean, onReady: () => void, priority: DanmakuImagePriority = 'decorative', onFailure?: (reason: DanmakuImageFailure) => void, fallbackOnDynamicLimit = false): () => void {
    const pickerFallback = priority === 'picker';
    if (pickerFallback) priority = 'decorative';
    const waiting = [...this.tickets].filter(ticket => !ticket.granted && !ticket.released);
    if (waiting.length >= DANMAKU_IMAGE_LIMITS.waiting) {
      // An actual message can displace waiting decoration, never an active load.
      const displaced = waiting.reverse().find(ticket => priorityOrder[ticket.priority] > priorityOrder[priority]);
      if (!displaced) { queueMicrotask(() => onFailure?.(pickerFallback ? 'capacity' : 'budget')); return () => {}; }
      const deferred = displaced.onFailure;
      displaced.released = true; this.retire(displaced); queueMicrotask(() => deferred?.('budget'));
    }
    const ticket: Ticket = { url, dynamic, priority, fallbackOnDynamicLimit, released: false, granted: false, loading: false, onReady, onFailure };
    // Unknown-size fallbacks share the conservative message pool. A full pool
    // must end in readable alt text, never an endless loading skeleton/retry.
    if (pickerFallback) ticket.waitDeadline = setTimeout(() => {
      if (ticket.granted || ticket.released) return;
      const failed = ticket.onFailure;
      ticket.released = true; this.retire(ticket); failed?.('capacity');
    }, DANMAKU_IMAGE_LOAD_TIMEOUT_MS);
    this.tickets.add(ticket); this.pump();
    return () => {
      if (ticket.released) return;
      ticket.released = true;
      ticket.onReady = undefined;
      // A detached row must not make an unfinished network request disappear from
      // the concurrency budget. The preloader retains its slot until it settles.
      if (!ticket.loading) this.retire(ticket);
      this.schedule();
    };
  }
  private retire(ticket: Ticket) {
    if (ticket.waitDeadline !== undefined) clearTimeout(ticket.waitDeadline);
    this.tickets.delete(ticket);
    if (ticket.granted) {
      this.active--; if (ticket.dynamic) this.dynamic--; if (ticket.priority !== 'avatar') this.nonAvatar--;
      ticket.granted = false;
    }
    ticket.onReady = undefined; ticket.onFailure = undefined;
  }
  private schedule() {
    if (this.pumpQueued) return;
    this.pumpQueued = true;
    queueMicrotask(() => { this.pumpQueued = false; this.pump(); });
  }
  private pump() {
    const waiting = [...this.tickets].filter(ticket => !ticket.granted && !ticket.released);
    for (const ticket of waiting.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority])) {
      if (ticket.dynamic && ticket.fallbackOnDynamicLimit && this.dynamic >= DANMAKU_IMAGE_LIMITS.dynamic) {
        const deferred = ticket.onFailure;
        ticket.released = true; this.retire(ticket);
        queueMicrotask(() => deferred?.('dynamic'));
        continue;
      }
      const shared = this.loads.get(ticket.url);
      if (!shared && this.loading >= DANMAKU_IMAGE_LIMITS.loading) continue;
      if (this.active >= DANMAKU_IMAGE_LIMITS.active) continue;
      if (ticket.released || ticket.granted || (ticket.dynamic && this.dynamic >= DANMAKU_IMAGE_LIMITS.dynamic)) continue;
      if (ticket.priority !== 'avatar' && this.nonAvatar >= DANMAKU_IMAGE_LIMITS.active - DANMAKU_IMAGE_LIMITS.avatarReserved) continue;
      ticket.granted = true; ticket.loading = true;
      if (ticket.waitDeadline !== undefined) { clearTimeout(ticket.waitDeadline); ticket.waitDeadline = undefined; }
      this.active++; if (ticket.dynamic) this.dynamic++; if (ticket.priority !== 'avatar') this.nonAvatar++;
      if (shared) {
        shared.tickets.add(ticket);
        continue;
      }
      this.loading++;
      const image = this.createImage();
      const load: ImageLoad = { tickets: new Set([ticket]), image };
      this.loads.set(ticket.url, load);
      image.referrerPolicy = 'no-referrer'; image.decoding = 'async'; image.fetchPriority = ticket.priority === 'content' ? 'high' : ticket.priority === 'avatar' ? 'auto' : 'low';
      let settled = false;
      const finish = (success: boolean) => {
        if (settled) return; settled = true; this.loading--; this.loads.delete(ticket.url);
        if (load.deadline !== undefined) clearTimeout(load.deadline);
        image.onload = null; image.onerror = null;
        for (const item of load.tickets) {
          item.loading = false;
          if (item.released || !success) {
            const failed = !item.released ? item.onFailure : undefined;
            this.retire(item); failed?.('error');
          } else { const ready = item.onReady; item.onReady = undefined; ready?.(); }
        }
        const releasedOnly = [...load.tickets].every(item => item.released);
        load.tickets.clear();
        // Never assign an empty URL, which could request the monitor page.
        if (!success || releasedOnly) image.removeAttribute('src');
        this.schedule();
      };
      load.deadline = setTimeout(() => finish(false), DANMAKU_IMAGE_LOAD_TIMEOUT_MS);
      image.onload = () => finish(true); image.onerror = () => finish(false); image.src = ticket.url;
    }
  }
}
const images = new DanmakuImageBudget();

type ImageSource = { url: string; dynamic: boolean };
type RecoveryAction = { kind: 'source' } | { kind: 'retry'; delay: number } | { kind: 'stop'; failed: boolean };

/** A finite source path; an exhausted animation budget is never a CDN error. */
export class DanmakuImageRecovery {
  private source: ImageSource;
  private failedUrls = new Set<string>();
  private usedStill = false;
  private usedOriginal = false;
  private retries = 0;
  private avatarFailures = 0;
  private hadError = false;
  constructor(primary: ImageSource, private priority: DanmakuImagePriority, private still?: ImageSource, private original?: ImageSource) { this.source = primary; }
  get current(): ImageSource { return this.source; }
  failure(reason: DanmakuImageFailure): RecoveryAction {
    if (reason === 'capacity') return { kind: 'stop', failed: true };
    if (reason === 'error') { this.hadError = true; this.failedUrls.add(this.source.url); }
    if (reason === 'dynamic') {
      if (this.still && !this.usedStill && !this.failedUrls.has(this.still.url) && this.source.url !== this.still.url) {
        this.usedStill = true; this.source = this.still; return { kind: 'source' };
      }
      return { kind: 'stop', failed: this.hadError };
    }
    if (reason === 'error') {
      if (this.original && !this.usedOriginal && !this.failedUrls.has(this.original.url) && this.source.url !== this.original.url) {
        this.usedOriginal = true; this.source = this.original; return { kind: 'source' };
      }
      if (this.still && !this.usedStill && !this.failedUrls.has(this.still.url) && this.source.url !== this.still.url) {
        this.usedStill = true; this.source = this.still; return { kind: 'source' };
      }
    }
    if (this.priority === 'avatar') {
      const delays = [3_000, 15_000, 60_000, 300_000];
      return { kind: 'retry', delay: reason === 'budget' ? 1_000 : delays[Math.min(this.avatarFailures++, delays.length - 1)] };
    }
    if (this.priority === 'picker') {
      if (reason === 'budget') return { kind: 'retry', delay: 1_000 };
      if (this.retries++ < 1) return { kind: 'retry', delay: 3_000 };
    }
    // A transformed asset may try its original once, never loop between URLs.
    if (this.priority === 'content' && this.retries++ < 1 && !(this.usedOriginal && this.source.url === this.original?.url)) {
      return { kind: 'retry', delay: reason === 'budget' ? 1_000 : 3_000 };
    }
    return { kind: 'stop', failed: this.hadError };
  }
}

export function DanmakuImage({ url, text, dynamic = false, fallbackUrl, fallbackDynamic = false, staticFallbackUrl, priority = 'decorative', placeholder = 'text', className = '', width, height, active = true, onError, onLoad }: {
  url?: string; text: string; dynamic?: boolean; priority?: DanmakuImagePriority; className?: string; width?: number; height?: number;
  fallbackUrl?: string; fallbackDynamic?: boolean; staticFallbackUrl?: string;
  placeholder?: 'text' | 'skeleton';
  active?: boolean;
  onError?(url: string): void; onLoad?(url: string): void;
}) {
  const safeUrl = danmakuAssetUrl(url);
  const safeOriginal = danmakuAssetUrl(fallbackUrl), safeStill = danmakuAssetUrl(staticFallbackUrl);
  const [foreground, setForeground] = useState(() => !document.hidden);
  const [recoveryEpoch, setRecoveryEpoch] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const generation = `${safeUrl}|${dynamic}|${safeOriginal}|${fallbackDynamic}|${safeStill}|${priority}|${recoveryEpoch}`;
  const recoveryRef = useRef<{ generation: string; recovery: DanmakuImageRecovery } | null>(null);
  if (recoveryRef.current?.generation !== generation) recoveryRef.current = { generation, recovery: new DanmakuImageRecovery(
    { url: safeUrl ?? '', dynamic: dynamic || /\.(?:gif|apng)(?:\?|$)/i.test(safeUrl ?? '') }, priority,
    safeStill ? { url: safeStill, dynamic: false } : undefined,
    safeOriginal ? { url: safeOriginal, dynamic: fallbackDynamic || /\.(?:gif|apng|webp)(?:\?|$)/i.test(safeOriginal) } : undefined,
  ) };
  const recovery = recoveryRef.current.recovery, source = recovery.current;
  const nativePreview = !source.dynamic && ((priority === 'picker' || priority === 'content') && isDanmakuPickerPreview(source.url) || priority === 'avatar' && isDanmakuAvatarPreview(source.url));
  const renderedImage = useRef<HTMLImageElement>(null);
  const [ready, setReady] = useState<{ generation: string; url: string } | null>(null);
  const [failure, setFailure] = useState<{ generation: string; url: string } | null>(null);
  const callbacks = useRef({ onError, onLoad }); callbacks.current = { onError, onLoad };
  const current = useRef({ generation, url: source.url }); current.current = { generation, url: source.url };
  const failVisible = useRef<{ url: string; fail(): void } | undefined>(undefined);
  const recoverable = useRef(false);
  recoverable.current = failure?.generation === generation && failure.url === source.url;
  useEffect(() => {
    // An online signal is not evidence that a displayed image became invalid.
    // Retry failed resources only. Native requests keep the browser lifecycle;
    // original/animation preloaders have a bounded deadline.
    const recover = () => { if (!document.hidden && recoverable.current) setRecoveryEpoch(value => value + 1); };
    const visibility = () => { setForeground(!document.hidden); if (!document.hidden) recover(); };
    window.addEventListener('online', recover);
    document.addEventListener('visibilitychange', visibility);
    return () => { window.removeEventListener('online', recover); document.removeEventListener('visibilitychange', visibility); };
  }, []);
  useLayoutEffect(() => {
    // Hidden retained groups keep successful img nodes, but stop queued work.
    // Warm requests resolve here before paint instead of flashing a skeleton.
    setReady(previous => nativePreview && previous?.generation === generation && previous.url === source.url ? previous : null);
    setFailure(null);
    if (!source.url || !foreground || !active) return;
    let disposed = false, timer: ReturnType<typeof setTimeout> | undefined;
    let release = () => {};
    const isCurrent = () => !disposed && current.current.generation === generation && current.current.url === source.url;
    const failed = (reason: DanmakuImageFailure) => {
      if (!isCurrent() || timer !== undefined) return;
      release();
      setReady(null);
      if (reason === 'error') callbacks.current.onError?.(source.url);
      const action = recovery.failure(reason);
      if (action.kind === 'source') { setFailure(null); setAttempt(value => value + 1); }
      else if (action.kind === 'retry') {
        if (reason === 'error') setFailure({ generation, url: source.url });
        timer = setTimeout(() => { if (isCurrent() && !document.hidden) setAttempt(value => value + 1); }, action.delay);
      }
      else setFailure(action.failed ? { generation, url: source.url } : null);
    };
    // Bounded stills use native img loading/HTTP cache directly. A cached image
    // must never wait for our original/animation preloader's download slots.
    if (!nativePreview) release = images.request(source.url, source.dynamic, () => { if (isCurrent()) { setFailure(null); setReady({ generation, url: source.url }); } }, priority, failed, Boolean(safeStill || safeOriginal));
    else if (renderedImage.current?.complete && renderedImage.current.naturalWidth > 0) setReady({ generation, url: source.url });
    const rendered = { url: source.url, fail: () => failed('error') }; failVisible.current = rendered;
    return () => { disposed = true; release(); if (timer !== undefined) clearTimeout(timer); if (failVisible.current === rendered) failVisible.current = undefined; };
  }, [generation, source.url, source.dynamic, priority, nativePreview, foreground, active, attempt]);
  const displayed = ready?.generation === generation && ready.url === source.url && (nativePreview || foreground && active);
  const nativeDemand = nativePreview && foreground && active && !(failure?.generation === generation && failure.url === source.url);
  const pending = !displayed && placeholder === 'skeleton' && source.url && !(failure?.generation === generation && failure.url === source.url);
  const pendingScale = Math.min(1, 112 / (width || 32), 64 / (height || 32));
  const pendingSize = priority === 'content' && pending ? { width: Math.max(20, (width || 32) * pendingScale), height: Math.max(20, (height || 32) * pendingScale) } : undefined;
  return <span className={`mv-danmaku-image ${className}`} data-image-state={displayed ? 'ready' : pending ? 'pending' : 'fallback'} style={pendingSize}>
    {source.url && (displayed || nativeDemand) ? <img ref={renderedImage} src={source.url} alt={text} width={width} height={height} referrerPolicy="no-referrer" decoding="async" fetchPriority={priority === 'content' ? 'auto' : 'low'} onLoad={event => {
      if (current.current.generation === generation && current.current.url === source.url && event.currentTarget.currentSrc === source.url) {
        if (nativePreview) { setFailure(null); setReady({ generation, url: source.url }); }
        callbacks.current.onLoad?.(source.url);
      }
    }} onError={() => { if (failVisible.current?.url === source.url && current.current.generation === generation && current.current.url === source.url) failVisible.current.fail(); }} /> : pending
      ? <span className="mv-danmaku-image-pending" role="img" aria-label={text}><span aria-hidden="true" /></span>
      : <span className="mv-danmaku-image-fallback">{text}</span>}
  </span>;
}
