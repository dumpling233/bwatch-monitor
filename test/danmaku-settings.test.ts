import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultPreferences, multiviewPreferenceKey, readMultiviewPreferences, writeMultiviewPreferences } from '../client/multiview/preferences.js';

test('the medal setting survives reload independently of room styles and does not restore removed account actions', () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const initial = { ...defaultPreferences(), roomIds: ['1', '2'] };
  const enabled = { ...initial, danmaku: { ...initial.danmaku, autoWearRoomMedal: true,
    autoLightMedal: true, rooms: { '1': { enabled: true }, '2': { enabled: false,
      style: { ...initial.danmaku.defaults, fontSize: 36 } } } } };
  assert.equal(writeMultiviewPreferences(enabled, storage), true);
  const reloaded = readMultiviewPreferences(storage);
  assert.equal(reloaded.danmaku.autoWearRoomMedal, true);
  assert.equal(reloaded.danmaku.rooms['1'].enabled, true);
  assert.equal(reloaded.danmaku.rooms['2'].enabled, false);
  assert.equal(reloaded.danmaku.rooms['2'].style?.fontSize, 36);
  assert.equal('autoLightMedal' in reloaded.danmaku, false);
  assert.doesNotMatch(values.get(multiviewPreferenceKey())!, /autoLightMedal/);
  assert.equal(writeMultiviewPreferences({ ...reloaded,
    danmaku: { ...reloaded.danmaku, autoWearRoomMedal: false } }, storage), true);
  assert.equal(readMultiviewPreferences(storage).danmaku.autoWearRoomMedal, false);
  assert.equal(readMultiviewPreferences(storage).danmaku.rooms['2'].style?.fontSize, 36);
});
