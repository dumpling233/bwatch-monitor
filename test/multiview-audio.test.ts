import assert from 'node:assert/strict';
import test from 'node:test';
import { setRoomAudioBalance, setRoomAudioVolume, toggleRoomAudio } from '../client/multiview/audio';
import { defaultPreferences, type MultiviewPreferences } from '../client/multiview/preferences';

function mix(): MultiviewPreferences {
  return { ...defaultPreferences(), roomIds: ['1', '2', '3', '4'], masterMuted: false, masterVolume: 0.5,
    rooms: {
      '1': { volume: 0.4, balance: -25, muted: false, quality: 80 },
      '2': { volume: 0.6, balance: 0, muted: false, quality: 150 },
      '3': { volume: 0.8, balance: 20, muted: true, quality: 250 },
      '4': { volume: 0, balance: 0, muted: true, quality: 400 },
    } };
}

const audibleRooms = (value: MultiviewPreferences) => value.masterMuted || value.masterVolume === 0 ? []
  : value.roomIds.filter(id => !value.rooms[id].muted && value.rooms[id].volume > 0);

test('room toggle during master mute starts a new mix and preserves stored room levels', () => {
  const value = { ...mix(), masterMuted: true };
  const next = toggleRoomAudio(value, '3');
  assert.deepEqual(audibleRooms(next), ['3']);
  assert.equal(next.masterVolume, 0.5);
  assert.deepEqual(next.roomIds.map(id => next.rooms[id].volume), [0.4, 0.6, 0.8, 0]);
  assert.deepEqual(next.roomIds.map(id => next.rooms[id].quality), [80, 150, 250, 400]);
  assert.deepEqual(next.roomIds.map(id => next.rooms[id].balance), [-25, 0, 20, 0]);
  assert.deepEqual(audibleRooms(value), []);
  assert.equal(value.rooms['1'].muted, false);
  const expanded = toggleRoomAudio(next, '2');
  assert.deepEqual(audibleRooms(expanded), ['2', '3']);
  assert.deepEqual(audibleRooms(toggleRoomAudio(expanded, '3')), ['2']);
});

test('room positive volume during master mute selects only that room, while zero keeps the saved mix', () => {
  const value = { ...mix(), masterMuted: true };
  const mutedRoom = setRoomAudioVolume(value, '3', 0);
  assert.equal(mutedRoom.masterMuted, true);
  assert.equal(mutedRoom.rooms['1'].muted, false);
  assert.equal(mutedRoom.rooms['2'].muted, false);
  const next = setRoomAudioVolume(value, '3', 0.3);
  assert.deepEqual(audibleRooms(next), ['3']);
  assert.equal(next.rooms['3'].volume, 0.3);
  assert.equal(next.rooms['1'].volume, 0.4);
  assert.equal(next.masterVolume, 0.5);
});

test('room activation at zero master volume resets the mix and restores a positive master level', () => {
  for (const masterMuted of [false, true]) {
    const value = { ...mix(), masterVolume: 0, masterMuted };
    const clicked = toggleRoomAudio(value, '1');
    assert.deepEqual(audibleRooms(clicked), ['1']);
    assert.equal(clicked.masterVolume, 1);
    const adjusted = setRoomAudioVolume(value, '4', 0.2);
    assert.deepEqual(audibleRooms(adjusted), ['4']);
    assert.equal(adjusted.masterVolume, 1);
    assert.equal(adjusted.rooms['4'].volume, 0.2);
  }
});

test('ordinary room operations preserve the other audible rooms and remembered volume', () => {
  const value = mix();
  assert.deepEqual(audibleRooms(toggleRoomAudio(value, '3')), ['1', '2', '3']);
  const restoredZero = toggleRoomAudio(value, '4');
  assert.deepEqual(audibleRooms(restoredZero), ['1', '2', '4']);
  assert.equal(restoredZero.rooms['4'].volume, 0.7);
  const silenced = toggleRoomAudio(value, '1');
  assert.deepEqual(audibleRooms(silenced), ['2']);
  assert.equal(silenced.rooms['1'].volume, 0.4);
  assert.deepEqual(audibleRooms(setRoomAudioVolume(value, '2', 0)), ['1']);
  assert.deepEqual(audibleRooms(setRoomAudioVolume(value, '3', 0.3)), ['1', '2', '3']);
});

test('default and 48-room watching selections share the same per-room restart rule', () => {
  const value = mix();
  value.adaptiveGridEnabled = true;
  value.roomIds = Array.from({ length: 48 }, (_, index) => String(index + 1));
  value.rooms = Object.fromEntries(value.roomIds.map(id => [id, { volume: 0.5, balance: 0, muted: false, quality: 80 }]));
  value.masterMuted = true;
  assert.deepEqual(audibleRooms(toggleRoomAudio(value, '48')), ['48']);
  const fresh = { ...defaultPreferences(), roomIds: ['1', '2'] };
  assert.deepEqual(audibleRooms(toggleRoomAudio(fresh, '2')), ['2']);
});

test('adjusting balance affects only the selected room and leaves the muted mix intact', () => {
  const value = { ...mix(), masterMuted: true, masterVolume: 0 };
  const adjusted = setRoomAudioBalance(value, '3', -133);
  assert.deepEqual(adjusted, { ...value, rooms: { ...value.rooms, '3': { ...value.rooms['3'], balance: -100 } } });
  assert.equal(value.rooms['3'].balance, 20);
  assert.equal(adjusted.rooms['1'], value.rooms['1']);
  assert.equal(setRoomAudioBalance(adjusted, '3', -100), adjusted);
  assert.equal(setRoomAudioBalance(value, '5', 50), value);
  assert.equal(setRoomAudioBalance(adjusted, '3', 0).rooms['3'].balance, 0);
});
