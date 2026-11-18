import type { LiveStatus, MonitorRoomDescriptor } from '../../shared/types';

export const CUSTOM_ROOMS_STORAGE_KEY = 'bwatch-monitor:custom-rooms:v1';
export const CUSTOM_ROOM_STALE_MS = 10 * 60_000;
const ROOM_ID_PATTERN = /^[1-9]\d{0,19}$/;
const REQUEST_TIMEOUT_MS = 8_000;
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const optionalString = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const optionalNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())) {
    const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};
const nonNegative = (value: unknown) => { const number = optionalNumber(value); return number !== null && number >= 0 ? number : null; };
const viewerCount = (value: unknown) => { const number = optionalNumber(value); return number !== null && Number.isSafeInteger(number) && number >= 0 ? number : null; };
const timestamp = (value: unknown) => { const number = optionalNumber(value); return number !== null && number > 0 ? number : null; };
const canonicalId = (value: unknown): string | null => typeof value === 'string' && ROOM_ID_PATTERN.test(value) ? value
  : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : null;
const statusValue = (value: unknown): LiveStatus => value === 1 || value === '1' || value === 'live' ? 'live'
  : value === 0 || value === '0' || value === 'offline' ? 'offline' : 'unknown';
const coverValue = (value: unknown) => {
  const text = optionalString(value); if (!text) return undefined;
  try { const url = new URL(text); return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined; } catch { return undefined; }
};

export interface CustomRoomRecord extends MonitorRoomDescriptor {
  source: 'custom'; input: string;
  /** Runtime-only cooldown hint. Never persisted alongside room metadata. */
  retryAfterMs?: number;
}
export interface RoomInputResult { roomId: string; input: string }

/** Only room IDs and B站 live URLs are accepted, never an arbitrary proxy target. */
export function parseMonitorRoomInput(value: string): RoomInputResult | null {
  const input = value.trim();
  if (!input) return null;
  if (ROOM_ID_PATTERN.test(input)) return { roomId: input, input };
  try {
    const url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port
      || !['live.bilibili.com', 'www.live.bilibili.com'].includes(url.hostname)) return null;
    const match = url.pathname.match(/^\/(?:blanc\/|h5\/)?([1-9]\d{0,19})(?:\/|$)/i);
    return match ? { roomId: match[1], input } : null;
  } catch { return null; }
}

function descriptorFromPayload(payload: unknown, fallbackId: string, input: string, now: number, trustedOnline: boolean): CustomRoomRecord | null {
  if (!isRecord(payload)) return null;
  const data = isRecord(payload.data) ? payload.data : payload;
  const byId = isRecord(data.by_room_ids) ? data.by_room_ids : {};
  const value = isRecord(byId[fallbackId]) ? byId[fallbackId] : data;
  const raw = isRecord(value) ? value : data;
  const roomBlock = isRecord(raw.room_info) ? raw.room_info : raw;
  const room = isRecord(roomBlock.live_info) ? { ...roomBlock, ...roomBlock.live_info } : roomBlock;
  const anchorBlock = isRecord(raw.anchor_info) ? raw.anchor_info : isRecord(raw.anchor) ? raw.anchor : {};
  const anchor = isRecord(anchorBlock.base_info) ? { ...anchorBlock, ...anchorBlock.base_info } : anchorBlock;
  const roomId = canonicalId(room.roomId ?? room.room_id ?? room.roomid ?? raw.roomId) ?? fallbackId;
  const name = optionalString(anchor.uname ?? anchor.name ?? raw.anchorName ?? raw.uname) ?? '';
  const title = optionalString(room.title ?? raw.title) ?? '';
  const cover = coverValue(room.cover ?? room.keyframe ?? room.user_cover ?? raw.cover);
  const status = statusValue(room.live_status ?? room.status ?? raw.live_status ?? raw.status);
  if (!name && !title && !cover && status === 'unknown') return null;
  const rawLiveStart = timestamp(room.live_time ?? room.live_start_time ?? room.liveStartTime);
  const liveStartTime = trustedOnline ? timestamp(raw.liveStartTime)
    : rawLiveStart ? rawLiveStart > 10_000_000_000 ? rawLiveStart : rawLiveStart * 1000 : null;
  // Base-room online fields are heat/popularity. Only the JSON service or onlineNum is a count.
  const online = trustedOnline ? viewerCount(raw.online) : null;
  const metadataFetchedAt = trustedOnline && 'metadataFetchedAt' in raw ? timestamp(raw.metadataFetchedAt) : now;
  return {
    source: 'custom', input, roomId, uid: nonNegative(anchor.uid ?? anchor.mid ?? raw.uid ?? raw.mid),
    anchorName: name || `房间 ${roomId}`, title: title || (status === 'live' ? '直播中' : 'B站直播间'), cover, status,
    online, onlineStale: trustedOnline ? raw.onlineStale === true || (status === 'live' && online === null) : status === 'live',
    ...(trustedOnline && online !== null ? { onlineLastSuccessAt: timestamp(raw.onlineLastSuccessAt)
      ?? (raw.onlineStale !== true ? metadataFetchedAt ?? now : undefined) } : {}),
    ...(trustedOnline && optionalString(raw.onlineError) ? { onlineError: optionalString(raw.onlineError) } : {}),
    fansCount: null, fansStale: false, guardCount: null, guardStale: false, liveStartTime,
    lastUpdatedAt: now, metadataFetchedAt, metadataStale: trustedOnline && raw.metadataStale === true,
    ...(trustedOnline && optionalString(raw.metadataError) ? { metadataError: optionalString(raw.metadataError) } : {}),
  };
}

function usableOnline(room: CustomRoomRecord, now: number): boolean {
  return room.online !== null && Number.isSafeInteger(room.online) && room.online >= 0
    && typeof room.onlineLastSuccessAt === 'number' && now >= room.onlineLastSuccessAt
    && now - room.onlineLastSuccessAt <= CUSTOM_ROOM_STALE_MS;
}

/** Merge a partial refresh without extending the age of old status or viewer counts. */
export function mergeCustomRoom(previous: CustomRoomRecord | undefined, next: CustomRoomRecord, now = Date.now()): CustomRoomRecord {
  const merged = { ...next, lastUpdatedAt: now };
  const sameRoom = previous?.roomId === next.roomId ? previous : undefined;
  const metadataAge = next.metadataFetchedAt === null ? Infinity : now - next.metadataFetchedAt;
  if (next.metadataStale && sameRoom) {
    merged.anchorName = sameRoom.anchorName; merged.title = sameRoom.title;
    merged.cover = sameRoom.cover; merged.uid = sameRoom.uid;
  }
  if ((next.metadataStale || metadataAge < 0 || metadataAge > CUSTOM_ROOM_STALE_MS) && sameRoom) {
    const previousAge = sameRoom.metadataFetchedAt === null ? Infinity : now - sameRoom.metadataFetchedAt;
    if (previousAge >= 0 && previousAge <= CUSTOM_ROOM_STALE_MS) {
      merged.status = sameRoom.status; merged.liveStartTime = sameRoom.liveStartTime;
      merged.metadataFetchedAt = sameRoom.metadataFetchedAt;
    } else { merged.status = 'unknown'; merged.liveStartTime = null; }
  } else if (metadataAge < 0 || metadataAge > CUSTOM_ROOM_STALE_MS) {
    merged.status = 'unknown'; merged.liveStartTime = null;
  }
  if (metadataAge < 0 || metadataAge > CUSTOM_ROOM_STALE_MS) merged.metadataStale = true;
  if (merged.status === 'offline' && !merged.metadataStale) {
    merged.online = null; merged.onlineStale = false; delete merged.onlineLastSuccessAt; delete merged.onlineError;
  } else if (next.onlineStale || !usableOnline(next, now)) {
    const old = [next, sameRoom].filter((room): room is CustomRoomRecord => Boolean(room) && usableOnline(room!, now))
      .sort((a, b) => b.onlineLastSuccessAt! - a.onlineLastSuccessAt!)[0];
    merged.online = old?.online ?? null; merged.onlineStale = true;
    if (old?.onlineLastSuccessAt !== undefined) merged.onlineLastSuccessAt = old.onlineLastSuccessAt;
    else delete merged.onlineLastSuccessAt;
  }
  return merged;
}

export function staleCustomRoom(room: CustomRoomRecord, error?: string, now = Date.now()): CustomRoomRecord {
  return mergeCustomRoom(room, { ...room, metadataStale: true, metadataError: error, onlineStale: true, onlineError: error }, now);
}

export function readCustomRooms(storage?: Pick<Storage, 'getItem'>): CustomRoomRecord[] {
  try {
    const parsed: unknown = JSON.parse((storage ?? globalThis.localStorage).getItem(CUSTOM_ROOMS_STORAGE_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    const unique = new Map<string, CustomRoomRecord>();
    for (const item of parsed.slice(0, 256)) {
      if (!isRecord(item) || item.source !== 'custom') continue;
      const id = canonicalId(item.roomId); if (!id) continue;
      const room = descriptorFromPayload(item, id, optionalString(item.input) ?? id, Date.now(), true); if (!room) continue;
      // Prior versions saved base-room heat as online; it cannot be migrated as a count.
      if (item.onlineMetricVersion !== 1) { room.online = null; room.onlineStale = true; delete room.onlineLastSuccessAt; }
      unique.set(id, mergeCustomRoom(undefined, room));
    }
    return [...unique.values()];
  } catch { return []; }
}

export function writeCustomRooms(rooms: readonly CustomRoomRecord[], storage?: Pick<Storage, 'setItem'>): boolean {
  try {
    const safe = rooms.map(({ source, roomId, input, uid, anchorName, title, cover, status, online, onlineStale, onlineLastSuccessAt, onlineError,
      liveStartTime, lastUpdatedAt, metadataFetchedAt, metadataStale, metadataError }) => ({ source, roomId, input, uid, anchorName, title, cover, status,
      online, onlineStale, onlineLastSuccessAt, onlineError, liveStartTime, lastUpdatedAt, metadataFetchedAt, metadataStale, metadataError, onlineMetricVersion: 1 }));
    (storage ?? globalThis.localStorage).setItem(CUSTOM_ROOMS_STORAGE_KEY, JSON.stringify(safe)); return true;
  } catch { return false; }
}

const abortError = () => new DOMException('房间信息请求已取消', 'AbortError');
interface AdapterOptions {
  resolve: (roomId: string, signal: AbortSignal) => Promise<unknown>;
  now?: () => number;
  timeoutMs?: number;
}
interface InFlight { controller: AbortController; consumers: number; promise: Promise<CustomRoomRecord> }

/** Public metadata always comes from the local extension, never a site API. */
export class BilibiliRoomMetadataAdapter {
  private readonly inFlight = new Map<string, InFlight>();
  constructor(private readonly options: AdapterOptions) {}
  resolve(inputValue: string, signal?: AbortSignal): Promise<CustomRoomRecord> {
    const parsed = parseMonitorRoomInput(inputValue);
    if (!parsed) return Promise.reject(new Error('请输入有效房间号或 B站直播链接'));
    if (signal?.aborted) return Promise.reject(abortError());
    let shared = this.inFlight.get(parsed.roomId);
    if (!shared) {
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.options.timeoutMs ?? REQUEST_TIMEOUT_MS);
      const invoke = new Promise<unknown>((resolve, reject) => {
        const aborted = () => reject(timedOut
          ? new Error('读取直播间资料超时，请确认浏览器扩展已安装并启用') : abortError());
        controller.signal.addEventListener('abort', aborted, { once: true });
        Promise.resolve().then(() => this.options.resolve(parsed.roomId, controller.signal)).then(
          value => { controller.signal.removeEventListener('abort', aborted); resolve(value); },
          error => { controller.signal.removeEventListener('abort', aborted); reject(error); });
      });
      const promise = invoke.then(payload => {
        const now = this.options.now?.() ?? Date.now();
        const room = descriptorFromPayload(payload, parsed.roomId, parsed.input, now, true);
        if (!room) throw new Error('扩展未返回有效直播间资料');
        return mergeCustomRoom(undefined, room, now);
      }).finally(() => { clearTimeout(timer); if (this.inFlight.get(parsed.roomId)?.controller === controller) this.inFlight.delete(parsed.roomId); });
      shared = { controller, consumers: 0, promise };
      this.inFlight.set(parsed.roomId, shared);
    }
    const entry = shared;
    entry.consumers++;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (settled) return false;
        settled = true; entry.consumers--; signal?.removeEventListener('abort', cancel); return true;
      };
      const cancel = () => {
        if (!finish()) return;
        reject(abortError());
        if (!entry.consumers) { entry.controller.abort(); if (this.inFlight.get(parsed.roomId) === entry) this.inFlight.delete(parsed.roomId); }
      };
      signal?.addEventListener('abort', cancel, { once: true });
      entry.promise.then(room => { if (finish()) resolve({ ...room, input: parsed.input }); }, error => { if (finish()) reject(error); });
      if (signal?.aborted) cancel();
    });
  }
}
