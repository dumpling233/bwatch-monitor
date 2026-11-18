import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultPreferences, multiviewPreferenceKey, readMultiviewPreferences, writeMultiviewPreferences } from '../client/multiview/preferences.js';
import { emptyRoomLibrary, pruneRoomLibrary, readRoomLibrary, removeSavedRoom, ROOM_LIBRARY_STORAGE_KEY,
  saveLibraryRoom, writeRoomLibrary } from '../client/multiview/roomLibrary.js';
import type { CustomRoomRecord } from '../client/multiview/customRooms.js';

class MemoryStorage {
  readonly values = new Map<string, string>();
  readonly reads: string[] = [];
  getItem(key: string): string | null { this.reads.push(key); return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}
const room = (id = '123'): CustomRoomRecord => ({ source: 'custom', input: `https://live.bilibili.com/${id}?from=test`,
  roomId: id, uid: 42, anchorName: '测试主播', title: '直播中', cover: 'https://i0.hdslb.com/cover.jpg?token=discard#fragment',
  status: 'live', online: 0, onlineStale: false, onlineLastSuccessAt: Date.now(), fansCount: null, fansStale: false,
  guardCount: null, guardStale: false, liveStartTime: Date.now() - 1_000, lastUpdatedAt: Date.now(),
  metadataFetchedAt: Date.now(), metadataStale: false });

test('the independent app starts empty and never reads the original site storage keys', () => {
  const storage = new MemoryStorage();
  storage.values.set('bwatch:multiview:guest:v1', JSON.stringify({ ...defaultPreferences(), roomIds: ['987'] }));
  storage.values.set('bwatch:monitor-room-library:v2', JSON.stringify({ version: 2, savedRoomIds: ['987'], roomsById: {} }));
  storage.values.set('bwatch:custom-rooms:v1', JSON.stringify([room('987')]));
  assert.deepEqual(readMultiviewPreferences(storage).roomIds, []);
  assert.deepEqual(readRoomLibrary(storage), emptyRoomLibrary());
  assert.deepEqual(storage.reads, [multiviewPreferenceKey(), ROOM_LIBRARY_STORAGE_KEY]);
});

test('saved local rooms survive reload without serializing stream URLs or account data', () => {
  const storage = new MemoryStorage();
  const unsafe = { ...room(), url: 'https://example.invalid/private-stream', cookie: 'test-secret',
    authEpoch: 'private-account', token: 'private-token', retryAfterMs: 10_000 };
  const saved = saveLibraryRoom(emptyRoomLibrary(), unsafe).library;
  assert.equal(writeRoomLibrary(saved, storage), true);
  const serialized = storage.values.get(ROOM_LIBRARY_STORAGE_KEY)!;
  assert.doesNotMatch(serialized, /private-stream|test-secret|private-account|private-token|retryAfterMs|\?token=/);
  const restored = readRoomLibrary(storage);
  assert.deepEqual(restored.savedRoomIds, ['123']);
  assert.equal(restored.roomsById['123'].binding, 'custom');
  assert.equal(restored.roomsById['123'].room.input, 'https://live.bilibili.com/123');
  assert.equal(restored.roomsById['123'].room.cover, 'https://i0.hdslb.com/cover.jpg');
  assert.equal(restored.roomsById['123'].room.online, 0);
  assert.equal(restored.roomsById['123'].room.status, 'live');
});

test('removing a favorite retains an active or undoable room and pruning removes only unreferenced metadata', () => {
  let library = saveLibraryRoom(emptyRoomLibrary(), room('1')).library;
  library = saveLibraryRoom(library, room('2')).library;
  library = saveLibraryRoom(library, room('3')).library;
  library = removeSavedRoom(removeSavedRoom(library, '1'), '2');
  library = pruneRoomLibrary(library, ['1'], ['2']);
  assert.deepEqual(library.savedRoomIds, ['3']);
  assert.deepEqual(Object.keys(library.roomsById), ['1', '2', '3']);
  library = pruneRoomLibrary(library, [], []);
  assert.deepEqual(Object.keys(library.roomsById), ['3']);
});

test('layout holes, room playback settings and global preferences round trip in their own namespace', () => {
  const storage = new MemoryStorage();
  const value = { ...defaultPreferences(), roomIds: ['1', '2'], slotRoomIds: ['1', null, '2', null],
    layoutId: 'four-grid', sidebarSide: 'right' as const, gridGap: 4, masterVolume: 0.4,
    rooms: { '1': { volume: 0.3, muted: false, quality: 50000, mediaMode: 'audio' as const,
      url: 'https://example.invalid/signed', token: 'private-token' }, '2': { volume: 0.9, muted: true, quality: 250 } } };
  assert.equal(writeMultiviewPreferences(value, storage), true);
  const restored = readMultiviewPreferences(storage);
  assert.deepEqual(restored.slotRoomIds, ['1', null, '2', null]);
  assert.deepEqual(restored.roomIds, ['1', '2']);
  assert.equal(restored.rooms['1'].mediaMode, 'audio');
  assert.equal(restored.rooms['1'].quality, 50000);
  assert.equal(restored.rooms['1'].muted, false);
  assert.equal(restored.masterVolume, 0.4);
  assert.equal(restored.sidebarSide, 'right');
  assert.equal(restored.gridGap, 4);
  assert.doesNotMatch(storage.values.get(multiviewPreferenceKey())!, /signed|private-token/);
});

test('corrupt or unavailable local storage recovers safely and reports failed writes', () => {
  const storage = new MemoryStorage();
  storage.values.set(ROOM_LIBRARY_STORAGE_KEY, '{invalid');
  storage.values.set(multiviewPreferenceKey(), '{invalid');
  assert.deepEqual(readRoomLibrary(storage), emptyRoomLibrary());
  assert.deepEqual(readMultiviewPreferences(storage), defaultPreferences());
  const unavailable = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('quota'); } };
  assert.deepEqual(readRoomLibrary(unavailable), emptyRoomLibrary());
  assert.deepEqual(readMultiviewPreferences(unavailable), defaultPreferences());
  assert.equal(writeRoomLibrary(emptyRoomLibrary(), unavailable), false);
  assert.equal(writeMultiviewPreferences(defaultPreferences(), unavailable), false);
});
