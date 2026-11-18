import { useEffect, useState, type RefObject } from 'react';

const IDLE_DELAY = 4000;
const OPEN_CONTROL = '.ui-select-content[data-state="open"], .mv-playback-quality-menu[data-open="true"], .mv-shortcut-volume-popover[data-state="open"][data-keep-controls="true"]';

/** Collapse only the chrome; player activation and saved sidebar state stay unchanged. */
export function useIdleControls(rootRef: RefObject<HTMLElement | null>, enabled: boolean, busy: boolean) {
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    setHidden(false);
    if (!enabled) return;
    let timer: number | undefined;
    let focusFrame: number | undefined;
    const pointers = new Set<number>();
    const clear = () => window.clearTimeout(timer);
    const cancelFocus = () => {
      if (focusFrame !== undefined) window.cancelAnimationFrame(focusFrame);
      focusFrame = undefined;
    };
    const protectedControl = () => busy || pointers.size > 0 || document.hidden
      || Boolean(document.querySelector(OPEN_CONTROL))
      || Boolean(rootRef.current?.querySelector('[data-keep-controls="true"], input:not([type="range"]):focus, textarea:focus, [contenteditable="true"]:focus, :focus-visible'));
    const checkIdle = () => {
      if (protectedControl()) { timer = window.setTimeout(checkIdle, IDLE_DELAY); return; }
      // Do not leave a mouse-focused control inside a subtree that is becoming inert.
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && rootRef.current?.contains(focused)
        && focused.closest('.mv-sidebar, .mv-sidebar-resizer, .mv-switchbar')) focused.blur();
      setHidden(true);
    };
    const wake = () => {
      clear();
      if (document.hidden) cancelFocus();
      setHidden(false);
      if (!document.hidden) timer = window.setTimeout(checkIdle, IDLE_DELAY);
    };
    const down = (event: PointerEvent) => { pointers.add(event.pointerId); wake(); };
    const up = (event: PointerEvent) => { pointers.delete(event.pointerId); wake(); };
    const blur = () => { pointers.clear(); wake(); };
    const keyboard = (event: KeyboardEvent) => {
      // Restore focus after inert is removed, keeping it inside a fullscreen tile.
      if (event.key === 'Tab' && rootRef.current?.dataset.controlsHidden === 'true') {
        event.preventDefault();
        cancelFocus();
        focusFrame = window.requestAnimationFrame(() => {
          focusFrame = undefined;
          const fullscreenElement = document.fullscreenElement;
          const region = fullscreenElement && fullscreenElement !== rootRef.current
            ? fullscreenElement : rootRef.current?.querySelector('.mv-sidebar');
          region?.querySelector<HTMLElement>('a[href], button:not(:disabled), input:not(:disabled), [tabindex="0"]')?.focus({ preventScroll: true });
        });
      }
      wake();
    };
    window.addEventListener('pointermove', wake, { passive: true });
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    window.addEventListener('keydown', keyboard, true);
    window.addEventListener('wheel', wake, { passive: true });
    window.addEventListener('blur', blur);
    document.addEventListener('focusin', wake);
    document.addEventListener('visibilitychange', wake);
    document.addEventListener('fullscreenchange', wake);
    wake();
    return () => {
      clear();
      cancelFocus();
      window.removeEventListener('pointermove', wake);
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      window.removeEventListener('keydown', keyboard, true);
      window.removeEventListener('wheel', wake);
      window.removeEventListener('blur', blur);
      document.removeEventListener('focusin', wake);
      document.removeEventListener('visibilitychange', wake);
      document.removeEventListener('fullscreenchange', wake);
    };
  }, [enabled, busy, rootRef]);

  return enabled && !busy && hidden;
}
