import { isPlaybackQuality, type PlaybackMediaMode } from '../../shared/playback';
import { DEFAULT_LAYOUT_ID, findLayout, layoutForCount, MULTIVIEW_LAYOUTS, normalizeSlotRoomIds, resetSlotRoomIds, type RoomSlot } from './layouts';
import { defaultDanmakuPreferences, validateDanmakuPreferences, type DanmakuPreferences } from './danmaku/displayPreferences';
import { MAX_ADAPTIVE_GRID_ROOMS } from './adaptiveGrid';

export const MAX_MULTIVIEW_ROOMS = 12;
export { MAX_ADAPTIVE_GRID_ROOMS } from './adaptiveGrid';
export const MIN_SIDEBAR_WIDTH = 360;
export const MAX_SIDEBAR_WIDTH = 420;
export const MIN_GRID_GAP = 0;
export const MAX_GRID_GAP = 5;
export const ONLINE_COUNT_POSITIONS = ['hidden', 'top-left', 'top-right', 'bottom-left', 'bottom-right'] as const;
export type OnlineCountPosition = typeof ONLINE_COUNT_POSITIONS[number];
export function normalizeSidebarWidth(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, value))) : MIN_SIDEBAR_WIDTH;
}
export function normalizeGridGap(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(Math.min(MAX_GRID_GAP, Math.max(MIN_GRID_GAP, value))) : 2;
}
export interface RoomPlaybackPreference { volume: number; muted: boolean; quality: number; mediaMode?: PlaybackMediaMode }
export interface MultiviewPreferences {
  version: 1;
  adaptiveGridEnabled: boolean;
  roomIds: string[];
  slotRoomIds: RoomSlot[];
  layoutId: string;
  sidebarOpen: boolean;
  sidebarWidth: number;
  gridGap: number;
  sidebarSide: 'left' | 'right';
  stopHidden: boolean;
  playbackMode: 'stable' | 'low-latency';
  autoReconnect: boolean;
  switchbarTop: boolean;
  autoHideControls: boolean;
  onlineCountPosition: OnlineCountPosition;
  masterMuted: boolean;
  masterVolume: number;
  rooms: Record<string, RoomPlaybackPreference>;
  danmaku: DanmakuPreferences;
}

export const defaultRoomPreference = (): RoomPlaybackPreference => ({ volume: 0.7, muted: true, quality: 0 });
export const defaultPreferences = (): MultiviewPreferences => ({ version: 1, adaptiveGridEnabled: false, roomIds: [], slotRoomIds: resetSlotRoomIds([], findLayout(DEFAULT_LAYOUT_ID).count), layoutId: DEFAULT_LAYOUT_ID,
  sidebarOpen: true, sidebarWidth: MIN_SIDEBAR_WIDTH, gridGap: 2, sidebarSide: 'left', stopHidden: true, playbackMode: 'stable', autoReconnect: true, switchbarTop: false, autoHideControls: true, onlineCountPosition: 'hidden',
  masterMuted: true, masterVolume: 1, rooms: {}, danmaku: defaultDanmakuPreferences() });
export const multiviewPreferenceKey = () => 'bwatch-monitor:preferences:v1';
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const roomId = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value);
const unit = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
const bool = (value: unknown, fallback: boolean) => typeof value === 'boolean' ? value : fallback;

/** Recover every saved room into the desktop grid, retaining valid holes rather than hidden windows. */
export function normalizeMonitorSelection(roomIds: readonly string[], layoutId: string, input: unknown): Pick<MultiviewPreferences, 'layoutId' | 'slotRoomIds'> {
  const current = findLayout(layoutId);
  const slots = normalizeSlotRoomIds(input, roomIds, current.count);
  const occupiedExtent = slots.reduce((extent, id, index) => id === null ? extent : index + 1, 0);
  const layout = occupiedExtent > current.count ? layoutForCount(occupiedExtent) : current;
  return { layoutId: layout.id, slotRoomIds: slots.slice(0, layout.count) };
}

/** Local storage is untrusted; never accept source URLs, cookies or arbitrary IDs. */
export function validatePreferences(value: unknown): MultiviewPreferences {
  const fallback = defaultPreferences();
  if (!isRecord(value) || value.version !== 1) return fallback;
  const adaptiveGridEnabled = bool(value.adaptiveGridEnabled, false);
  const roomIds = Array.isArray(value.roomIds)
    ? [...new Set(value.roomIds.filter(roomId))].slice(0, adaptiveGridEnabled ? MAX_ADAPTIVE_GRID_ROOMS : MAX_MULTIVIEW_ROOMS) : [];
  const layoutId = typeof value.layoutId === 'string' && MULTIVIEW_LAYOUTS.some(layout => layout.id === value.layoutId) ? value.layoutId : fallback.layoutId;
  const rooms: Record<string, RoomPlaybackPreference> = {};
  for (const id of roomIds) {
    const source = isRecord(value.rooms) && isRecord(value.rooms[id]) ? value.rooms[id] : {};
    const mediaMode = source.mediaMode === 'audio' ? 'audio' : undefined;
    rooms[id] = { volume: unit(source.volume, 0.7), muted: bool(source.muted, true),
      quality: isPlaybackQuality(source.quality) ? source.quality : 0,
      ...(mediaMode ? { mediaMode } : {}) };
  }
  const fixedRoomIds = roomIds.slice(0, MAX_MULTIVIEW_ROOMS);
  const normalized = adaptiveGridEnabled && roomIds.length > MAX_MULTIVIEW_ROOMS
    ? { layoutId, slotRoomIds: normalizeSlotRoomIds(value.slotRoomIds, fixedRoomIds, findLayout(layoutId).count).slice(0, MAX_MULTIVIEW_ROOMS) }
    : normalizeMonitorSelection(roomIds, layoutId, value.slotRoomIds);
  return { version: 1, adaptiveGridEnabled, roomIds, ...normalized, rooms,
    danmaku: validateDanmakuPreferences(value.danmaku, roomIds),
    sidebarOpen: bool(value.sidebarOpen, true), sidebarWidth: normalizeSidebarWidth(value.sidebarWidth), gridGap: normalizeGridGap(value.gridGap),
    sidebarSide: value.sidebarSide === 'right' ? 'right' : 'left',
    stopHidden: bool(value.stopHidden, fallback.stopHidden), playbackMode: value.playbackMode === 'low-latency' ? 'low-latency' : 'stable',
    autoReconnect: bool(value.autoReconnect, true),
    switchbarTop: bool(value.switchbarTop, false),
    autoHideControls: bool(value.autoHideControls, fallback.autoHideControls),
    onlineCountPosition: ONLINE_COUNT_POSITIONS.find(position => position === value.onlineCountPosition)
      ?? (value.onlineCountPosition === undefined && value.showOnlineCount === true ? 'bottom-left' : 'hidden'),
    masterMuted: bool(value.masterMuted, true), masterVolume: unit(value.masterVolume, 1) };
}

export function readMultiviewPreferences(storage?: Pick<Storage, 'getItem'>): MultiviewPreferences {
  try { return validatePreferences(JSON.parse((storage ?? globalThis.localStorage).getItem(multiviewPreferenceKey()) ?? 'null')); }
  catch { return defaultPreferences(); }
}

export function writeMultiviewPreferences(value: MultiviewPreferences, storage?: Pick<Storage, 'setItem'>): boolean {
  try { (storage ?? globalThis.localStorage).setItem(multiviewPreferenceKey(), JSON.stringify(validatePreferences(value))); return true; }
  catch { return false; }
}

export function retainAllowedRooms(value: MultiviewPreferences, allowedIds: ReadonlySet<string>): MultiviewPreferences {
  const roomIds = value.roomIds.filter(id => allowedIds.has(id));
  if (roomIds.length === value.roomIds.length) return value;
  return { ...value, roomIds, slotRoomIds: normalizeSlotRoomIds(value.slotRoomIds, roomIds, findLayout(value.layoutId).count),
    danmaku: validateDanmakuPreferences(value.danmaku, roomIds),
    rooms: Object.fromEntries(roomIds.map(id => [id, value.rooms[id] ?? defaultRoomPreference()])) };
}
