import { normalizeSlotRoomIds, SLOT_AREAS, visibleSlotIndices, type RoomSlot } from './layouts';

export interface RoomPlacementInput {
  roomIds: readonly string[];
  slotRoomIds: readonly RoomSlot[];
  capacity: number;
  viewOffset: number;
  roomId: string;
  /** Index in the currently displayed template, rather than the saved slot array. */
  targetIndex: number;
}

export type RoomPlacementResult = { ok: false; reason: 'target' | 'limit' } | {
  ok: true;
  action: 'noop' | 'move' | 'swap' | 'add' | 'displace' | 'replace';
  roomIds: string[];
  slotRoomIds: RoomSlot[];
  viewOffset: number;
  targetRoomId: string | null;
  replacedRoomId: string | null;
  /** The visible empty slot receiving the previous occupant, if any. */
  displacedToIndex: number | null;
};

/**
 * Plan a single placement without touching playback, preferences or the input arrays.
 * Only visible empty slots count as room for displacement; hidden rooms are never evicted.
 */
export function planRoomPlacement(input: RoomPlacementInput): RoomPlacementResult {
  const { capacity, roomId, targetIndex } = input;
  if (!roomId || !Number.isInteger(capacity) || capacity < 1 || capacity > SLOT_AREAS.length
    || !Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= capacity) return { ok: false, reason: 'target' };
  const roomIds = [...new Set(input.roomIds)];
  if (roomIds.length > SLOT_AREAS.length) return { ok: false, reason: 'limit' };
  const slots = normalizeSlotRoomIds(input.slotRoomIds, roomIds, capacity);
  const visibleIndices = visibleSlotIndices(slots.length, capacity, input.viewOffset);
  const targetSlot = visibleIndices[targetIndex];
  if (targetSlot === undefined) return { ok: false, reason: 'target' };
  const targetRoomId = slots[targetSlot];
  const sourceSlot = slots.indexOf(roomId);
  let action: Extract<RoomPlacementResult, { ok: true }>['action'];
  let replacedRoomId: string | null = null;
  let displacedToIndex: number | null = null;

  if (sourceSlot >= 0) {
    action = sourceSlot === targetSlot ? 'noop' : targetRoomId === null ? 'move' : 'swap';
    [slots[sourceSlot], slots[targetSlot]] = [slots[targetSlot], slots[sourceSlot]];
  } else {
    const atLimit = roomIds.length >= SLOT_AREAS.length;
    if (targetRoomId === null) {
      if (atLimit) return { ok: false, reason: 'limit' };
      action = 'add';
      slots[targetSlot] = roomId;
      roomIds.push(roomId);
    } else {
      const emptyIndex = visibleIndices.findIndex(index => slots[index] === null);
      if (!atLimit && emptyIndex >= 0) {
        action = 'displace';
        displacedToIndex = emptyIndex;
        slots[visibleIndices[emptyIndex]] = targetRoomId;
        slots[targetSlot] = roomId;
        roomIds.push(roomId);
      } else {
        action = 'replace';
        replacedRoomId = targetRoomId;
        slots[targetSlot] = roomId;
        // Retain the selection order of every unrelated room, including hidden rooms.
        roomIds.splice(roomIds.indexOf(targetRoomId), 1, roomId);
      }
    }
  }

  let slotRoomIds = normalizeSlotRoomIds(slots, roomIds, capacity);
  let viewOffset = visibleIndices[0] ?? 0;
  // The modulus of a circular window changes if its backing array grows. Rebase
  // the old window first, preserving the visual target and all following slots.
  if (slotRoomIds.length !== slots.length) {
    slotRoomIds = [...visibleSlotIndices(slots.length, slots.length, viewOffset).map(index => slotRoomIds[index]),
      ...slotRoomIds.slice(slots.length)];
    viewOffset = 0;
  }
  return { ok: true, action, roomIds, slotRoomIds, viewOffset, targetRoomId, replacedRoomId, displacedToIndex };
}
