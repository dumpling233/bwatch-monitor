import { CUSTOM_ROOM_STALE_MS, mergeCustomRoom, staleCustomRoom, type CustomRoomRecord } from './customRooms';

export const CUSTOM_SELECTED_REFRESH_MS = 30_000;
export const CUSTOM_CANDIDATE_REFRESH_MS = 60_000;
export const CUSTOM_BACKGROUND_REFRESH_MS = 120_000;
export const CUSTOM_REQUEST_SPACING_MS = 2_200;
const MAX_CONCURRENT = 2;
const MAX_RETRY_MS = 300_000;

interface RefreshEntry {
  room: CustomRoomRecord;
  selected: boolean;
  demanded: boolean;
  finishedAt?: number;
  notBefore: number;
  failures: number;
  controller?: AbortController;
}

interface RefreshOptions {
  resolve: (input: string, signal: AbortSignal) => Promise<CustomRoomRecord>;
  onResult: (roomId: string, room: CustomRoomRecord) => void;
  now?: () => number;
  setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

/** One scheduler per monitor page: metadata only, independent of video/WSS instances. */
export class CustomRoomRefreshScheduler {
  private readonly entries = new Map<string, RefreshEntry>();
  private readonly now: () => number;
  private readonly setTimer: NonNullable<RefreshOptions['setTimer']>;
  private readonly clearTimer: NonNullable<RefreshOptions['clearTimer']>;
  private timer?: ReturnType<typeof setTimeout>;
  private hidden = false;
  private online = true;
  private destroyed = false;
  private active = 0;
  private nextLaunchAt = 0;

  constructor(private readonly options: RefreshOptions) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
    this.clearTimer = options.clearTimer ?? (timer => clearTimeout(timer));
  }

  sync(rooms: readonly CustomRoomRecord[], selectedIds: ReadonlySet<string>, demandedIds?: ReadonlySet<string>): void {
    if (this.destroyed) return;
    const ids = new Set(rooms.map(room => room.roomId));
    for (const [roomId, entry] of this.entries) {
      if (!ids.has(roomId)) {
        this.entries.delete(roomId);
        entry.controller?.abort();
      }
    }
    for (const room of rooms) {
      const entry = this.entries.get(room.roomId);
      const demanded = demandedIds === undefined || demandedIds.has(room.roomId);
      if (entry) {
        entry.room = room;
        entry.selected = selectedIds.has(room.roomId);
        entry.demanded = demanded;
        // Keep completed observations/backoff while a card leaves the viewport.
        // An aborted transport still occupies its slot until it actually settles.
        if (!demanded) entry.controller?.abort();
      } else {
        this.entries.set(room.roomId, { room, selected: selectedIds.has(room.roomId), demanded, notBefore: 0, failures: 0 });
      }
    }
    this.schedule();
  }

  setHidden(hidden: boolean): void {
    if (this.destroyed || this.hidden === hidden) return;
    this.hidden = hidden;
    this.schedule();
  }

  setOnline(online: boolean): void {
    if (this.destroyed || this.online === online) return;
    this.online = online;
    if (!online) for (const entry of this.entries.values()) entry.controller?.abort();
    // Entries retain their sample times and upstream cooldown. Reconnection
    // resumes current demand once; it never replays missed refresh periods.
    this.schedule();
  }

  destroy(): void {
    this.destroyed = true;
    this.cancelTimer();
    for (const entry of this.entries.values()) entry.controller?.abort();
    this.entries.clear();
  }

  private dueAt(entry: RefreshEntry): number {
    const interval = this.hidden ? CUSTOM_BACKGROUND_REFRESH_MS
      : entry.selected ? CUSTOM_SELECTED_REFRESH_MS : CUSTOM_CANDIDATE_REFRESH_MS;
    return Math.max(entry.notBefore, entry.finishedAt === undefined ? 0 : entry.finishedAt + interval);
  }

  private cancelTimer(): void {
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
  }

  private expiresAt(entry: RefreshEntry): number {
    const { room } = entry;
    const online = room.online !== null && room.onlineLastSuccessAt !== undefined
      ? room.onlineLastSuccessAt + CUSTOM_ROOM_STALE_MS + 1 : Infinity;
    const metadata = room.status !== 'unknown' && room.metadataFetchedAt !== null
      ? room.metadataFetchedAt + CUSTOM_ROOM_STALE_MS + 1 : Infinity;
    return Math.min(online, metadata);
  }

  private expireValues(): void {
    const now = this.now();
    for (const [roomId, entry] of this.entries) {
      if (!entry.demanded || this.expiresAt(entry) > now) continue;
      entry.room = mergeCustomRoom(undefined, entry.room, now);
      this.options.onResult(roomId, entry.room);
    }
  }

  private schedule(): void {
    this.cancelTimer();
    if (this.destroyed) return;
    let networkDue = Infinity, expiry = Infinity;
    for (const entry of this.entries.values()) {
      if (!entry.demanded) continue;
      expiry = Math.min(expiry, this.expiresAt(entry));
      if (this.online && this.active < MAX_CONCURRENT && !entry.controller) networkDue = Math.min(networkDue, this.dueAt(entry));
    }
    const earliest = Math.min(expiry, Math.max(networkDue, this.nextLaunchAt));
    if (!Number.isFinite(earliest)) return;
    this.timer = this.setTimer(() => { this.timer = undefined; this.pump(); },
      Math.max(0, earliest - this.now()));
  }

  private pump(): void {
    if (this.destroyed) return;
    this.expireValues();
    if (!this.online) { this.schedule(); return; }
    if (this.active >= MAX_CONCURRENT) { this.schedule(); return; }
    const now = this.now();
    if (now < this.nextLaunchAt) { this.schedule(); return; }
    // Prioritize overdue selected rooms, then the oldest candidate; no backfill bursts.
    const pending = [...this.entries.entries()].filter(([, entry]) => entry.demanded && !entry.controller && this.dueAt(entry) <= now)
      .sort(([, a], [, b]) => Number(b.selected) - Number(a.selected) || this.dueAt(a) - this.dueAt(b));
    const next = pending[0];
    if (!next) { this.schedule(); return; }
    const [roomId, entry] = next;
    const controller = new AbortController();
    entry.controller = controller;
    this.active++;
    this.nextLaunchAt = now + CUSTOM_REQUEST_SPACING_MS;
    const isCurrent = () => !this.destroyed && entry.demanded && !controller.signal.aborted && this.entries.get(roomId) === entry;
    const finish = (room: CustomRoomRecord, failed: boolean, retryAfterMs = 0) => {
      if (!isCurrent()) return;
      entry.finishedAt = this.now();
      entry.failures = failed ? Math.min(entry.failures + 1, 5) : 0;
      entry.notBefore = entry.finishedAt + Math.max(retryAfterMs,
        failed ? Math.min(MAX_RETRY_MS, CUSTOM_SELECTED_REFRESH_MS * 2 ** (entry.failures - 1)) : 0);
      entry.room = mergeCustomRoom(entry.room, room, this.now());
      this.options.onResult(roomId, entry.room);
    };
    void Promise.resolve().then(() => {
      if (!isCurrent()) throw new DOMException('Aborted', 'AbortError');
      // User input may be a short alias which later points at another room.
      // Periodic refresh follows the already verified canonical identity only.
      return this.options.resolve(roomId, controller.signal);
    }).then(room => {
      if (room.roomId !== roomId) {
        finish(staleCustomRoom(entry.room, '直播间房号与当前记录不一致，请重新添加', this.now()), true, room.retryAfterMs ?? 0);
        return;
      }
      finish(room, room.metadataStale || room.onlineStale, room.retryAfterMs ?? 0);
    }, error => {
      const retryAfterMs = typeof error?.retryAfterMs === 'number' && Number.isFinite(error.retryAfterMs) ? Math.max(0, error.retryAfterMs) : 0;
      finish(staleCustomRoom(entry.room, error instanceof Error ? error.message : '房间信息刷新失败', this.now()), true, retryAfterMs);
    }).finally(() => {
      this.active--;
      if (entry.controller === controller) entry.controller = undefined;
      this.schedule();
    });
    this.schedule();
  }
}
