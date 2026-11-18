import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';

type Frame = { element: HTMLElement; left: number; top: number; width: number; height: number; opacity: number; visible: boolean };
type Frames = Map<string, Frame>;
const easing = 'cubic-bezier(.22,1,.36,1)';
const duration = 280;
const exitProperties = ['--mv-exit-left', '--mv-exit-top', '--mv-exit-width', '--mv-exit-height'];

function measure(root: HTMLElement | null, layoutOnly = false): Frames {
  const frames: Frames = new Map();
  root?.querySelectorAll<HTMLElement>('[data-mv-motion]').forEach(element => {
    if (layoutOnly && element.dataset.visible === 'false') return;
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height || !element.getClientRects().length) return;
    const opacity = Number(window.getComputedStyle(element).opacity);
    frames.set(element.dataset.mvMotion!, { element, left: rect.left, top: rect.top, width: rect.width, height: rect.height,
      opacity: Number.isFinite(opacity) ? opacity : 1, visible: element.dataset.visible !== 'false' });
  });
  return frames;
}

/** Read destination geometry without feeding our presentation transforms back
 * into the next FLIP. Important inline values override WAAPI only while this
 * synchronous measurement runs; the browser never paints the temporary values. */
function measureLayout(root: HTMLElement | null, animations: Map<HTMLElement, Animation>): Frames {
  const restored: Array<{ element: HTMLElement; transform: string; transformPriority: string; opacity: string; opacityPriority: string }> = [];
  for (const element of animations.keys()) {
    restored.push({ element, transform: element.style.getPropertyValue('transform'), transformPriority: element.style.getPropertyPriority('transform'),
      opacity: element.style.getPropertyValue('opacity'), opacityPriority: element.style.getPropertyPriority('opacity') });
    element.style.setProperty('transform', 'none', 'important');
    element.style.setProperty('opacity', '1', 'important');
  }
  try { return measure(root, true); }
  finally {
    for (const { element, transform, transformPriority, opacity, opacityPriority } of restored) {
      if (transform) element.style.setProperty('transform', transform, transformPriority); else element.style.removeProperty('transform');
      if (opacity) element.style.setProperty('opacity', opacity, opacityPriority); else element.style.removeProperty('opacity');
    }
  }
}

function geometryChanged(first: Frames, last: Frames): boolean {
  if (first.size !== last.size) return true;
  for (const [id, frame] of last) {
    const before = first.get(id);
    if (!before || before.element !== frame.element || before.visible !== frame.visible
      || Math.abs(before.left - frame.left) >= .5 || Math.abs(before.top - frame.top) >= .5
      || Math.abs(before.width - frame.width) >= .5 || Math.abs(before.height - frame.height) >= .5) return true;
  }
  return false;
}

function clearPresentation(element: HTMLElement) {
  delete element.dataset.mvAnimating;
  delete element.dataset.mvMotionPhase;
  delete element.dataset.mvExiting;
  exitProperties.forEach(property => element.style.removeProperty(property));
}

function animateFrames(
  root: HTMLElement | null,
  first: Frames,
  last: Frames,
  animations: Map<HTMLElement, Animation>,
  reduced: boolean,
  onSettled: () => void,
) {
  if (!root || reduced) return;
  const resizingSidebar = root.classList.contains('mv-sidebar-resizing');
  const play = (element: HTMLElement, phase: 'enter' | 'move' | 'exit', keyframes: Keyframe[]) => {
    const animation = element.animate(keyframes, { duration, easing, fill: 'both' });
    element.dataset.mvAnimating = 'true';
    element.dataset.mvMotionPhase = phase;
    animations.set(element, animation);
    void animation.finished.then(() => {
      if (animations.get(element) !== animation) return;
      animations.delete(element);
      animation.cancel();
      clearPresentation(element);
      if (!animations.size) onSettled();
    }, () => {});
  };

  for (const [id, frame] of last) {
    const { element } = frame;
    // Scaling the stage also scales every player and changes the containing
    // block of its fixed drag source. Animate the individual tiles instead.
    // Continuous container resizing belongs to CSS Grid, not per-player FLIP.
    // This function runs only for discrete layout/slot changes.
    if (id === 'stage' || (resizingSidebar && (id === 'sidebar' || id === 'sidebar-resizer'))
      || element.dataset.mvDragging === 'true' || typeof element.animate !== 'function') continue;
    let ancestor = element.parentElement?.closest<HTMLElement>('[data-mv-motion]');
    let carried = false;
    while (ancestor) {
      if (animations.has(ancestor)) { carried = true; break; }
      ancestor = ancestor.parentElement?.closest<HTMLElement>('[data-mv-motion]');
    }
    if (carried) continue;
    const recorded = first.get(id);
    const before = recorded?.element === element ? recorded : undefined;
    const x = before ? before.left - frame.left : 0;
    const y = before ? before.top - frame.top : 0;
    const scaleX = before ? before.width / frame.width : .97;
    const scaleY = before ? before.height / frame.height : .97;
    if (before && Math.abs(x) < .5 && Math.abs(y) < .5 && Math.abs(scaleX - 1) < .005 && Math.abs(scaleY - 1) < .005 && before.opacity >= .995) continue;
    play(element, before?.visible ? 'move' : 'enter', [
      { transform: `translate(${x}px, ${y}px) scale(${scaleX}, ${scaleY})`, transformOrigin: '0 0', opacity: before?.opacity ?? 0 },
      { transform: 'none', transformOrigin: '0 0', opacity: 1 },
    ]);
  }

  for (const [id, frame] of first) {
    const { element } = frame;
    if (last.has(id) || !root.contains(element) || element.dataset.visible !== 'false'
      || element.dataset.mvDragging === 'true' || typeof element.animate !== 'function') continue;
    element.style.setProperty('--mv-exit-left', `${frame.left}px`);
    element.style.setProperty('--mv-exit-top', `${frame.top}px`);
    element.style.setProperty('--mv-exit-width', `${frame.width}px`);
    element.style.setProperty('--mv-exit-height', `${frame.height}px`);
    element.dataset.mvExiting = 'true';
    play(element, 'exit', [
      { transform: 'none', transformOrigin: '0 0', opacity: frame.opacity },
      { transform: `translate(${frame.width * .02}px, ${frame.height * .02}px) scale(.96)`, transformOrigin: '0 0', opacity: 0 },
    ]);
  }
}

/** Animate geometry, never replace the live media nodes that occupy it. */
export function usePanelMotion(rootRef: RefObject<HTMLElement | null>, motionKey: string, geometryKey = '') {
  const previous = useRef<Frames>(new Map());
  const captured = useRef<Frames | null>(null);
  const expiryFrame = useRef<number | null>(null);
  const animations = useRef(new Map<HTMLElement, Animation>());
  const mounted = useRef(false);
  const committedMotionKey = useRef(motionKey);
  const reduced = useRef(typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  const cancelAnimations = useCallback(() => {
    for (const [element, animation] of animations.current) {
      animation.cancel();
      clearPresentation(element);
    }
    animations.current.clear();
  }, []);

  const captureLayout = useCallback(() => {
    // Keep a running animation intact until React commits. A capture without a
    // layout change must not snap the current transition to its destination.
    captured.current = measure(rootRef.current);
    if (expiryFrame.current !== null) window.cancelAnimationFrame(expiryFrame.current);
    expiryFrame.current = window.requestAnimationFrame(() => {
      expiryFrame.current = null;
      captured.current = null;
    });
  }, [rootRef]);

  useLayoutEffect(() => {
    const intentionalChange = committedMotionKey.current !== motionKey;
    committedMotionKey.current = motionKey;
    const first = captured.current ?? (animations.current.size ? measure(rootRef.current) : previous.current);
    captured.current = null;
    if (expiryFrame.current !== null) window.cancelAnimationFrame(expiryFrame.current);
    expiryFrame.current = null;
    const destination = measureLayout(rootRef.current, animations.current);
    if (mounted.current && !geometryChanged(previous.current, destination)) return;
    cancelAnimations();
    const last = measure(rootRef.current, true);
    previous.current = last;
    if (!mounted.current) { mounted.current = true; return; }
    // Adaptive row/column changes caused only by canvas resizing settle
    // directly. Dragging, template/mode switches and focus remain animated.
    if (reduced.current || !intentionalChange) return;

    animateFrames(rootRef.current, first, last, animations.current, reduced.current, () => { previous.current = measure(rootRef.current, true); });
  }, [motionKey, geometryKey, cancelAnimations, rootRef]);

  useLayoutEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updatePreference = () => {
      reduced.current = preference.matches;
      if (preference.matches) {
        cancelAnimations();
        previous.current = measure(rootRef.current, true);
      }
    };
    const resetPresentation = () => {
      if (expiryFrame.current !== null) window.cancelAnimationFrame(expiryFrame.current);
      expiryFrame.current = null;
      captured.current = null;
      cancelAnimations();
      previous.current = measure(rootRef.current, true);
    };
    const updateVisibility = () => { if (document.hidden) resetPresentation(); };
    const containerTransition = (event: TransitionEvent) => {
      const target = event.target;
      // If resizing interrupts a slot/focus animation, finish that presentation
      // once before the CSS resize starts. Never restart it on every frame.
      if (target instanceof HTMLElement && (
        target.classList.contains('mv-sidebar') && event.propertyName === 'width'
        || target.classList.contains('mv-switchbar') && event.propertyName === 'height'
      )) resetPresentation();
    };
    const root = rootRef.current;
    preference.addEventListener('change', updatePreference);
    document.addEventListener('visibilitychange', updateVisibility);
    window.addEventListener('resize', resetPresentation);
    root?.addEventListener('transitionrun', containerTransition);
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => {
      // Sidebar/shortcut CSS transitions and native window resizing already
      // resize every grid track together. Starting a 280ms FLIP on each RO
      // delivery makes differently-sized tiles chase moving destinations and
      // tears their shared edges. Only remember the settled layout here;
      // structural changes are animated once by the motionKey effect above.
      if (root?.classList.contains('mv-sidebar-resizing') && animations.current.size) cancelAnimations();
      if (!captured.current && mounted.current && !animations.current.size) previous.current = measure(rootRef.current, true);
    }) : null;
    if (rootRef.current) observer?.observe(rootRef.current);
    const grid = rootRef.current?.querySelector('[data-testid="multiview-grid"]');
    if (grid) observer?.observe(grid);
    return () => {
      mounted.current = false;
      preference.removeEventListener('change', updatePreference);
      document.removeEventListener('visibilitychange', updateVisibility);
      window.removeEventListener('resize', resetPresentation);
      root?.removeEventListener('transitionrun', containerTransition);
      observer?.disconnect();
      if (expiryFrame.current !== null) window.cancelAnimationFrame(expiryFrame.current);
      captured.current = null;
      cancelAnimations();
    };
  }, [cancelAnimations, rootRef]);

  return { captureLayout };
}
