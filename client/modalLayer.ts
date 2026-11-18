import { useLayoutEffect, useRef, type RefObject } from 'react';

type Surface = RefObject<HTMLElement | null>;
type Layer = { surface: Surface; suspended: () => boolean };
const layers = new Set<Layer>();
let releasePage: (() => void) | undefined;

export function hasActiveModal(): boolean { return layers.size > 0; }

function topSurface(): HTMLElement | null {
  return [...layers].reverse().find(layer => !layer.suspended() && layer.surface.current?.isConnected)?.surface.current ?? null;
}

function lockPage(): () => void {
  const root = document.documentElement;
  const overflow = root.style.overflow;
  const gutter = root.style.scrollbarGutter;
  root.setAttribute('data-ui-modal-open', '');
  // A stable root gutter also reserves space with overflow:hidden. Do not
  // reposition the body, compensate its margin, or change the scroll offset.
  if (CSS.supports('scrollbar-gutter', 'stable')) {
    if (window.innerWidth > root.clientWidth) root.style.scrollbarGutter = 'stable';
    root.style.overflow = 'hidden';
  }
  let touchX = 0, touchY = 0;
  const canScroll = (target: EventTarget | null, dx: number, dy: number) => {
    const surface = topSurface();
    if (!(target instanceof Element) || !surface) return false;
    // Radix selects/calendar menus may portal outside their parent dialog.
    const boundary = surface.contains(target) ? surface
      : !target.closest('[aria-hidden="true"], [inert]') && target.closest<HTMLElement>('[data-radix-popper-content-wrapper], [data-radix-select-viewport]');
    if (!boundary) return false;
    for (let node: Element | null = target; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (/auto|scroll/.test(style.overflowY) && node.scrollHeight > node.clientHeight &&
        ((dy < 0 && node.scrollTop > 0) || (dy > 0 && node.scrollTop + node.clientHeight < node.scrollHeight - 1))) return true;
      if (/auto|scroll/.test(style.overflowX) && node.scrollWidth > node.clientWidth &&
        ((dx < 0 && node.scrollLeft > 0) || (dx > 0 && node.scrollLeft + node.clientWidth < node.scrollWidth - 1))) return true;
      if (node === boundary) break;
    }
    return false;
  };
  const wheel = (event: WheelEvent) => {
    if (!event.ctrlKey && !canScroll(event.target, event.deltaX, event.deltaY)) event.preventDefault();
  };
  const touchStart = (event: TouchEvent) => { touchX = event.touches[0]?.clientX ?? 0; touchY = event.touches[0]?.clientY ?? 0; };
  const touchMove = (event: TouchEvent) => {
    if (event.touches.length !== 1) return;
    const touch = event.touches[0];
    if (!canScroll(event.target, touchX - touch.clientX, touchY - touch.clientY)) event.preventDefault();
    touchX = touch.clientX; touchY = touch.clientY;
  };
  document.addEventListener('wheel', wheel, { passive: false });
  document.addEventListener('touchstart', touchStart, { passive: true });
  document.addEventListener('touchmove', touchMove, { passive: false });
  return () => {
    root.style.overflow = overflow;
    root.style.scrollbarGutter = gutter;
    root.removeAttribute('data-ui-modal-open');
    document.removeEventListener('wheel', wheel);
    document.removeEventListener('touchstart', touchStart);
    document.removeEventListener('touchmove', touchMove);
  };
}

/** All modal surfaces share one page lock; background components stay mounted. */
export function useModalLayer(open: boolean, surface: Surface, suspended = false) {
  const suspendedRef = useRef(suspended);
  suspendedRef.current = suspended;
  useLayoutEffect(() => {
    if (!open) return;
    const layer: Layer = { surface, suspended: () => suspendedRef.current };
    if (!layers.size) releasePage = lockPage();
    layers.add(layer);
    return () => {
      layers.delete(layer);
      if (!layers.size) { releasePage?.(); releasePage = undefined; }
    };
  }, [open, surface]);
}

/** Custom dialogs/sheets share focus handling; Radix alerts keep their trap. */
export function useModalFocus(open: boolean, surface: Surface, initialFocus: Surface,
  onClose: () => void, suspended = false, closeDisabled = false) {
  const state = useRef({ onClose, closeDisabled });
  state.current = { onClose, closeDisabled };
  const lastFocus = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      lastFocus.current = null;
      const top = topSurface();
      if (previous?.isConnected && (!top || top.contains(previous))) previous.focus({ preventScroll: true });
    };
  }, [open]);
  useLayoutEffect(() => {
    if (!open || suspended) return;
    const node = surface.current;
    if (!node) return;
    (lastFocus.current?.isConnected ? lastFocus.current : initialFocus.current ?? node).focus({ preventScroll: true });
    const remember = (event: FocusEvent) => {
      if (topSurface() !== node || !(event.target instanceof HTMLElement)) return;
      if (node.contains(event.target)) lastFocus.current = event.target;
      else if (!event.target.closest('[data-radix-popper-content-wrapper], [data-radix-select-viewport]')) {
        (lastFocus.current ?? initialFocus.current ?? node).focus({ preventScroll: true });
      }
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || topSurface() !== node) return;
      if (event.target instanceof Element && !node.contains(event.target) &&
        event.target.closest('[data-radix-popper-content-wrapper], [data-radix-select-viewport]')) return;
      if (event.key === 'Escape') {
        if (event.isComposing || event.keyCode === 229) return;
        event.preventDefault(); event.stopPropagation();
        if (!state.current.closeDisabled) state.current.onClose();
      } else if (event.key === 'Tab') {
        const controls = Array.from(node.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]'
        )).filter(element => element.getClientRects().length && !element.closest('[inert], [aria-hidden="true"]'));
        const first = controls[0], last = controls.at(-1), active = document.activeElement;
        if (!first || !last) { event.preventDefault(); return; }
        if (event.shiftKey && (active === first || !controls.includes(active as HTMLElement))) {
          event.preventDefault(); last.focus({ preventScroll: true });
        } else if (!event.shiftKey && (active === last || !node.contains(active))) {
          event.preventDefault(); first.focus({ preventScroll: true });
        }
      }
    };
    document.addEventListener('keydown', keydown, true);
    document.addEventListener('focusin', remember);
    return () => { document.removeEventListener('keydown', keydown, true); document.removeEventListener('focusin', remember); };
  }, [open, suspended, surface, initialFocus]);
}
