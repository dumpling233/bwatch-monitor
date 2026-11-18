import assert from 'node:assert/strict';
import test from 'node:test';
import type { MonitorRoomDescriptor } from '../shared/types.js';
import { mergeFollowingMetadata } from '../client/multiview/followingMetadata.js';

const room = (patch: Partial<MonitorRoomDescriptor> = {}): MonitorRoomDescriptor => ({ roomId: '10', source: 'custom',
  uid: 42, anchorName: '原主播', title: '原标题', status: 'offline', online: null, onlineStale: false,
  fansCount: 123, fansStale: false, guardCount: 9, guardStale: false, liveStartTime: null,
  lastUpdatedAt: 100, metadataFetchedAt: 100, metadataStale: false, ...patch });

test('fresh following metadata updates a stale room while preserving its local binding and metrics', () => {
  const base = room({ input: 'original' });
  const next = mergeFollowingMetadata(base, room({ source: 'custom', input: 'other',
    anchorName: '新主播', title: '已开播', status: 'live', metadataFetchedAt: 200, lastUpdatedAt: 200,
    fansCount: null, guardCount: null }));
  assert.equal(next.status, 'live'); assert.equal(next.title, '已开播');
  assert.equal(next.source, 'custom'); assert.equal(next.roomId, base.roomId); assert.equal(next.uid, base.uid);
  assert.equal(next.input, 'original');
  assert.equal(next.fansCount, 123); assert.equal(next.guardCount, 9); assert.equal(base.status, 'offline');
});

test('older, stale, mismatched owner or different room observations cannot replace current room data', () => {
  const base = room();
  for (const patch of [{ metadataFetchedAt: 50 }, { metadataFetchedAt: 100 }, { metadataFetchedAt: 0 },
    { metadataFetchedAt: 200, metadataStale: true }, { metadataFetchedAt: 200, uid: 43 }, { metadataFetchedAt: 200, roomId: '11' }])
    assert.equal(mergeFollowingMetadata(base, room(patch)), base);
  assert.equal(mergeFollowingMetadata(base), base);
});

test('unknown following status does not erase known live status or fabricate audience freshness', () => {
  const base = room({ status: 'live', online: 400, onlineLastSuccessAt: 90, liveStartTime: 50 });
  const next = mergeFollowingMetadata(base, room({ source: 'custom', status: 'unknown', title: '新标题', metadataFetchedAt: 200 }));
  assert.equal(next.status, 'live'); assert.equal(next.online, 400); assert.equal(next.onlineLastSuccessAt, 90);
  assert.equal(next.liveStartTime, 50); assert.equal(next.title, '新标题');
  const offline = mergeFollowingMetadata(base, room({ metadataFetchedAt: 200 }));
  assert.equal(offline.status, 'offline'); assert.equal(offline.online, null); assert.equal(offline.liveStartTime, null);
});

test('only trusted room details update real viewers, including zero, without changing the local binding', () => {
  const base = room({ source: 'custom', input: 'saved', status: 'live', online: 99,
    onlineLastSuccessAt: 90, cover: 'old-cover' });
  const observation = room({ status: 'live', metadataFetchedAt: 200, online: 0, onlineLastSuccessAt: 190,
    cover: 'room-cover' });
  assert.equal(mergeFollowingMetadata(base, observation).online, 99, 'directory counts are never trusted');
  const next = mergeFollowingMetadata(base, observation, true);
  assert.equal(next.online, 0); assert.equal(next.onlineLastSuccessAt, 190);
  assert.equal(next.cover, 'room-cover'); assert.equal(next.input, 'saved');
  assert.equal(next.source, 'custom'); assert.equal(next.fansCount, 123);
});

test('trusted online freshness is independent and an older count never replaces a newer sample', () => {
  const base = room({ status: 'live', online: 10, onlineLastSuccessAt: 300, metadataFetchedAt: 400 });
  const newerCount = mergeFollowingMetadata(base, room({ status: 'live', title: 'older-title', metadataFetchedAt: 200,
    online: 20, onlineLastSuccessAt: 350 }), true);
  assert.equal(newerCount.online, 20); assert.equal(newerCount.onlineLastSuccessAt, 350);
  assert.equal(newerCount.title, base.title); assert.equal(newerCount.metadataFetchedAt, 400);
  const oldCount = mergeFollowingMetadata(base, room({ status: 'live', metadataFetchedAt: 500,
    online: 1, onlineLastSuccessAt: 200 }), true);
  assert.equal(oldCount.online, 10); assert.equal(oldCount.onlineLastSuccessAt, 300);
  const failedCount = mergeFollowingMetadata(base, room({ status: 'live', metadataFetchedAt: 500,
    online: null, onlineStale: true, onlineError: '人数暂时不可用' }), true);
  assert.equal(failedCount.online, 10); assert.equal(failedCount.onlineLastSuccessAt, 300);
  assert.equal(failedCount.onlineStale, true); assert.equal(failedCount.onlineError, '人数暂时不可用');
});

test('canonical room snapshots override a later directory timestamp without fabricating metric freshness', () => {
  const directory = room({ source: 'custom', status: 'live', anchorName: '新昵称', title: '新标题', cover: 'account-avatar', metadataFetchedAt: 500 });
  const publicRoom = room({ status: 'live', cover: 'actual-room-cover', metadataFetchedAt: 200, online: 42, onlineLastSuccessAt: 180 });
  const next = mergeFollowingMetadata(directory, publicRoom, 'public-room');
  assert.equal(next.cover, 'actual-room-cover'); assert.equal(next.online, 42);
  assert.equal(next.metadataFetchedAt, 500); assert.equal(next.onlineLastSuccessAt, 180);
  assert.equal(next.anchorName, '新昵称'); assert.equal(next.title, '新标题');
  assert.equal(next.source, 'custom');
  const olderOffline = mergeFollowingMetadata(directory, { ...publicRoom, status: 'offline', online: null }, 'public-room');
  assert.equal(olderOffline.status, 'live'); assert.equal(olderOffline.cover, 'actual-room-cover');
  assert.equal(olderOffline.metadataFetchedAt, 500);
});
