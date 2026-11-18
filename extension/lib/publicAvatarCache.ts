type Storage = { get(keys: string[]): Promise<Record<string, unknown>>; set(values: Record<string, unknown>): Promise<void> };
type Avatar = { uid: string; face: string; fetchedAt: number; usedAt: number };
export const PUBLIC_AVATAR_CACHE_KEY = 'bwatchMonitorPublicAvatarCache';
export const PUBLIC_AVATAR_CACHE_LIMITS = Object.freeze({ freshMs: 86_400_000, idleMs: 86_400_000, entries: 2048, bytes: 2 * 1024 * 1024 });
const HEADER_BYTES = JSON.stringify({ schemaVersion: 1, rows: [] }).length * 2;
const bytes = (row: Avatar) => JSON.stringify(row).length * 2 + 2;
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const id = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
const image = (value: unknown): value is string => {
  if (typeof value !== 'string' || !value || value.length > 2048) return false;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash &&
    (url.hostname === 'hdslb.com' || url.hostname.endsWith('.hdslb.com')); } catch { return false; }
};

/** Public display hints only: no names, room roles, account evidence or images.
 * The extension shares this UID cache across rooms and tabs. Reads are O(1);
 * expiry and LRU eviction run on demand, never through a maintenance interval. */
export class PublicAvatarCache {
  private readonly rows = new Map<string, Avatar>();
  private readonly savedTouches = new Map<string, number>();
  private totalBytes = HEADER_BYTES;
  private generation = 0;
  private dirty = false;
  private timer?: ReturnType<typeof setTimeout>;
  private serial: Promise<unknown> = Promise.resolve();
  readonly ready: Promise<void>;
  constructor(private readonly storage: Storage | undefined, private readonly now = Date.now) { this.ready = this.restore(); }
  snapshot() { return { entries: this.rows.size, bytes: this.totalBytes }; }
  private remove(uid: string): void {
    const row = this.rows.get(uid); if (!row) return;
    this.totalBytes -= bytes(row); this.rows.delete(uid); this.savedTouches.delete(uid);
  }
  private insert(row: Avatar): void {
    this.remove(row.uid); this.rows.set(row.uid, row); this.totalBytes += bytes(row);
  }
  private async restore(): Promise<void> {
    const generation = this.generation;
    try {
      const raw = (await this.storage?.get([PUBLIC_AVATAR_CACHE_KEY]))?.[PUBLIC_AVATAR_CACHE_KEY];
      if (generation !== this.generation || raw === undefined) return;
      const source = object(raw);
      if (source.schemaVersion !== 1 || !Array.isArray(source.rows) || source.rows.length > PUBLIC_AVATAR_CACHE_LIMITS.entries ||
        JSON.stringify(source).length * 2 > PUBLIC_AVATAR_CACHE_LIMITS.bytes) { this.changed(); return; }
      const now = this.now(), restored: Avatar[] = [];
      for (const raw of source.rows) {
        const row = object(raw);
        if (!id(row.uid) || !image(row.face) || typeof row.fetchedAt !== 'number' || !Number.isFinite(row.fetchedAt) || row.fetchedAt < 0 || row.fetchedAt > now ||
          typeof row.usedAt !== 'number' || !Number.isFinite(row.usedAt) || row.usedAt < row.fetchedAt || row.usedAt > now ||
          row.fetchedAt + PUBLIC_AVATAR_CACHE_LIMITS.freshMs <= now || row.usedAt + PUBLIC_AVATAR_CACHE_LIMITS.idleMs <= now) continue;
        restored.push({ uid: row.uid, face: row.face, fetchedAt: row.fetchedAt, usedAt: row.usedAt });
      }
      for (const row of restored.sort((a, b) => a.usedAt - b.usedAt)) {
        const previous = this.rows.get(row.uid);
        if (previous && previous.fetchedAt >= row.fetchedAt) continue;
        this.insert(row); this.savedTouches.set(row.uid, row.usedAt);
      }
      this.trim();
      // Rewrite only projected fields; stale, duplicate or extra persisted data
      // must never turn into account/identity evidence after a worker restart.
      if (JSON.stringify(source) !== JSON.stringify(this.document())) this.changed();
    } catch { /* Optional display storage cannot block live chat. */ }
  }
  private trim(): void {
    const now = this.now();
    for (const [uid, row] of this.rows) {
      if (row.usedAt + PUBLIC_AVATAR_CACHE_LIMITS.idleMs > now) break;
      this.remove(uid); this.dirty = true;
    }
    while (this.rows.size > PUBLIC_AVATAR_CACHE_LIMITS.entries || this.totalBytes > PUBLIC_AVATAR_CACHE_LIMITS.bytes) {
      this.remove(this.rows.keys().next().value!); this.dirty = true;
    }
  }
  get(uid: string): { uid: string; face: string; avatarFetchedAt: number; avatarCacheHit: true } | undefined {
    this.trim();
    const row = this.rows.get(uid), now = this.now();
    if (row && (row.fetchedAt + PUBLIC_AVATAR_CACHE_LIMITS.freshMs <= now || row.usedAt > now)) { this.remove(uid); this.dirty = true; }
    else if (row) {
      const oldBytes = bytes(row);
      row.usedAt = now; this.totalBytes += bytes(row) - oldBytes;
      this.rows.delete(uid); this.rows.set(uid, row);
      this.trim();
      // Repeated messages do not cause repeated storage writes. Touches are
      // persisted at most hourly per UID, with all dirty rows written together.
      if (now - (this.savedTouches.get(uid) ?? 0) >= 3_600_000) { this.savedTouches.set(uid, now); this.changed(); }
      else if (this.dirty) this.changed();
      return { uid: row.uid, face: row.face, avatarFetchedAt: row.fetchedAt, avatarCacheHit: true };
    }
    if (this.dirty) this.changed();
    return undefined;
  }
  set(uid: string, face: string): number | undefined {
    if (!id(uid) || !image(face)) return;
    const now = this.now();
    this.insert({ uid, face, fetchedAt: now, usedAt: now }); this.savedTouches.set(uid, now);
    this.trim(); this.changed();
    return now;
  }
  private document() { return { schemaVersion: 1, rows: [...this.rows.values()].map(({ uid, face, fetchedAt, usedAt }) => ({ uid, face, fetchedAt, usedAt })) }; }
  private changed(): void {
    this.dirty = true;
    if (!this.storage || this.timer !== undefined) return;
    // A demand-triggered write debounce, not a periodic cache/network check.
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, 1000);
    this.timer.unref?.();
  }
  clear(): void {
    this.generation++;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined; this.rows.clear(); this.savedTouches.clear(); this.totalBytes = HEADER_BYTES;
    this.dirty = true; void this.flush();
  }
  async flush(): Promise<void> {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.dirty && this.storage) {
      this.dirty = false;
      const generation = this.generation;
      const task = async () => {
        if (generation !== this.generation) return;
        try { await this.storage!.set({ [PUBLIC_AVATAR_CACHE_KEY]: this.document() }); }
        catch { if (generation === this.generation) this.dirty = true; }
      };
      this.serial = this.serial.then(task, task);
    }
    await this.serial;
  }
}
