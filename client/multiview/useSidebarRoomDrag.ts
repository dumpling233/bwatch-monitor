import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';

export interface SidebarRoomDragOptions {
  enabled: boolean;
  /** Include every structural, permission, screen-mode and fullscreen revision. */
  contextKey: string;
  gridRef: RefObject<HTMLElement | null>;
  ghostRef: RefObject<HTMLElement | null>;
  onStart: (roomId: string) => void;
  onTarget: (index: number | null) => void;
  onDrop: (index: number) => void;
  onCancel: () => void;
  allowBackgroundDrop?: boolean;
  /** Called before committing; a zero-size source rect means its card is no longer visible. */
  onFinish?: (outcome: 'drop' | 'cancel', targetRect: DOMRect | null, sourceRect: DOMRect) => void;
}

type Session = { contextKey: string; cancel: (notify?: boolean) => void };
type Hit = { index: number; rect: DOMRect };
const contains = (rect: DOMRect, x: number, y: number) => rect.width > 0 && rect.height > 0
  && x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;
const intersects = (a: DOMRect, b: DOMRect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

/** A presentation-only external drag. The caller owns both placement policy and media state. */
export function useSidebarRoomDrag(options: SidebarRoomDragOptions) {
  const current = useRef(options);
  current.current = options;
  const session = useRef<Session | null>(null);
  const alive = useRef(true);
  const clickBlockedUntil = useRef(0);
  const [isDragging, setIsDragging] = useState(false);
  const cancelDrag = useCallback(() => session.current?.cancel(), []);
  const shouldSuppressClick = useCallback(() => performance.now() < clickBlockedUntil.current, []);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>, roomId: string) => {
    const settings = current.current;
    const target = event.target as HTMLElement;
    if (!settings.enabled || !event.isPrimary || event.button !== 0 || event.pointerType === 'touch'
      || target.closest('[data-no-placement-drag],input,select,textarea,a,[contenteditable="true"],[role="combobox"],[role="listbox"],[role="option"]')) return;
    const source = event.currentTarget.closest<HTMLElement>('[data-placement-source]') ?? event.currentTarget;
    const scrollArea = source.closest<HTMLElement>('[data-placement-scroll]');
    const captureNode = scrollArea ?? settings.gridRef.current;
    if (!settings.gridRef.current || !captureNode) return;
    session.current?.cancel();
    clickBlockedUntil.current = 0;
    const pointerId = event.pointerId;
    const startX = event.clientX, startY = event.clientY;
    let pointerX = startX, pointerY = startY;
    let active = false;
    let finished = false;
    let frame: number | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let targetIndex: number | null = null;
    const entry: Session = { contextKey: settings.contextKey, cancel: notify => finish(null, notify) };

    function validContext() {
      return current.current.enabled && current.current.contextKey === entry.contextKey && !document.hidden;
    }

    function hitTest(x: number, y: number): Hit | null {
      const grid = current.current.gridRef.current;
      if (!grid || !contains(grid.getBoundingClientRect(), x, y)) return null;
      for (const candidate of grid.querySelectorAll<HTMLElement>('[data-placement-slot]')) {
        const index = Number(candidate.dataset.placementSlot);
        if (!Number.isInteger(index) || index < 0 || !candidate.getClientRects().length) continue;
        const rect = candidate.getBoundingClientRect();
        if (contains(rect, x, y)) return { index, rect };
      }
      if (current.current.allowBackgroundDrop) return { index: -1, rect: grid.getBoundingClientRect() };
      return null;
    }

    function sourceRect() {
      if (!source.isConnected) return new DOMRect();
      const rect = source.getBoundingClientRect();
      const bounds = scrollArea?.getBoundingClientRect();
      return rect.width && rect.height && (!bounds || intersects(rect, bounds)) ? rect : new DOMRect();
    }

    function scheduleFrame() {
      if (active && !finished && frame === null) frame = window.requestAnimationFrame(updatePresentation);
    }

    function updatePresentation() {
      frame = null;
      if (!active || finished) return;
      if (!validContext()) { finish(null); return; }
      const ghost = current.current.ghostRef.current;
      if (ghost) {
        ghost.dataset.dragging = 'true';
        ghost.style.transform = `translate3d(${pointerX + 12}px, ${pointerY + 12}px, 0)`;
      }
      let scrolled = false;
      if (scrollArea?.isConnected) {
        const bounds = scrollArea.getBoundingClientRect();
        if (pointerX >= bounds.left && pointerX < bounds.right && pointerY >= bounds.top && pointerY < bounds.bottom) {
          const edge = Math.min(44, bounds.height / 3);
          const before = scrollArea.scrollTop;
          if (edge > 0 && pointerY < bounds.top + edge) scrollArea.scrollTop -= 16 * (1 - (pointerY - bounds.top) / edge);
          else if (edge > 0 && pointerY > bounds.bottom - edge) scrollArea.scrollTop += 16 * (1 - (bounds.bottom - pointerY) / edge);
          scrolled = before !== scrollArea.scrollTop;
        }
      }
      const nextTarget = hitTest(pointerX, pointerY)?.index ?? null;
      if (nextTarget !== targetIndex) {
        targetIndex = nextTarget;
        current.current.onTarget(nextTarget);
      }
      if (scrolled) scheduleFrame();
    }

    function finish(hit: Hit | null, notify = true) {
      if (finished) return;
      finished = true;
      if (session.current === entry) session.current = null;
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = null;
      resizeObserver?.disconnect(); resizeObserver = null;
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', pointerCancel, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('resize', cancel);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('dragstart', preventNativeDrag, true);
      window.removeEventListener('selectstart', preventSelection, true);
      document.removeEventListener('visibilitychange', visibility);
      document.removeEventListener('fullscreenchange', cancel);
      captureNode!.removeEventListener('lostpointercapture', pointerCancel);
      try {
        if (captureNode!.hasPointerCapture(pointerId)) captureNode!.releasePointerCapture(pointerId);
      } catch { /* The captured surface may have left the document. */ }
      if (!active) return;
      clickBlockedUntil.current = performance.now() + 400;
      if (!notify || !alive.current) return;
      const ghost = current.current.ghostRef.current;
      if (ghost) ghost.dataset.dragging = 'false';
      setIsDragging(false);
      const drop = hit && validContext() ? hit : null;
      current.current.onFinish?.(drop ? 'drop' : 'cancel', drop?.rect ?? null, sourceRect());
      if (drop) current.current.onDrop(drop.index);
      else current.current.onCancel();
    }

    function cancel() { finish(null); }
    function pointerCancel(pointer: PointerEvent) { if (pointer.pointerId === pointerId) finish(null); }
    function visibility() { if (document.hidden) finish(null); }
    function scroll() { scheduleFrame(); }
    function preventNativeDrag(nativeEvent: DragEvent) {
      if (source.contains(nativeEvent.target as Node)) nativeEvent.preventDefault();
    }
    function preventSelection(selectionEvent: Event) {
      if (source.contains(selectionEvent.target as Node)) selectionEvent.preventDefault();
    }
    function key(keyEvent: KeyboardEvent) {
      if (keyEvent.key !== 'Escape') return;
      if (active) { keyEvent.preventDefault(); keyEvent.stopPropagation(); }
      finish(null);
    }
    function up(pointer: PointerEvent) {
      if (pointer.pointerId !== pointerId) return;
      // The final coordinates are authoritative, including gaps and a last fast move.
      finish(active ? hitTest(pointer.clientX, pointer.clientY) : null);
    }
    function move(pointer: PointerEvent) {
      if (pointer.pointerId !== pointerId || finished) return;
      if (!validContext() || !(pointer.buttons & 1)) { finish(null); return; }
      pointerX = pointer.clientX;
      pointerY = pointer.clientY;
      if (!active) {
        if (Math.hypot(pointerX - startX, pointerY - startY) < 6) return;
        active = true;
        const grid = current.current.gridRef.current!;
        const { clientWidth: width, clientHeight: height } = grid;
        resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => {
          if (grid.clientWidth !== width || grid.clientHeight !== height) cancel();
        }) : null;
        resizeObserver?.observe(grid);
        setIsDragging(true);
        current.current.onStart(roomId);
        try { captureNode!.setPointerCapture(pointerId); } catch { /* Window listeners cover capture failure. */ }
        captureNode!.addEventListener('lostpointercapture', pointerCancel);
      }
      if (pointer.cancelable) pointer.preventDefault();
      scheduleFrame();
    }

    session.current = entry;
    window.addEventListener('pointermove', move, { capture: true, passive: false });
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', pointerCancel, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', cancel);
    window.addEventListener('resize', cancel);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('dragstart', preventNativeDrag, true);
    window.addEventListener('selectstart', preventSelection, true);
    document.addEventListener('visibilitychange', visibility);
    document.addEventListener('fullscreenchange', cancel);
  }, []);

  useEffect(() => {
    if (session.current && (!options.enabled || session.current.contextKey !== options.contextKey)) cancelDrag();
  }, [options.contextKey, options.enabled, cancelDrag]);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; session.current?.cancel(false); };
  }, []);

  return { onPointerDown, isDragging, shouldSuppressClick, cancelDrag };
}
