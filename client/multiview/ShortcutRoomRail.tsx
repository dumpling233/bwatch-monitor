import React, { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

const EDGE_HINT_DISTANCE = 40;
const EDGE_BUTTON_WIDTH = 24;
const SCROLL_PIXELS_PER_MS = 0.48;
const EDGE_TOLERANCE = 1;
const edges = [
  { side: 'left', step: -1, label: '向左滚动房间音量列表', Icon: ChevronLeft },
  { side: 'right', step: 1, label: '向右滚动房间音量列表', Icon: ChevronRight },
] as const;

export function ShortcutRoomRail({ children, hidden }: { children: ReactNode; hidden: boolean }) {
  const railRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [hint, setHint] = useState<'left' | 'right' | null>(null);

  useLayoutEffect(() => {
    setHint(null);
    const rail = railRef.current;
    const viewport = viewportRef.current;
    const track = trackRef.current;
    if (hidden || !rail || !viewport || !track) return;

    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let pointer: { x: number; y: number } | null = null;
    let frame = 0;
    let lastFrameAt = 0;
    let step = 0;

    const stop = () => {
      if (frame) cancelAnimationFrame(frame);
      if (step) delete rail.dataset.keepControls;
      frame = 0;
      lastFrameAt = 0;
      step = 0;
    };

    const update = () => {
      const bounds = rail.getBoundingClientRect();
      const fromLeft = pointer ? pointer.x - bounds.left : -1;
      const fromRight = bounds.width - fromLeft;
      const inside = pointer && fromLeft >= 0 && fromRight >= 0 && pointer.y >= bounds.top && pointer.y < bounds.bottom;
      const edge = fromLeft < fromRight ? edges[0] : edges[1];
      const distance = Math.min(fromLeft, fromRight);
      const remaining = edge.side === 'left' ? viewport.scrollLeft : viewport.scrollWidth - viewport.clientWidth - viewport.scrollLeft;
      const showHint = Boolean(inside && distance <= EDGE_HINT_DISTANCE && remaining > EDGE_TOLERANCE);
      setHint(showHint ? edge.side : null);
      if (showHint && distance <= Math.min(EDGE_BUTTON_WIDTH, bounds.width / 2) && !motion.matches) {
        if (!step) rail.dataset.keepControls = 'true';
        step = edge.step;
        if (!frame) frame = requestAnimationFrame(advance);
      } else stop();
    };

    const advance = (time: number) => {
      frame = 0;
      const elapsed = lastFrameAt ? Math.min(time - lastFrameAt, 32) : 16;
      lastFrameAt = time;
      const maxScroll = viewport.scrollWidth - viewport.clientWidth;
      const remaining = step < 0 ? viewport.scrollLeft : maxScroll - viewport.scrollLeft;
      const distance = Math.max(1, elapsed * SCROLL_PIXELS_PER_MS);
      viewport.scrollLeft = remaining <= distance + EDGE_TOLERANCE
        ? (step < 0 ? 0 : maxScroll)
        : viewport.scrollLeft + step * distance;
      update();
    };

    const move = (event: PointerEvent) => {
      pointer = event.pointerType === 'mouse' && event.buttons === 0 ? { x: event.clientX, y: event.clientY } : null;
      update();
    };
    const reset = () => {
      pointer = null;
      stop();
      setHint(null);
    };

    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    observer.observe(track);
    rail.addEventListener('pointermove', move);
    rail.addEventListener('pointerleave', reset);
    rail.addEventListener('pointercancel', reset);
    viewport.addEventListener('scroll', update, { passive: true });
    motion.addEventListener('change', update);
    document.addEventListener('visibilitychange', reset);
    document.addEventListener('fullscreenchange', reset);
    window.addEventListener('blur', reset);
    window.addEventListener('pagehide', reset);
    return () => {
      stop();
      observer.disconnect();
      rail.removeEventListener('pointermove', move);
      rail.removeEventListener('pointerleave', reset);
      rail.removeEventListener('pointercancel', reset);
      viewport.removeEventListener('scroll', update);
      motion.removeEventListener('change', update);
      document.removeEventListener('visibilitychange', reset);
      document.removeEventListener('fullscreenchange', reset);
      window.removeEventListener('blur', reset);
      window.removeEventListener('pagehide', reset);
    };
  }, [hidden]);

  return <div className="mv-shortcut-room-rail" ref={railRef}>
    <div className="mv-shortcut-rooms" ref={viewportRef}>
      <div className="mv-shortcut-room-track" ref={trackRef}>{children}</div>
    </div>
    {edges.map(({ side, step, label, Icon }) => {
      const visible = !hidden && hint === side;
      return <button key={side} type="button" className={`mv-shortcut-scroll-edge mv-shortcut-scroll-${side}`}
        aria-label={label} data-visible={visible} disabled={!visible} aria-hidden={!visible} tabIndex={-1}
        onPointerDown={event => event.preventDefault()}
        onClick={() => {
          const viewport = viewportRef.current;
          if (viewport) viewport.scrollLeft += step * viewport.clientWidth * 0.75;
        }}><Icon size={16} aria-hidden="true" /></button>;
    })}
  </div>;
}
