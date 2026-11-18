import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { swapRoomSlots, visibleSlotIndices, type RoomSlot } from './layouts';

export type TileDragVisual = { roomId: string; rect: { left: number; top: number; width: number; height: number } };
export interface TileReorderOptions {
  roomIds: string[];
  slotRoomIds: RoomSlot[];
  visibleSlots: RoomSlot[];
  windowOffset: number;
  contextKey?: string;
  enabled: boolean;
  tileRefs: RefObject<Map<string, HTMLElement>>;
  gridRef: RefObject<HTMLElement | null>;
  captureLayout: () => void;
  onPreview: (slots: RoomSlot[] | null) => void;
  onCommit: (slots: RoomSlot[]) => void;
  adaptive?: boolean;
  onCommitOrder?: (roomIds: string[]) => void;
}
type DragSession = { roomId: string; originalKey: string; cancel: (notify?: boolean) => void };
type SlotSensor = { slot: number; rect: DOMRect };
const contains = (rect: DOMRect, x: number, y: number) => rect.width > 0 && rect.height > 0
  && x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;
const reorderContextKey = (options: TileReorderOptions) => JSON.stringify([options.roomIds, options.slotRoomIds, options.windowOffset, options.visibleSlots.length, options.contextKey, options.adaptive]);

/** Pointer movement previews a slot exchange, committing only after an intentional drop. */
export function useTileReorder(options: TileReorderOptions) {
  const current = useRef(options);
  current.current = options;
  const session = useRef<DragSession | null>(null);
  const clickBlockedUntil = useRef(0);
  const alive = useRef(true);
  const [dragVisual, setDragVisual] = useState<TileDragVisual | null>(null);
  const cancelDrag = useCallback(() => session.current?.cancel(), []);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>, roomId: string) => {
    clickBlockedUntil.current = 0;
    const settings = current.current;
    const target = event.target as HTMLElement;
    if (!settings.enabled || !event.isPrimary || event.button !== 0 || !settings.visibleSlots.includes(roomId)) return;
    const specialHandle = target.closest('.mv-tile-title');
    if (target.closest('input,select,textarea,a,[contenteditable="true"],[role="combobox"],[role="listbox"],[role="option"],.ui-select-content,.mv-tile-controls') || (target.closest('button,[role="button"]') && !specialHandle)) return;
    if (event.pointerType === 'touch' && !specialHandle) return;
    const node = settings.tileRefs.current.get(roomId);
    const grid = settings.gridRef.current;
    if (!node || !grid || document.fullscreenElement === node || settings.visibleSlots.length < 2) return;
    session.current?.cancel();
    const pointerId = event.pointerId;
    const startX = event.clientX, startY = event.clientY;
    const initialSlots = [...settings.slotRoomIds];
    const positions = settings.adaptive
      ? Array.from({ length: settings.visibleSlots.length }, (_, index) => index)
      : visibleSlotIndices(initialSlots.length, settings.visibleSlots.length, settings.windowOffset);
    const fromIndex = initialSlots.indexOf(roomId);
    if (fromIndex < 0 || !positions.includes(fromIndex)) return;
    let targetSlot: number | null = fromIndex;
    let slots = [...initialSlots];
    let sensors: SlotSensor[] = [];
    let gridBounds: DOMRect | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let pointerX = startX, pointerY = startY;
    let frame: number | null = null;
    let active = false;
    let finished = false;
    const entry: DragSession = { roomId, originalKey: reorderContextKey(settings), cancel: notify => finish(false, notify) };

    function validContext() {
      return current.current.enabled && !document.hidden && reorderContextKey(current.current) === entry.originalKey;
    }

    function slotAt(x: number, y: number): number | null {
      const liveGrid = current.current.gridRef.current;
      if (!liveGrid || !gridBounds) return null;
      const bounds = liveGrid.getBoundingClientRect();
      if (Math.abs(bounds.left - gridBounds.left) > .5 || Math.abs(bounds.top - gridBounds.top) > .5
        || Math.abs(bounds.width - gridBounds.width) > .5 || Math.abs(bounds.height - gridBounds.height) > .5
        || !contains(gridBounds, x, y)) return null;
      // Slot geometry is frozen before preview. Moving players and the drop
      // placeholder never become hit targets, so animation cannot change a hit.
      for (const sensor of sensors) if (contains(sensor.rect, x, y)) return sensor.slot;
      return null;
    }

    function cancelIfResized() {
      if (!active || !gridBounds) return;
      const bounds = grid!.getBoundingClientRect();
      if (Math.abs(bounds.left - gridBounds.left) > .5 || Math.abs(bounds.top - gridBounds.top) > .5
        || Math.abs(bounds.width - gridBounds.width) > .5 || Math.abs(bounds.height - gridBounds.height) > .5) finish(false);
    }

    function finish(commit: boolean, notify = true) {
      if (finished) return;
      finished = true;
      if (session.current === entry) session.current = null;
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = null;
      resizeObserver?.disconnect(); resizeObserver = null;
      if (active && notify && alive.current) current.current.captureLayout();
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', cancel, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('resize', cancel);
      window.removeEventListener('scroll', scroll, true);
      document.removeEventListener('visibilitychange', visibility);
      document.removeEventListener('fullscreenchange', cancel);
      grid!.removeEventListener('lostpointercapture', cancel);
      if (grid!.hasPointerCapture(pointerId)) grid!.releasePointerCapture(pointerId);
      node!.style.removeProperty('--mv-drag-x');
      node!.style.removeProperty('--mv-drag-y');
      if (!active || !notify || !alive.current) return;
      clickBlockedUntil.current = performance.now() + 400;
      if (commit && validContext() && slots.some((id, index) => id !== initialSlots[index])) {
        if (current.current.adaptive) current.current.onCommitOrder?.(slots.filter((id): id is string => id !== null));
        else current.current.onCommit(slots);
      }
      current.current.onPreview(null);
      setDragVisual(null);
    }
    function cancel() { finish(false); }
    function scroll(scrollEvent: Event) {
      const target = scrollEvent.target;
      // Only scrolling the grid or its ancestors invalidates the frozen slot
      // coordinates. Chat auto-follow and other independent scroll areas must
      // not interrupt a player that is still held by the pointer.
      if (target === window || target === document || (target instanceof Element && target.contains(grid))) finish(false);
    }
    function visibility() { if (document.hidden) finish(false); }
    function key(keyEvent: KeyboardEvent) {
      if (keyEvent.key !== 'Escape') return;
      if (active) { keyEvent.preventDefault(); keyEvent.stopPropagation(); }
      finish(false);
    }
    function up(pointer: PointerEvent) {
      if (pointer.pointerId !== pointerId) return;
      const finalHit = active && validContext() ? slotAt(pointer.clientX, pointer.clientY) : null;
      // Recompute from the original snapshot: a last fast movement or a gap
      // must never commit the target from an earlier pointermove.
      if (finalHit !== null) {
        slots = swapRoomSlots(initialSlots, fromIndex, finalHit);
      }
      finish(finalHit !== null);
    }
    function move(pointer: PointerEvent) {
      if (pointer.pointerId !== pointerId || finished) return;
      if (!validContext()) { finish(false); return; }
      if (!(pointer.buttons & 1)) { finish(false); return; }
      pointerX = pointer.clientX; pointerY = pointer.clientY;
      const dx = pointer.clientX - startX, dy = pointer.clientY - startY;
      if (!active) {
        if (Math.hypot(dx, dy) < 6) return;
        gridBounds = grid!.getBoundingClientRect();
        sensors = Array.from(grid!.querySelectorAll<HTMLElement>('[data-mv-slot-index]')).flatMap(sensor => {
          const index = Number(sensor.dataset.mvSlotIndex);
          if (!Number.isInteger(index) || index < 0 || index >= positions.length) return [];
          const rect = sensor.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 ? [{ slot: positions[index], rect }] : [];
        });
        if (!sensors.length) { finish(false); return; }
        const rect = node!.getBoundingClientRect();
        current.current.captureLayout();
        active = true;
        resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(cancelIfResized) : null;
        resizeObserver?.observe(grid!);
        setDragVisual({ roomId, rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height } });
        current.current.onPreview([...initialSlots]);
        // Keep capture on the grid while the source player follows the pointer.
        try { grid!.setPointerCapture(pointerId); } catch { /* Window listeners still finish a pointer that left the tile. */ }
        grid!.addEventListener('lostpointercapture', cancel);
      }
      if (pointer.cancelable) pointer.preventDefault();
      if (frame === null) frame = window.requestAnimationFrame(updatePresentation);
    }
    function updatePresentation() {
      frame = null;
      if (finished || !active) return;
      if (!validContext()) { finish(false); return; }
      node!.style.setProperty('--mv-drag-x', `${pointerX - startX}px`);
      node!.style.setProperty('--mv-drag-y', `${pointerY - startY}px`);
      const nextTarget = slotAt(pointerX, pointerY);
      if (nextTarget === targetSlot) return;
      current.current.captureLayout();
      targetSlot = nextTarget;
      // Always exchange with the original source so crossing a third tile cannot move it.
      slots = targetSlot === null ? [...initialSlots] : swapRoomSlots(initialSlots, fromIndex, targetSlot);
      current.current.onPreview(slots);
    }
    session.current = entry;
    window.addEventListener('pointermove', move, { capture: true, passive: false });
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', cancel, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', cancel);
    window.addEventListener('resize', cancel);
    window.addEventListener('scroll', scroll, true);
    document.addEventListener('visibilitychange', visibility);
    document.addEventListener('fullscreenchange', cancel);
  }, []);

  const shouldSuppressClick = useCallback(() => performance.now() < clickBlockedUntil.current, []);
  const suppressClick = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (event.detail > 0 && shouldSuppressClick()) { event.preventDefault(); event.stopPropagation(); }
  }, [shouldSuppressClick]);

  const baseKey = reorderContextKey(options);
  useEffect(() => {
    if (session.current && (!options.enabled || session.current.originalKey !== baseKey)) cancelDrag();
  }, [baseKey, options.enabled, cancelDrag]);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; session.current?.cancel(false); };
  }, []);

  return { dragVisual, onPointerDown, suppressClick, shouldSuppressClick, cancelDrag, isDragging: Boolean(dragVisual) };
}
