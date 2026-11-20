import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultPreferences, defaultRoomPreference, readMultiviewPreferences, retainAllowedRooms, validatePreferences, writeMultiviewPreferences } from '../client/multiview/preferences';

test('legacy and invalid media modes retain normal video defaults', () => {
  const input = { ...defaultPreferences(), roomIds: ['1', '2', '3'], rooms: {
    '1': defaultRoomPreference(), '2': { ...defaultRoomPreference(), mediaMode: 'hidden' },
    '3': { ...defaultRoomPreference(), mediaMode: 'video' },
  } };
  const result = validatePreferences(input);
  assert.deepEqual(result.rooms, { '1': defaultRoomPreference(), '2': defaultRoomPreference(), '3': defaultRoomPreference() });
});

test('audio preference round trips without changing mixing, quality or danmaku', () => {
  const input = defaultPreferences();
  input.roomIds = ['1', '2'];
  input.rooms = { '1': { volume: .3, balance: -47, muted: false, quality: 400, mediaMode: 'audio' }, '2': defaultRoomPreference() };
  input.danmaku.rooms = { '1': { enabled: true }, '2': { enabled: false } };
  let saved = '';
  assert.equal(writeMultiviewPreferences(input, { setItem: (_key, value) => { saved = value; } }), true);
  const output = readMultiviewPreferences({ getItem: () => saved });
  assert.deepEqual(output.rooms, input.rooms);
  assert.deepEqual(output.danmaku, validatePreferences(input).danmaku);
  assert.equal(output.masterMuted, input.masterMuted);
  assert.equal(output.rooms['2'].mediaMode, undefined);
});

test('permission pruning preserves remaining audio mode and drops the removed mode', () => {
  const input = validatePreferences({ ...defaultPreferences(), roomIds: ['1', '2'], rooms: {
    '1': { ...defaultRoomPreference(), balance: 70, mediaMode: 'audio' }, '2': { ...defaultRoomPreference(), balance: -40, mediaMode: 'audio' },
  }, danmaku: { ...defaultPreferences().danmaku, rooms: { '1': { enabled: true }, '2': { enabled: true } } } });
  const output = retainAllowedRooms(input, new Set(['1']));
  assert.equal(output.rooms['1'].mediaMode, 'audio');
  assert.equal(output.rooms['1'].balance, 70);
  assert.equal(output.danmaku.rooms['1'].enabled, true);
  assert.equal(output.rooms['2'], undefined);
  assert.equal(output.danmaku.rooms['2'], undefined);
});

test('room balance defaults to center and normalizes persisted values within its bounds', () => {
  const result = validatePreferences({ version: 1, roomIds: ['1', '2', '3', '4', '5', '6', '7'], rooms: {
    '1': {}, '2': { balance: '50' }, '3': { balance: Infinity }, '4': { balance: -173 },
    '5': { balance: 161 }, '6': { balance: -4.7 }, '7': { balance: -0.2 },
  } });
  assert.deepEqual(result.roomIds.map(id => result.rooms[id].balance), [0, 0, 0, -100, 100, -5, 0]);
});
