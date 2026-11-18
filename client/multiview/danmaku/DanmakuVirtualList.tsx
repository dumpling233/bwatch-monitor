import React, { useLayoutEffect, useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { elementScroll, observeElementOffset, useVirtualizer } from '@tanstack/react-virtual';
import type { DanmakuMessage } from './types';
import type { DanmakuChatAdapter } from './DanmakuComposer';
import { DanmakuMessageCard } from './DanmakuMessageCard';
import type { DanmakuRepeatSender, DanmakuRepeatState } from './repeatMessage';

type Snapshot = { message: DanmakuMessage; top: number; left: number; width: number };
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const estimateHeight = (message: DanmakuMessage | undefined) => Math.max(64, Math.min(260, 58 + Math.ceil((message?.text.length ?? 0) / 20) * 19));
const MAX_RESTORE_LAYOUT_PASSES = 2;
const MAX_FALLBACK_ROWS = 80;
export type DanmakuViewport = { following: boolean; anchorId?: string; anchorOffset?: number; scrollOffset?: number; manualResumeOnly?: boolean };

/** Dynamic-height rows; the viewport's explicit follow/reading intent remains authoritative. */
export function DanmakuVirtualList({ messages, scrollRef, scrollElement, onScrollCompensation, chat, repeatState, onRepeat, onRepeatOpen, paused = false, initialViewport = { following: true }, following, onViewportReady, onViewportChange }: {
  messages: readonly DanmakuMessage[];
  scrollRef: RefObject<HTMLDivElement | null>;
  scrollElement: HTMLDivElement | null;
  onScrollCompensation: (element: HTMLElement) => void;
  chat?: DanmakuChatAdapter;
  repeatState?: DanmakuRepeatState | null;
  onRepeat?: DanmakuRepeatSender;
  onRepeatOpen?: () => void;
  paused?: boolean;
  initialViewport?: DanmakuViewport;
  following?: boolean;
  onViewportReady?: (ready: boolean, viewport?: DanmakuViewport) => void;
  onViewportChange?: (viewport: DanmakuViewport) => void;
}) {
  const [items, setItems] = useState(messages);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const stackRef = useRef<HTMLDivElement>(null);
  // Mounting a room/view exposes retained history, not newly received rows.
  const completedAnimations = useRef(new Set(messages.map(message => message.id)));
  const committedRows = useRef(new Set<string>());
  const historyPending = useRef(messages.length === 0);
  const historyCutoff = useRef(Date.now());
  const restoring = useRef(true);
  const wasPaused = useRef(paused);
  const [, setLayoutPass] = useState(0);
  const restoreWork = useRef({ passes: 0, deferred: false, frame: null as number | null });
  const retainedRange = useRef<{ firstId: string; lastId: string } | null>(null);
  const cancelRestoreFrame = () => {
    if (restoreWork.current.frame !== null) window.cancelAnimationFrame(restoreWork.current.frame);
    restoreWork.current.frame = null;
  };
  const beginRestore = () => {
    if (!restoring.current) {
      cancelRestoreFrame();
      restoreWork.current.passes = 0; restoreWork.current.deferred = false;
    }
    restoring.current = true;
  };
  const currentViewport = useRef(initialViewport);
  const previousFollowing = useRef(following);
  if (following !== undefined && currentViewport.current.following !== following) currentViewport.current = { ...currentViewport.current, following };
  const viewportCallbacks = useRef({ onViewportReady, onViewportChange });
  viewportCallbacks.current = { onViewportReady, onViewportChange };
  const offsetObserver = useRef<((offset: number, isScrolling: boolean) => void) | null>(null);
  if (wasPaused.current && !paused) {
    historyCutoff.current = Date.now();
    if (items.length) {
      for (const message of items) completedAnimations.current.add(message.id);
      historyPending.current = false;
    }
  }
  const compensateRef = useRef(onScrollCompensation);
  compensateRef.current = onScrollCompensation;
  const anchorRef = useRef<{ id: string; offset: number; before: readonly DanmakuMessage[] } | null>(null);
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: items.length,
    // The parent's host ref attaches after this child's layout effects. Its
    // explicit node state guarantees initialization even with preloaded history.
    getScrollElement: () => scrollElement,
    estimateSize: index => estimateHeight(items[index]),
    initialRect: { width: scrollElement?.clientWidth ?? 0, height: scrollElement?.clientHeight ?? 0 },
    initialOffset: () => {
      const viewport = currentViewport.current;
      const height = scrollElement?.clientHeight ?? scrollRef.current?.clientHeight ?? 0;
      const anchor = viewport.anchorId ? items.findIndex(message => message.id === viewport.anchorId) : -1;
      if (!viewport.following && anchor >= 0) return Math.max(0, items.slice(0, anchor).reduce((total, message) => total + estimateHeight(message), 0) - (viewport.anchorOffset ?? 0));
      // Bounded history may evict the reading anchor while another room is
      // open. Start at its earliest retained row, keeping reading mode paused.
      if (!viewport.following && viewport.anchorId) return 0;
      if (!viewport.following && viewport.scrollOffset !== undefined) return viewport.scrollOffset;
      return Math.max(0, items.reduce((total, message) => total + estimateHeight(message), 0) - height);
    },
    getItemKey: index => items[index]?.id ?? index,
    overscan: 5,
    useAnimationFrameWithResizeObserver: true,
    observeElementOffset: (instance, callback) => {
      offsetObserver.current = callback;
      const stop = observeElementOffset(instance, callback);
      return () => { offsetObserver.current = null; stop?.(); };
    },
    scrollToFn: (offset, options, instance) => {
      const element = scrollRef.current, before = element?.scrollTop;
      elementScroll(offset, options, instance);
      if (element && (before !== element.scrollTop || instance.scrollOffset !== element.scrollTop)) {
        compensateRef.current(element);
        // Seed the matching virtual range in this layout commit. Waiting for
        // the browser's later scroll event would paint the previous range.
        offsetObserver.current?.(element.scrollTop, false);
      }
    },
  });
  // Measurement corrections keep existing content stationary in both modes.
  // Only the parent's follow loop animates movement towards new content.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
    const element = scrollRef.current;
    return Boolean(element && item.end <= (instance.scrollOffset ?? element.scrollTop));
  };
  useLayoutEffect(() => {
    const takingOver = previousFollowing.current !== false && following === false;
    previousFollowing.current = following;
    const element = scrollRef.current;
    if (!takingOver || !element) return;
    // A measurement write clamped at the old bottom can remain queued inside
    // the virtualizer. User takeover supersedes it, even when no native scroll
    // occurred (+1). Use the public command to clear deferred layout work,
    // then cancel its reconcile immediately: it must not own any follow motion.
    virtualizer.scrollToOffset(element.scrollTop, { behavior: 'auto' });
    virtualizer.cancelScroll();
    offsetObserver.current?.(element.scrollTop, false);
  }, [following, virtualizer, scrollRef]);
  const totalSize = virtualizer.getTotalSize();
  let renderedRows = paused ? [] : virtualizer.getVirtualItems();
  let visibleRange = virtualizer.range;
  if (!paused && items.length && !renderedRows.length) {
    // A cached zero viewport produces no virtual range while the measured
    // history still has a height. Keep a bounded window of the current rows,
    // not an empty sizer. Keys are remapped after deletion/eviction; a keyed
    // room/account remount cannot retain another context's rows.
    const host = scrollElement ?? scrollRef.current;
    const height = host?.clientHeight ?? 0;
    const offset = restoring.current ? virtualizer.scrollOffset ?? 0 : host?.scrollTop ?? virtualizer.scrollOffset ?? 0;
    let first = virtualizer.getVirtualItemForOffset(offset)?.index ?? 0;
    let last = virtualizer.getVirtualItemForOffset(offset + height)?.index ?? first;
    let retained = false;
    if (!height && retainedRange.current) {
      const start = items.findIndex(message => message.id === retainedRange.current!.firstId);
      const end = items.findIndex(message => message.id === retainedRange.current!.lastId);
      if (start >= 0 && end >= start) { first = start; last = end; retained = true; }
    }
    const start = Math.max(0, first - (retained ? 0 : 5));
    renderedRows = virtualizer.measurementsCache.slice(start, Math.min(items.length, last + (retained ? 1 : 6), start + MAX_FALLBACK_ROWS));
    visibleRange = height ? { startIndex: first, endIndex: last } : null;
  }
  const animateNewRows = currentViewport.current.following && !document.hidden && !reducedMotion();
  const enteringRows = new Set(renderedRows.filter(row => {
    const message = items[row.index];
    return message && animateNewRows && !completedAnimations.current.has(message.id) && Date.now() - message.receivedAt < 1000;
  }).map(row => String(row.key)));
  useLayoutEffect(() => {
    const currentRows = new Set(renderedRows.map(row => String(row.key)));
    // An interrupted entry is consumed when its node leaves the virtual window.
    // A quick remount or a return to history must not flash the same row again.
    for (const id of committedRows.current) if (!currentRows.has(id)) completedAnimations.current.add(id);
    for (const id of currentRows) if (!enteringRows.has(id)) completedAnimations.current.add(id);
    committedRows.current = currentRows;
    if (!paused && renderedRows.length) retainedRange.current = {
      firstId: String(renderedRows[0].key), lastId: String(renderedRows[renderedRows.length - 1].key),
    };
    if (!items.length) retainedRange.current = null;
  });
  useLayoutEffect(() => {
    if (messages === items) return;
    if (historyPending.current && messages.length) {
      // A delayed projection can contain very recent retained history. The
      // receive timestamp distinguishes it from a genuinely new first message
      // arriving after this view opened, which still gets its entry animation.
      for (const message of messages) if (message.receivedAt <= historyCutoff.current) completedAnimations.current.add(message.id);
      historyPending.current = false; beginRestore();
      viewportCallbacks.current.onViewportReady?.(false);
    }
    const element = scrollRef.current, stack = stackRef.current;
    const wanted = new Set(messages.map(message => message.id));
    const removed = new Map(items.filter(message => !wanted.has(message.id)).map(message => [message.id, message]));
    if (element && stack && removed.size) {
      const clip = element.getBoundingClientRect();
      const rows = [...stack.querySelectorAll<HTMLElement>('[data-message-id]')];
      const anchor = rows.find(row => wanted.has(row.dataset.messageId ?? '') && row.getBoundingClientRect().bottom > clip.top && row.getBoundingClientRect().top < clip.bottom);
      const committed = anchor && renderedRows.find(row => row.index === Number(anchor.dataset.index));
      // Head eviction changes every retained offset even if the total height
      // stays unchanged. Preserve that content before continuing the one follow
      // animation; use layout offsets so ancestor scale cannot skew the anchor.
      if (anchor && committed) anchorRef.current = { id: anchor.dataset.messageId!, offset: committed.start - element.scrollTop, before: items };
      if (!reducedMotion() && !document.hidden) {
        const area = stack.closest('.mv-danmaku-log-area');
        if (area) {
          const bounds = area.getBoundingClientRect();
          const visible: Snapshot[] = [];
          for (const row of rows) {
            const message = removed.get(row.dataset.messageId ?? ''), rect = row.getBoundingClientRect();
            if (message && rect.bottom > clip.top && rect.top < clip.bottom && visible.length < 12) visible.push({ message, top: rect.top - bounds.top, left: rect.left - bounds.left, width: rect.width });
          }
          if (visible.length) setSnapshots(visible);
        }
      }
    }
    setItems(messages);
  }, [messages, items, scrollRef]);
  useLayoutEffect(() => {
    if (paused) {
      wasPaused.current = true; historyPending.current = true;
      cancelRestoreFrame();
      restoreWork.current.passes = 0; restoreWork.current.deferred = false;
      viewportCallbacks.current.onViewportReady?.(false);
      return;
    }
    if (wasPaused.current) {
      wasPaused.current = false; beginRestore();
    }
    const element = scrollRef.current, stack = stackRef.current;
    if (!element || !scrollElement || !stack || messages !== items) return;
    if (!element.clientWidth || !element.clientHeight) {
      beginRestore();
      cancelRestoreFrame();
      viewportCallbacks.current.onViewportReady?.(false);
      return;
    }
    // A room/view projection can arrive one commit after its empty shell.
    // Preserve the intended anchor until that first batch exists, rather than
    // replacing it with the outgoing view's DOM follow flag and zero offset.
    if (historyPending.current && !items.length) return;
    let restoredFollowing: boolean | undefined;
    if (restoring.current) {
      const viewport = currentViewport.current;
      const index = viewport.anchorId ? items.findIndex(message => message.id === viewport.anchorId) : -1;
      const measurement = index >= 0 ? virtualizer.getOffsetForIndex(index, 'start') : undefined;
      const maximum = Math.max(0, element.scrollHeight - element.clientHeight);
      const top = !viewport.following && measurement ? measurement[0] - (viewport.anchorOffset ?? 0)
        : !viewport.following && viewport.anchorId ? 0
        : !viewport.following && viewport.scrollOffset !== undefined ? viewport.scrollOffset
        : maximum;
      // The DOM extent includes the log's bottom padding. The virtualizer's
      // logical max does not, and its scrolling command would reconcile that
      // shorter target after this commit. Initialization needs a direct write.
      const target = Math.max(0, Math.min(maximum, top));
      const before = element.scrollTop;
      element.scrollTop = target;
      if (before !== element.scrollTop || virtualizer.scrollOffset !== element.scrollTop) {
        compensateRef.current(element);
        offsetObserver.current?.(element.scrollTop, false);
      }
      // Row refs measure before layout effects. Flush their changed sizer and
      // range before the first paint, rather than animating through history.
      // Updating an offset can select a new range before React has committed
      // its rows, so matching only the sizer is not sufficient for readiness.
      const virtualRows = virtualizer.getVirtualItems();
      const targetIndex = viewport.following ? items.length - 1 : virtualizer.range?.startIndex ?? visibleRange?.startIndex ?? renderedRows[0]?.index ?? 0;
      const row = stack.querySelector<HTMLElement>(`[data-index="${targetIndex}"]`);
      const virtualRow = virtualRows.find(item => item.index === targetIndex) ?? virtualizer.measurementsCache[targetIndex];
      const committedRow = renderedRows.find(item => item.index === targetIndex);
      // Compare committed layout coordinates with the latest measurements.
      // Visual rectangles include the sidebar's FLIP scale, which cannot
      // converge while synchronous React commits prevent the animation moving.
      const positioned = !items.length || Boolean(row && virtualRow && committedRow && committedRow.key === virtualRow.key && Math.abs(committedRow.start - virtualRow.start) <= 1);
      if (Math.abs(totalSize - virtualizer.getTotalSize()) > 1 || !positioned || Math.abs(element.scrollTop - target) > 1) {
        const work = restoreWork.current;
        if (work.passes < MAX_RESTORE_LAYOUT_PASSES) {
          work.passes += 1;
          setLayoutPass(pass => pass + 1);
          return;
        }
        if (!work.deferred) {
          work.deferred = true;
          work.frame = window.requestAnimationFrame(() => {
            work.frame = null;
            if (!document.hidden) setLayoutPass(pass => pass + 1);
          });
          return;
        }
        if (work.frame !== null) return;
        // Accept the current bounded rows after this one deferred attempt.
        // Normal geometry/scroll observations handle subsequent changes; a
        // persistent browser/style mismatch must never unmount the monitor.
      }
      cancelRestoreFrame();
      restoredFollowing = viewport.following;
      restoring.current = false;
      viewportCallbacks.current.onViewportReady?.(true, viewport);
    }
    const isFollowing = following ?? restoredFollowing ?? element.dataset.autoScroll !== 'false';
    const clip = !isFollowing ? element.getBoundingClientRect() : null;
    const row = clip ? [...stack.querySelectorAll<HTMLElement>('[data-message-id]')].find(node => node.getBoundingClientRect().bottom > clip.top) : undefined;
    const anchor = row && renderedRows.find(item => item.index === Number(row.dataset.index));
    const viewport: DanmakuViewport = { following: isFollowing, scrollOffset: element.scrollTop,
      ...(row && anchor ? { anchorId: row.dataset.messageId!, anchorOffset: anchor.start - element.scrollTop } : {}) };
    currentViewport.current = viewport;
    viewportCallbacks.current.onViewportChange?.(viewport);
  });
  useLayoutEffect(() => {
    const wanted = new Set(items.map(message => message.id));
    for (const key of virtualizer.itemSizeCache.keys()) if (!wanted.has(String(key))) virtualizer.itemSizeCache.delete(key);
    for (const key of completedAnimations.current) if (!wanted.has(key)) completedAnimations.current.delete(key);
    const anchor = anchorRef.current, element = scrollRef.current;
    if (!anchor || anchor.before === items || !element) return;
    anchorRef.current = null;
    const index = items.findIndex(message => message.id === anchor.id);
    if (index < 0) return;
    virtualizer.getTotalSize();
    const measurement = virtualizer.measurementsCache[index];
    if (measurement?.key !== anchor.id) return;
    // A direct layout correction has no independent scroll command/reconcile
    // animation that could pull against the parent's ongoing follow frame.
    const before = element.scrollTop;
    element.scrollTop = Math.max(0, measurement.start - anchor.offset);
    if (before !== element.scrollTop || virtualizer.scrollOffset !== element.scrollTop) {
      compensateRef.current(element);
      offsetObserver.current?.(element.scrollTop, false);
    }
  }, [items, virtualizer, scrollRef]);
  useEffect(() => {
    if (!snapshots.length) return;
    const timer = window.setTimeout(() => setSnapshots([]), 190);
    return () => window.clearTimeout(timer);
  }, [snapshots]);
  useLayoutEffect(() => () => cancelRestoreFrame(), []);
  const area = stackRef.current?.closest('.mv-danmaku-log-area');
  return <>
    <div ref={stackRef} className="mv-danmaku-message-stack mv-danmaku-virtual-stack" style={{ height: totalSize, position: 'relative' }}>
      {renderedRows.map(row => {
        const message = items[row.index];
        if (!message) return null;
        const fresh = enteringRows.has(message.id);
        return <div key={row.key} data-index={row.index} data-message-id={message.id} ref={virtualizer.measureElement} className={`mv-danmaku-row mv-danmaku-virtual-row${fresh ? ' mv-danmaku-row-entering' : ''}`} style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${row.start}px)` }} onAnimationEnd={event => {
          if (event.animationName === 'mv-danmaku-message-in') { completedAnimations.current.add(message.id); event.currentTarget.classList.remove('mv-danmaku-row-entering'); }
        }}>
          <DanmakuMessageCard message={message} chat={chat} repeatState={repeatState} onRepeat={onRepeat} onRepeatOpen={onRepeatOpen} hydrate={Boolean(visibleRange && row.index >= visibleRange.startIndex && row.index <= visibleRange.endIndex)} />
        </div>;
      })}
    </div>
    {!paused && area && snapshots.length > 0 && createPortal(<div className="mv-danmaku-retiring-snapshots" aria-hidden="true" inert>{snapshots.map(snapshot => <div key={snapshot.message.id} style={{ position: 'absolute', top: snapshot.top, left: snapshot.left, width: snapshot.width }}><DanmakuMessageCard message={snapshot.message} hydrate={false} onRepeat={onRepeat} /></div>)}</div>, area)}
  </>;
}
