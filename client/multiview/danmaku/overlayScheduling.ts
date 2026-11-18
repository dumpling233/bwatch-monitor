export const MAX_OVERLAY_COMMENTS = 80;
export const OVERLAY_MAX_WAIT_MS = 1500;
export const OVERLAY_RETRY_MS = 50;

export interface MovingDanmaku {
  _utc: number;
  width: number;
  height: number;
  y: number;
}

/** Coordinates and time use the pinned canvas engine's CSS pixels / seconds. */
export function findSafeDanmakuY(
  stage: { width: number; height: number; duration: number; now: number; gap: number; topInset?: number; bottomInset?: number },
  incoming: { width: number; height: number },
  running: readonly MovingDanmaku[],
): number | undefined {
  const { width, height, duration, now, gap, topInset = 0, bottomInset = 0 } = stage;
  if (!(width > 0 && height > 0 && duration > 0 && incoming.height > 0) || incoming.height > height) return;
  const speed = (width + incoming.width) / duration;
  for (let y = topInset; y + incoming.height <= height - bottomInset; y += incoming.height + 2) {
    const safe = running.every(previous => {
      const age = Math.max(0, now - previous._utc);
      if (age >= duration || previous.y + previous.height <= y || y + incoming.height <= previous.y) return true;
      const previousSpeed = (width + previous.width) / duration;
      // The gap is linear over time: check both entry and the moment the old
      // comment exits. Long new comments move faster and must not catch up.
      const entryGap = previousSpeed * age - previous.width;
      const exitGap = width - speed * (duration - age);
      return entryGap >= gap && exitGap >= gap;
    });
    if (safe) return y;
  }
}

/** Text only: waiting for a lane never allocates a comment bitmap. */
export class OverlayQueue<T> {
  private items: { value: T; at: number }[] = [];
  get size(): number { return this.items.length; }
  clear(): void { this.items.length = 0; }
  peek(now: number): T | undefined {
    while (this.items.length && now - this.items[0].at >= OVERLAY_MAX_WAIT_MS) this.items.shift();
    return this.items[0]?.value;
  }
  shift(): void { this.items.shift(); }
  push(values: readonly T[], activeCount: number, now: number, roomCapacity = MAX_OVERLAY_COMMENTS): void {
    this.peek(now);
    const capacity = Math.max(0, Math.min(MAX_OVERLAY_COMMENTS, roomCapacity) - activeCount);
    for (const value of values) {
      if (!capacity) break;
      if (this.items.length >= capacity) this.items.shift();
      this.items.push({ value, at: now });
    }
    if (this.items.length > capacity) this.items.splice(0, this.items.length - capacity);
  }
}
