import assert from 'node:assert/strict';
import test from 'node:test';
import { visibleWindow, type RoomSlot } from '../client/multiview/layouts';
import { defaultPreferences, defaultRoomPreference, retainAllowedRooms } from '../client/multiview/preferences';
import { planRoomPlacement, type RoomPlacementInput, type RoomPlacementResult } from '../client/multiview/roomPlacement';

type SuccessfulPlacement = Extract<RoomPlacementResult, { ok: true }>;
const place = (override: Partial<RoomPlacementInput> = {}): SuccessfulPlacement => {
  const result = planRoomPlacement({ roomIds: ['1', '2'], slotRoomIds: ['1', '2', null, null],
    capacity: 4, viewOffset: 0, roomId: '3', targetIndex: 2, ...override });
  assert.equal(result.ok, true);
  return result as SuccessfulPlacement;
};

test('placing an existing room on itself is a no-op and preserves selection order', () => {
  const result = place({ roomId: '2', targetIndex: 1 });
  assert.equal(result.action, 'noop');
  assert.deepEqual(result.roomIds, ['1', '2']);
  assert.deepEqual(result.slotRoomIds, ['1', '2', null, null]);
  assert.equal(result.replacedRoomId, null);
});

test('existing rooms move into a hole or exchange exactly two slots', () => {
  const moved = place({ roomId: '2', targetIndex: 2 });
  assert.equal(moved.action, 'move');
  assert.deepEqual(moved.slotRoomIds, ['1', null, '2', null]);
  assert.deepEqual(moved.roomIds, ['1', '2']);
  const swapped = place({ roomId: '1', targetIndex: 1 });
  assert.equal(swapped.action, 'swap');
  assert.deepEqual(swapped.slotRoomIds, ['2', '1', null, null]);
  assert.equal(swapped.targetRoomId, '2');
});

test('an already selected hidden room swaps with its actual hidden source slot', () => {
  const result = place({ roomIds: ['1', '2', '3', '4'], slotRoomIds: ['1', '2', '3', '4'],
    capacity: 2, roomId: '4', targetIndex: 0 });
  assert.equal(result.action, 'swap');
  assert.deepEqual(result.slotRoomIds, ['4', '2', '3', '1']);
  assert.deepEqual(result.roomIds, ['1', '2', '3', '4']);
});

test('a hidden selected room can move into a visible hole without adding a selection', () => {
  const result = place({ roomIds: ['1', '2', '3'], slotRoomIds: ['1', null, '2', '3'],
    capacity: 2, roomId: '3', targetIndex: 1 });
  assert.equal(result.action, 'move');
  assert.deepEqual(result.slotRoomIds, ['1', '3', '2', null]);
  assert.deepEqual(result.roomIds, ['1', '2', '3']);
});

test('new rooms fill only the chosen empty cell without packing the other holes', () => {
  const result = place({ targetIndex: 3 });
  assert.equal(result.action, 'add');
  assert.deepEqual(result.slotRoomIds, ['1', '2', null, '3']);
  assert.deepEqual(result.roomIds, ['1', '2', '3']);
  assert.equal(result.displacedToIndex, null);
});

test('a new room displaces the target to the first visible empty cell', () => {
  const result = place({ slotRoomIds: [null, '1', null, '2'], targetIndex: 3 });
  assert.equal(result.action, 'displace');
  assert.deepEqual(result.slotRoomIds, ['2', '1', null, '3']);
  assert.equal(result.targetRoomId, '2');
  assert.equal(result.displacedToIndex, 0);
  assert.equal(result.replacedRoomId, null);
});

test('a filled visible template replaces rather than using a hidden empty cell or expanding', () => {
  const result = place({ roomIds: ['1', '2', '4'], slotRoomIds: ['1', '2', null, '4'], capacity: 2, targetIndex: 1 });
  assert.equal(result.action, 'replace');
  assert.equal(result.replacedRoomId, '2');
  assert.deepEqual(result.roomIds, ['1', '3', '4']);
  assert.deepEqual(result.slotRoomIds, ['1', '3', null, '4']);
});

test('twelve selected rooms allow one-for-one replacement and keep every unrelated hidden room', () => {
  const ids = Array.from({ length: 12 }, (_, index) => String(index + 1));
  const result = place({ roomIds: ids, slotRoomIds: ids, capacity: 4, roomId: '13', targetIndex: 2 });
  assert.equal(result.action, 'replace');
  assert.equal(result.replacedRoomId, '3');
  assert.equal(result.roomIds.length, 12);
  assert.deepEqual(result.roomIds, ['1', '2', '13', ...ids.slice(3)]);
  assert.deepEqual(result.slotRoomIds, result.roomIds);
});

test('a purported hole at twelve selections is normalized without losing the hidden selection', () => {
  const ids = Array.from({ length: 12 }, (_, index) => String(index + 1));
  const result = place({ roomIds: ids, slotRoomIds: [null, ...ids.slice(1)], capacity: 4, roomId: '13', targetIndex: 0 });
  assert.equal(result.action, 'replace');
  assert.equal(result.replacedRoomId, '1');
  assert.deepEqual(result.roomIds, ['13', ...ids.slice(1)]);
  assert.equal(result.slotRoomIds.length, 12);
});

test('single-cell templates allow fill, replace and swapping in a hidden selected room', () => {
  const added = place({ roomIds: [], slotRoomIds: [null], capacity: 1, targetIndex: 0 });
  assert.equal(added.action, 'add');
  assert.deepEqual(added.slotRoomIds, ['3']);
  const replaced = place({ roomIds: ['1'], slotRoomIds: ['1'], capacity: 1, targetIndex: 0 });
  assert.equal(replaced.action, 'replace');
  assert.deepEqual(replaced.roomIds, ['3']);
  const swapped = place({ roomIds: ['1', '2'], slotRoomIds: ['1', '2'], capacity: 1, roomId: '2', targetIndex: 0 });
  assert.equal(swapped.action, 'swap');
  assert.deepEqual(swapped.slotRoomIds, ['2', '1']);
});

test('circular windows resolve visible targets and first holes in visual order across the tail', () => {
  const result = place({ roomIds: ['1', '2', '4'], slotRoomIds: ['1', null, '2', '4'], capacity: 3,
    viewOffset: 3, roomId: '3', targetIndex: 0 });
  assert.equal(result.action, 'displace');
  assert.equal(result.displacedToIndex, 2);
  assert.deepEqual(visibleWindow(result.slotRoomIds, 3, result.viewOffset), ['3', '1', '4']);
  assert.deepEqual(result.slotRoomIds, ['1', '4', '2', '3']);
  assert.equal(result.roomIds.length, 4);
});

test('wrapped full windows replace their visual target without shifting any other visible position', () => {
  const result = place({ roomIds: ['1', '2', '4', '5'], slotRoomIds: ['1', '2', '4', '5'],
    capacity: 3, viewOffset: 3, targetIndex: 1 });
  assert.equal(result.action, 'replace');
  assert.equal(result.replacedRoomId, '1');
  assert.deepEqual(visibleWindow(result.slotRoomIds, 3, result.viewOffset), ['5', '3', '2']);
});

test('negative offsets preserve the circular target and return a canonical window offset', () => {
  const result = place({ roomId: '1', viewOffset: -1, targetIndex: 0 });
  assert.equal(result.action, 'move');
  assert.equal(result.viewOffset, 3);
  assert.deepEqual(visibleWindow(result.slotRoomIds, 4, result.viewOffset), ['1', null, '2', null]);
});

test('invalid target or oversized selection cannot silently truncate rooms', () => {
  const input: RoomPlacementInput = { roomIds: ['1'], slotRoomIds: ['1', null], capacity: 2,
    viewOffset: 0, roomId: '2', targetIndex: -1 };
  for (const targetIndex of [-1, 2, 0.5, Number.NaN]) {
    assert.deepEqual(planRoomPlacement({ ...input, targetIndex }), { ok: false, reason: 'target' });
  }
  for (const capacity of [0, 13, 2.5, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(planRoomPlacement({ ...input, capacity, targetIndex: 0 }), { ok: false, reason: 'target' });
  }
  assert.deepEqual(planRoomPlacement({ ...input, roomId: '', targetIndex: 0 }), { ok: false, reason: 'target' });
  assert.deepEqual(planRoomPlacement({ ...input, roomIds: Array.from({ length: 13 }, (_, index) => String(index + 1)), targetIndex: 0 }), { ok: false, reason: 'limit' });
});

test('planning never mutates input collections and returns independent arrays', () => {
  const roomIds = Object.freeze(['1', '2']);
  const slotRoomIds: readonly RoomSlot[] = Object.freeze(['1', '2', null, null]);
  const result = place({ roomIds, slotRoomIds, targetIndex: 0 });
  assert.deepEqual(roomIds, ['1', '2']);
  assert.deepEqual(slotRoomIds, ['1', '2', null, null]);
  assert.notEqual(result.roomIds, roomIds);
  assert.notEqual(result.slotRoomIds, slotRoomIds);
});

test('replacing a room also drops its saved playback and danmaku preferences', () => {
  const value = defaultPreferences();
  value.roomIds = ['1', '2'];
  value.slotRoomIds = ['1', '2', null, null];
  value.rooms = { '1': defaultRoomPreference(), '2': { volume: 0.2, balance: -48, muted: false, quality: 150 } };
  value.danmaku.rooms = { '1': { enabled: true }, '2': { enabled: true } };
  const result = retainAllowedRooms(value, new Set(['1', '3']));
  assert.deepEqual(result.roomIds, ['1']);
  assert.deepEqual(Object.keys(result.rooms), ['1']);
  assert.deepEqual(Object.keys(result.danmaku.rooms), ['1']);
  assert.equal(result.rooms['2'], undefined);
});
