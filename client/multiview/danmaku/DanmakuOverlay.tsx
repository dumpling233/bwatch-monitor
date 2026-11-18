import React, { useEffect, useRef } from 'react';
import type { DanmakuMessage } from './types';
import { isDanmakuBlocked, type DanmakuStyle } from './displayPreferences';
import { findSafeDanmakuY, MAX_OVERLAY_COMMENTS, OverlayQueue, OVERLAY_RETRY_MS } from './overlayScheduling';
import { createDanmakuSprite, danmakuFont, measureDanmakuText } from './textSprite';
import { overlayResources } from './overlayBudget';
import { reliableDanmakuUid } from './selfIdentity';
import './danmaku.css';

// danmaku 2.0.10 keeps emitted history and animation state internally. This
// adapter deliberately targets the pinned version to bound that history, stop
// idle RAFs, and retain travel progress when the monitor changes geometry.
interface FlyingComment { _utc: number; width: number; height: number; x: number; y: number; drawOffsetY: number; text: string; mode: 'rtl'; style: Record<string, string | number>; canvas?: HTMLCanvasElement | null; budgetPixels?: number; spriteRatio?: number; userId?: string; frame?: ReturnType<typeof measureDanmakuText>['frame'] }
interface EngineState {
  duration: number;
  position: number;
  width: number;
  height: number;
  stage: HTMLCanvasElement;
  engine: { framing: (stage: HTMLCanvasElement) => void; setup: (stage: HTMLCanvasElement, comments: FlyingComment[]) => void; render: (stage: HTMLCanvasElement, comment: FlyingComment) => void;
    clear(stage: HTMLCanvasElement, comments: FlyingComment[]): void; remove(stage: HTMLCanvasElement, comment: FlyingComment): void; resize(stage: HTMLCanvasElement, width: number, height: number): void };
  runningList: FlyingComment[];
  space: Record<string, { range: number; time: number; width: number; height: number }[]>;
}
interface CanvasDanmaku {
  _: EngineState;
  comments: FlyingComment[];
  speed: number;
  resize: () => void;
  show: () => void;
  hide: () => void;
  destroy: () => void;
}
export type SubscribeDanmaku = (roomId: string, listener: (messages: DanmakuMessage[]) => void) => () => void;

export function DanmakuOverlay({ roomId, active, style, subscribe, clearToken = 0, accountUid }: {
  roomId: string; active: boolean; style: DanmakuStyle; subscribe: SubscribeDanmaku; clearToken?: number; accountUid?: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const preferencesRef = useRef(style);
  const accountUidRef = useRef(accountUid);
  const resizeRef = useRef<() => void>(() => {});
  preferencesRef.current = style;
  accountUidRef.current = accountUid;
  useEffect(() => { resizeRef.current(); }, [style.speed, style.area]);

  useEffect(() => {
    const container = canvasRef.current, root = rootRef.current;
    if (!active || !container || !root) return;
    let disposed = false, renderer: CanvasDanmaku | undefined, idleTimer: number | undefined, pumpTimer: number | undefined;
    let lease: object | undefined;
    const queue = new OverlayQueue<{ text: string; color: string; userId?: string }>();
    const scale = () => Math.max(0.4, Math.min(1.7, root.clientHeight / 720));
    const textScale = () => preferencesRef.current.fixedFontSize ? 1 : scale();
    const fontSize = () => Math.max(10, preferencesRef.current.fontSize * textScale());
    const trimHistory = () => {
      if (!renderer) return;
      renderer.comments.splice(0, renderer._.position);
      renderer._.position = 0;
    };
    const clear = () => {
      window.clearTimeout(idleTimer);
      window.clearTimeout(pumpTimer); pumpTimer = undefined;
      queue.clear();
      if (lease) overlayResources.setWaiting(lease, 0);
      root.dataset.activeCount = '0'; root.dataset.pendingCount = '0';
      if (!renderer) return;
      renderer.hide();
      renderer.comments.length = 0;
      renderer._.position = 0;
      renderer._.stage.width = 0; renderer._.stage.height = 0;
      if (lease) overlayResources.releaseStage(lease);
    };
    const scheduleIdle = () => {
      window.clearTimeout(idleTimer);
      if (renderer) idleTimer = window.setTimeout(clear, Math.min(30000, renderer._.duration * 1000 + 150));
    };
    const pump = () => {
      window.clearTimeout(pumpTimer); pumpTimer = undefined;
      if (!renderer || disposed) return;
      if (document.hidden || !root.clientWidth || !root.clientHeight) { clear(); return; }
      if (!renderer._.stage.width) resize(false);
      trimHistory();
      const engine = renderer._, now = performance.now() / 1000;
      const config = preferencesRef.current, px = fontSize();
      const context = engine.stage.getContext('2d');
      if (!context) { clear(); return; }
      const font = danmakuFont(config, px);
      let next = queue.peek(now * 1000);
      while (next && engine.runningList.length < Math.min(MAX_OVERLAY_COMMENTS, lease ? overlayResources.capacity(lease) : 0)) {
        if (isDanmakuBlocked(next.text, config)) { queue.shift(); next = queue.peek(now * 1000); continue; }
        const text = next.text.slice(0, Math.min(200, Math.max(32, Math.floor(root.clientWidth / px) * 3)));
        // Reserve a small frame inset for reliable identities, independent of
        // the current account. Account changes can then update in-flight frames
        // without rebuilding sprites, moving lanes or restarting connections.
        const bounds = measureDanmakuText(context, text, font, px, config.textEffect, next.userId ? Math.max(2, px * 0.08) : 0), { width, laneHeight: height, drawOffsetY } = bounds;
        const inset = -drawOffsetY;
        const y = findSafeDanmakuY({ width: engine.width, height: engine.height, duration: engine.duration, now, gap: Math.max(8, px * 0.5), topInset: inset, bottomInset: inset }, { width, height }, engine.runningList);
        if (y === undefined) break;
        const comment: FlyingComment = { _utc: now, x: engine.width, y, drawOffsetY, width, height, text, mode: 'rtl', userId: next.userId, frame: bounds.frame,
          style: { font, fillStyle: /^#[0-9a-f]{6}$/i.test(next.color) ? next.color : '#ffffff' } };
        // Use the pinned engine for sprite creation/motion/removal, but bypass
        // allocate(): its full-stage fallback wraps into an occupied lane.
        renderer.show();
        const pixelRatio = engine.width > 0 ? engine.stage.width / engine.width : window.devicePixelRatio || 1;
        const pixels = Math.ceil(bounds.width * pixelRatio) * Math.ceil(bounds.height * pixelRatio);
        if (Math.max(bounds.width, bounds.height) * pixelRatio > 8192) { queue.shift(); next = queue.peek(now * 1000); continue; }
        if (!lease || !overlayResources.acquireSprite(lease, pixels)) break;
        comment.budgetPixels = pixels;
        comment.spriteRatio = pixelRatio;
        try { comment.canvas = createDanmakuSprite(text, String(comment.style.fillStyle), font, config.textEffect, bounds, pixelRatio); }
        catch {
          overlayResources.releaseSprite(lease, pixels); comment.budgetPixels = undefined;
          queue.shift(); next = queue.peek(now * 1000); continue;
        }
        engine.runningList.push(comment);
        queue.shift(); next = queue.peek(now * 1000);
      }
      root.dataset.activeCount = String(engine.runningList.length + queue.size);
      root.dataset.pendingCount = String(queue.size);
      if (lease) overlayResources.setWaiting(lease, queue.size);
      if (queue.size) pumpTimer = window.setTimeout(pump, OVERLAY_RETRY_MS);
      if (engine.runningList.length || queue.size) scheduleIdle();
    };
    const resize = (refill = true) => {
      if (!renderer) return;
      if (!queue.size && !renderer._.runningList.length) return;
      if (!root.clientWidth || !root.clientHeight) { clear(); return; }
      const engine = renderer._, nextSpeed = 144 * preferencesRef.current.speed * scale();
      const width = container.offsetWidth, height = container.offsetHeight;
      const size = lease ? overlayResources.stageSize(lease, width, height, window.devicePixelRatio || 1) : { width: 0, height: 0 };
      if (engine.width === width && engine.height === height && renderer.speed === nextSpeed && engine.stage.width === size.width && engine.stage.height === size.height) return;
      const previousDuration = engine.duration, previousHeight = engine.height;
      renderer.speed = nextSpeed;
      // Assigning canvas.width/height clears its bitmap. ResizeObserver runs
      // after the engine's RAF, so repaint in this same callback; waiting for
      // its next RAF would leave every frame of a CSS width transition blank.
      renderer.resize();
      const now = performance.now() / 1000, duration = renderer._.duration;
      renderer._.runningList.sort((a, b) => a.y - b.y).forEach(comment => {
        if (previousDuration > 0) comment._utc = now - ((now - comment._utc) / previousDuration) * duration;
        const nextY = previousHeight > 0 ? comment.y * engine.height / previousHeight : comment.y;
        // Retain in-flight comments while shrinking. Only newly arriving
        // comments are subject to the current lane capacity below.
        const inset = -comment.drawOffsetY;
        comment.y = Math.max(inset, Math.min(Math.max(inset, engine.height - comment.height - inset), nextY));
        comment.x = engine.width - (engine.width + comment.width) * (now - comment._utc) / duration;
      });
      const bound = Number.MAX_SAFE_INTEGER;
      renderer._.space.rtl = [{ range: 0, time: -bound, width: bound, height: 0 },
        ...renderer._.runningList.map(comment => ({ range: comment.y + comment.height, time: comment._utc, width: comment.width, height: comment.height })),
        { range: bound, time: bound, width: 0, height: 0 }];
      engine.engine.framing(engine.stage);
      for (const comment of engine.runningList) {
        if (comment.canvas && now - comment._utc <= duration) engine.engine.render(engine.stage, comment);
      }
      trimHistory();
      // Re-evaluate all intersecting old comments after geometry changes. Their
      // positions may no longer align with the current font's lane lattice.
      if (queue.size && refill) pump();
      if (renderer._.runningList.length || renderer.comments.length) scheduleIdle();
    };
    const visibility = () => { if (document.hidden) clear(); };
    resizeRef.current = resize;
    lease = overlayResources.register(() => { if (renderer && !disposed && !document.hidden) resize(); });
    const observer = new ResizeObserver(() => resize());
    observer.observe(container);
    document.addEventListener('visibilitychange', visibility);
    const unsubscribe = subscribe(roomId, messages => {
      if (!renderer || disposed || document.hidden || !root.clientWidth || !root.clientHeight) return;
      const values = messages.filter(message => message.kind === 'danmaku' && !isDanmakuBlocked(message.text, preferencesRef.current))
        .map(message => ({ text: message.text.slice(0, 200), color: message.color, userId: reliableDanmakuUid(message) }));
      const capacity = renderer._.runningList.length + (lease ? overlayResources.waitingCapacity(lease) : 0);
      queue.push(values, renderer._.runningList.length, performance.now(), capacity);
      if (lease) overlayResources.setWaiting(lease, queue.size);
      pump();
    });
    void import('danmaku').then(({ default: Danmaku }) => {
      if (disposed) return;
      renderer = new Danmaku({ container, engine: 'canvas', speed: 144 * preferencesRef.current.speed * scale() }) as unknown as CanvasDanmaku;
      const engine = renderer._.engine;
      const release = (comment: FlyingComment) => {
        if (comment.budgetPixels && lease) { overlayResources.releaseSprite(lease, comment.budgetPixels); comment.budgetPixels = undefined; }
        if (comment.canvas) { comment.canvas.width = 0; comment.canvas.height = 0; comment.canvas = null; }
      };
      renderer._.engine = { ...engine,
        clear: (stage, comments) => { for (const comment of comments) release(comment); engine.clear(stage, comments); },
        remove: (stage, comment) => { release(comment); engine.remove(stage, comment); },
        resize: (stage, width, height) => {
          const size = lease ? overlayResources.stageSize(lease, width, height, window.devicePixelRatio || 1) : { width: 0, height: 0 };
          stage.width = size.width; stage.height = size.height; stage.style.width = width + 'px'; stage.style.height = height + 'px';
        }
      };
      clear();
      renderer._.engine = { ...renderer._.engine, render: (stage, comment) => {
        if (!comment.canvas) return;
        const pixelRatio = renderer!._.width > 0 ? stage.width / renderer!._.width : window.devicePixelRatio || 1;
        const sourceRatio = comment.spriteRatio || pixelRatio;
        const context = stage.getContext('2d');
        if (!context) return;
        context.drawImage(comment.canvas, comment.x * pixelRatio, (comment.y + comment.drawOffsetY) * pixelRatio,
          comment.canvas.width / sourceRatio * pixelRatio, comment.canvas.height / sourceRatio * pixelRatio);
        if (comment.userId && comment.userId === accountUidRef.current && comment.frame) {
          const frame = comment.frame;
          context.save();
          context.strokeStyle = String(comment.style.fillStyle);
          context.lineWidth = pixelRatio;
          context.strokeRect((comment.x + frame.x) * pixelRatio, (comment.y + comment.drawOffsetY + frame.y) * pixelRatio,
            frame.width * pixelRatio, frame.height * pixelRatio);
          context.restore();
        }
      } };
      root.dataset.renderer = 'canvas';
    }).catch(() => { if (!disposed) root.dataset.renderer = 'unavailable'; });
    return () => {
      disposed = true;
      resizeRef.current = () => {};
      unsubscribe(); observer.disconnect(); document.removeEventListener('visibilitychange', visibility);
      window.clearTimeout(idleTimer); window.clearTimeout(pumpTimer); queue.clear(); renderer?.destroy();
      if (lease) { overlayResources.unregister(lease); lease = undefined; }
      delete root.dataset.renderer; delete root.dataset.activeCount; delete root.dataset.pendingCount;
    };
  }, [roomId, active, subscribe, clearToken]);

  return <div ref={rootRef} className="mv-danmaku-overlay" aria-hidden="true" data-testid="danmaku-overlay" data-room-id={roomId} data-enabled={active} style={{ opacity: style.opacity }}>
    <div ref={canvasRef} className="mv-danmaku-canvas" style={{ height: `${style.area * 100}%` }} />
  </div>;
}
