import type { MonitorRoomDescriptor } from '../../shared/types';
import { mergeCustomRoom, parseMonitorRoomInput, type CustomRoomRecord } from './customRooms';

export const ROOM_LIBRARY_STORAGE_KEY = 'bwatch-monitor:room-library:v1';
export const MAX_SAVED_ROOMS = 256;
export type RoomBinding = 'custom';
export interface LibraryRoomEntry { room: CustomRoomRecord; binding: RoomBinding }
export interface RoomLibrary {
  version: 2;
  savedRoomIds: string[];
  roomsById: Record<string, LibraryRoomEntry>;
}
type LibraryStorage = Pick<Storage, 'getItem' | 'setItem'>;
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const validId = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value);
const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const positiveTime = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const imageUrl = (value: unknown): string | undefined => {
  try {
    const url = new URL(text(value) ?? '');
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return undefined;
    url.search = ''; url.hash = '';
    return url.href;
  } catch { return undefined; }
};
const safeInput = (value: unknown, id: string) => {
  const parsed = typeof value === 'string' ? parseMonitorRoomInput(value) : null;
  if (!parsed) return id;
  return /^\d+$/.test(parsed.input) ? parsed.roomId : `https://live.bilibili.com/${parsed.roomId}`;
};

/** This is a metadata whitelist, never a serialization of the runtime object. */
function normalizeRoom(value: unknown, trustedOnline: boolean): CustomRoomRecord | null {
  if (!isRecord(value) || !validId(value.roomId)) return null;
  const status = value.status === 'live' || value.status === 'offline' ? value.status : 'unknown';
  const online = trustedOnline ? count(value.online) : null;
  const onlineLastSuccessAt = trustedOnline ? positiveTime(value.onlineLastSuccessAt) : null;
  return {
    source: 'custom', input: safeInput(value.input, value.roomId), roomId: value.roomId,
    uid: count(value.uid), anchorName: text(value.anchorName) ?? `房间 ${value.roomId}`,
    title: text(value.title) ?? (status === 'live' ? '直播中' : 'B站直播间'), cover: imageUrl(value.cover), status,
    online, onlineStale: !trustedOnline || value.onlineStale === true || (status === 'live' && online === null),
    ...(onlineLastSuccessAt !== null && online !== null ? { onlineLastSuccessAt } : {}),
    ...(text(value.onlineError) ? { onlineError: text(value.onlineError) } : {}),
    liveStartTime: positiveTime(value.liveStartTime), lastUpdatedAt: positiveTime(value.lastUpdatedAt) ?? 0,
    metadataFetchedAt: positiveTime(value.metadataFetchedAt), metadataStale: value.metadataStale === true,
    ...(text(value.metadataError) ? { metadataError: text(value.metadataError) } : {}),
    fansCount: null, fansStale: false, guardCount: null, guardStale: false,
  };
}

export const emptyRoomLibrary = (): RoomLibrary => ({ version: 2, savedRoomIds: [], roomsById: {} });

export function roomRecordFromDescriptor(room: MonitorRoomDescriptor): CustomRoomRecord {
  const normalized = normalizeRoom(room, true);
  if (!normalized) throw new TypeError('无效的直播间房号');
  return normalized;
}

/** Keep the saved relation independent from the current playback selection. */
export function upsertLibraryRoom(library: RoomLibrary, descriptor: MonitorRoomDescriptor,
  binding: RoomBinding = descriptor.source): RoomLibrary {
  const room = roomRecordFromDescriptor(descriptor);
  const previous = library.roomsById[room.roomId];
  if (previous?.binding === binding && JSON.stringify(previous.room) === JSON.stringify(room)) return library;
  return { ...library, roomsById: { ...library.roomsById, [room.roomId]: { room, binding } } };
}

export function saveLibraryRoom(library: RoomLibrary, room: MonitorRoomDescriptor,
  binding: RoomBinding = room.source): { library: RoomLibrary; error?: string } {
  const saved = library.savedRoomIds.includes(room.roomId);
  if (!saved && library.savedRoomIds.length >= MAX_SAVED_ROOMS) {
    return { library, error: `最多保存 ${MAX_SAVED_ROOMS} 个房间，请先从我的房间移除一些记录` };
  }
  const next = upsertLibraryRoom(library, room, binding);
  return { library: saved ? next : { ...next, savedRoomIds: [...next.savedRoomIds, room.roomId] } };
}

/** Removing a saved relation intentionally retains the watching metadata snapshot. */
export function removeSavedRoom(library: RoomLibrary, roomId: string): RoomLibrary {
  if (!library.savedRoomIds.includes(roomId)) return library;
  return { ...library, savedRoomIds: library.savedRoomIds.filter(id => id !== roomId) };
}

export function pruneRoomLibrary(library: RoomLibrary, selectedIds: Iterable<string>, undoIds: Iterable<string> = []): RoomLibrary {
  const referenced = new Set([...library.savedRoomIds, ...selectedIds, ...undoIds]);
  const entries = Object.entries(library.roomsById).filter(([id]) => referenced.has(id));
  return entries.length === Object.keys(library.roomsById).length ? library : { ...library, roomsById: Object.fromEntries(entries) };
}

export function mergeLibraryMetadata(library: RoomLibrary, room: CustomRoomRecord): RoomLibrary {
  const previous = library.roomsById[room.roomId];
  if (!previous) return library;
  return upsertLibraryRoom(library, mergeCustomRoom(previous.room, room), previous.binding);
}

function parseLibrary(value: unknown, now: number): RoomLibrary {
  if (!isRecord(value) || value.version !== 2 || !isRecord(value.roomsById)) return emptyRoomLibrary();
  const roomsById: RoomLibrary['roomsById'] = {};
  for (const [id, entry] of Object.entries(value.roomsById)) {
    if (!validId(id) || !isRecord(entry) || !['custom'].includes(String(entry.binding))) continue;
    const room = normalizeRoom(entry.room, isRecord(entry.room) && entry.room.onlineMetricVersion === 1);
    if (!room || room.roomId !== id) continue;
    roomsById[id] = { binding: entry.binding as RoomBinding, room: mergeCustomRoom(undefined, room, now) };
  }
  const savedRoomIds = Array.isArray(value.savedRoomIds)
    ? [...new Set(value.savedRoomIds.filter((id): id is string => validId(id) && Boolean(roomsById[id])))] : [];
  return { version: 2, savedRoomIds, roomsById };
}

/** Only this independent app's storage key is read; other sites are never migrated. */
export function readRoomLibrary(storage?: LibraryStorage): RoomLibrary {
  try {
    const store = storage ?? globalThis.localStorage;
    const current = store.getItem(ROOM_LIBRARY_STORAGE_KEY);
    if (current !== null) {
      try { return parseLibrary(JSON.parse(current), Date.now()); } catch { return emptyRoomLibrary(); }
    }
    return emptyRoomLibrary();
  } catch { return emptyRoomLibrary(); }
}

export function writeRoomLibrary(library: RoomLibrary, storage?: Pick<Storage, 'setItem'>): boolean {
  try {
    const roomsById: Record<string, unknown> = {};
    for (const [id, entry] of Object.entries(library.roomsById)) {
      const room = normalizeRoom(entry.room, true);
      if (!room || id !== room.roomId || !['custom'].includes(entry.binding)) continue;
      roomsById[id] = { binding: entry.binding, room: { ...room, onlineMetricVersion: 1 } };
    }
    const savedRoomIds = [...new Set(library.savedRoomIds.filter(id => validId(id) && Boolean(roomsById[id])))];
    (storage ?? globalThis.localStorage).setItem(ROOM_LIBRARY_STORAGE_KEY, JSON.stringify({ version: 2, savedRoomIds, roomsById }));
    return true;
  } catch { return false; }
}
