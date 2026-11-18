import React, { useCallback, useEffect, useRef, useState } from 'react';

const SCROLL_SPEED = 8.5;
const ENDPOINT_PAUSE_MS = 3000;

/** One copy of any inline content, moving only by its actual overflow. */
export function OverflowMarquee({ contentKey, children, className = '', trackClassName = '', ...props }:
  React.HTMLAttributes<HTMLSpanElement> & { contentKey: string; trackClassName?: string }) {
  const containerRef = useRef<HTMLSpanElement>(null);
  const trackRef = useRef<HTMLSpanElement>(null);
  const pauseRef = useRef<number | null>(null);
  const [shift, setShift] = useState(0);
  useEffect(() => {
    const container = containerRef.current, track = trackRef.current;
    if (!container || !track) return;
    const measure = () => setShift(previous => {
      const next = Math.min(0, container.clientWidth - track.scrollWidth);
      return previous === next ? previous : next;
    });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(container); observer.observe(track);
    return () => observer.disconnect();
  }, [contentKey, shift]);
  const overflowing = shift < -1;
  const pause = useCallback(() => {
    const track = trackRef.current;
    if (!track) return;
    track.style.animationPlayState = 'paused';
    if (pauseRef.current !== null) window.clearTimeout(pauseRef.current);
    pauseRef.current = window.setTimeout(() => {
      if (trackRef.current === track) track.style.animationPlayState = 'running';
      pauseRef.current = null;
    }, ENDPOINT_PAUSE_MS);
  }, []);
  useEffect(() => () => {
    if (pauseRef.current !== null) window.clearTimeout(pauseRef.current);
    pauseRef.current = null;
    if (trackRef.current) trackRef.current.style.animationPlayState = '';
  }, [contentKey, shift, overflowing]);
  return <span {...props} ref={containerRef} className={`overflow-marquee ${className}${overflowing ? ' is-overflowing' : ''}`.trim()}
    style={{ ...props.style, '--room-title-shift': `${shift}px`, '--room-title-duration': overflowing ? `${(Math.abs(shift) / SCROLL_SPEED).toFixed(2)}s` : '0s' } as React.CSSProperties}>
    <span key={`${contentKey}:${shift}`} ref={trackRef} className={`overflow-marquee-track ${trackClassName}`.trim()} onAnimationIteration={pause}>{children}</span>
  </span>;
}
