export const overlayPageLimits = { comments: 480, roomComments: 80, stagePixels: 8_000_000, spritePixels: 8_000_000, maxDpr: 2 } as const;
interface Lease { active: number; waiting: number; sprites: number; stage: number; changed(): void }

/** Shared admission accounting for application-owned canvases, not a browser memory ceiling. */
export class OverlayResourceBudget {
  private readonly leases = new Map<object, Lease>();
  private active = 0;
  private waiting = 0;
  private sprites = 0;
  private stages = 0;
  register(changed: () => void): object {
    const key = {};
    this.leases.set(key, { active: 0, waiting: 0, sprites: 0, stage: 0, changed });
    for (const [other, lease] of this.leases) if (other !== key) lease.changed();
    return key;
  }
  capacity(key: object): number { return this.leases.has(key) ? Math.min(80, Math.floor(480 / Math.max(1, this.leases.size))) : 0; }
  waitingCapacity(key: object): number {
    const lease = this.leases.get(key);
    return lease ? Math.max(0, Math.min(this.capacity(key) - lease.active, 480 - this.active - this.waiting + lease.waiting)) : 0;
  }
  setWaiting(key: object, value: number): void {
    const lease = this.leases.get(key);
    if (!lease) return;
    const next = Math.max(0, Math.min(value, this.waitingCapacity(key)));
    this.waiting += next - lease.waiting; lease.waiting = next;
  }
  acquireSprite(key: object, pixels: number): boolean {
    const lease = this.leases.get(key);
    if (!lease || pixels <= 0 || lease.active >= this.capacity(key) || this.active >= 480 ||
      lease.sprites + pixels > Math.floor(overlayPageLimits.spritePixels / this.leases.size) || this.sprites + pixels > overlayPageLimits.spritePixels) return false;
    if (lease.waiting) { lease.waiting--; this.waiting--; }
    else if (this.active + this.waiting >= 480) return false;
    lease.active++; this.active++; lease.sprites += pixels; this.sprites += pixels;
    return true;
  }
  releaseSprite(key: object, pixels: number): void {
    const lease = this.leases.get(key);
    if (!lease || !lease.active) return;
    lease.active--; this.active--; lease.sprites -= pixels; this.sprites -= pixels;
  }
  stageSize(key: object, width: number, height: number, dpr: number): { width: number; height: number; ratio: number } {
    const lease = this.leases.get(key);
    if (!lease || width <= 0 || height <= 0) return { width: 0, height: 0, ratio: 1 };
    const pixels = Math.max(0, Math.min(Math.floor(overlayPageLimits.stagePixels / this.leases.size), overlayPageLimits.stagePixels - this.stages + lease.stage));
    const ratio = Math.min(overlayPageLimits.maxDpr, Math.max(0.1, dpr), Math.sqrt(pixels / (width * height)), 8192 / Math.max(width, height));
    const w = Math.floor(width * ratio), h = Math.floor(height * ratio);
    this.stages += w * h - lease.stage; lease.stage = w * h;
    return { width: w, height: h, ratio: width ? w / width : 1 };
  }
  releaseStage(key: object): void { const lease = this.leases.get(key); if (lease) { this.stages -= lease.stage; lease.stage = 0; } }
  unregister(key: object): void {
    const lease = this.leases.get(key);
    if (!lease) return;
    this.active -= lease.active; this.waiting -= lease.waiting; this.sprites -= lease.sprites; this.stages -= lease.stage;
    this.leases.delete(key);
    for (const current of this.leases.values()) current.changed();
  }
  stats() { return { rooms: this.leases.size, active: this.active, waiting: this.waiting, sprites: this.sprites, stages: this.stages }; }
}
export const overlayResources = new OverlayResourceBudget();
