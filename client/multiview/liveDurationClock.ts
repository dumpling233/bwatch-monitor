export function durationText(start: number | null, now: number): string {
  if (!start || !Number.isFinite(start) || start < 0) return '—';
  const seconds = Math.max(0, Math.floor((now - (start < 1e12 ? start * 1000 : start)) / 1000));
  const hours = Math.floor(seconds / 3600);
  return `${hours ? `${String(hours).padStart(2, '0')}:` : ''}${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

interface DurationClock {
  now(): number;
  setInterval(callback: () => void, delay: number): number;
  clearInterval(handle: number): void;
}

/** Elapsed time comes from the broadcast start, so sleeping never loses time. */
export function subscribeLiveDurationClock(onNow: (now: number) => void,
  page: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'> = document,
  clock: DurationClock = {
    now: Date.now,
    setInterval: (callback, delay) => window.setInterval(callback, delay),
    clearInterval: handle => window.clearInterval(handle),
  }): () => void {
  let timer: number | undefined;
  const stop = () => {
    if (timer !== undefined) clock.clearInterval(timer);
    timer = undefined;
  };
  const updateVisibility = () => {
    stop();
    if (page.hidden) return;
    onNow(clock.now());
    timer = clock.setInterval(() => onNow(clock.now()), 1000);
  };
  page.addEventListener('visibilitychange', updateVisibility);
  updateVisibility();
  return () => {
    stop();
    page.removeEventListener('visibilitychange', updateVisibility);
  };
}
