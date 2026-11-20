import { defaultRoomPreference, normalizeRoomAudioBalance, type MultiviewPreferences } from './preferences';

const masterSilenced = (value: MultiviewPreferences) => value.masterMuted || value.masterVolume === 0;

function enableRoomAudio(value: MultiviewPreferences, roomId: string, volume?: number): MultiviewPreferences {
  const rooms = { ...value.rooms };
  if (masterSilenced(value)) {
    for (const id of value.roomIds) {
      if (id !== roomId) rooms[id] = { ...defaultRoomPreference(), ...rooms[id], muted: true };
    }
  }
  const room = { ...defaultRoomPreference(), ...rooms[roomId] };
  rooms[roomId] = { ...room, volume: volume ?? (room.volume || 0.7), muted: false };
  return { ...value, masterMuted: false, masterVolume: value.masterVolume || 1, rooms };
}

export function toggleRoomAudio(value: MultiviewPreferences, roomId: string): MultiviewPreferences {
  const room = { ...defaultRoomPreference(), ...value.rooms[roomId] };
  if (masterSilenced(value) || room.muted || room.volume === 0) return enableRoomAudio(value, roomId);
  return { ...value, rooms: { ...value.rooms, [roomId]: { ...room, muted: true } } };
}

export function setRoomAudioVolume(value: MultiviewPreferences, roomId: string, volume: number): MultiviewPreferences {
  if (volume > 0) return enableRoomAudio(value, roomId, volume);
  const room = { ...defaultRoomPreference(), ...value.rooms[roomId] };
  return { ...value, rooms: { ...value.rooms, [roomId]: { ...room, volume, muted: true } } };
}

export function setRoomAudioBalance(value: MultiviewPreferences, roomId: string, balance: number): MultiviewPreferences {
  if (!value.roomIds.includes(roomId)) return value;
  const room = value.rooms[roomId] ?? defaultRoomPreference();
  const next = normalizeRoomAudioBalance(balance);
  if (room.balance === next) return value;
  return { ...value, rooms: { ...value.rooms, [roomId]: { ...room, balance: next } } };
}
