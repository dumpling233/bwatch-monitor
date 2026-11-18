import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFollowingRoomInfo } from '../client/multiview/followingRoomInfo.js';
import { FollowingRoomsStore, readFollowingRoomsPage } from '../client/multiview/followingRooms.js';
import type { LocalFollowingRoomInfo, LocalFollowingRoomsPage, LocalFollowingStatusBatch } from '../shared/localFollowing.js';

const info = (): LocalFollowingRoomInfo => ({ accountUid: '42', authEpoch: 'epoch', roomId: '1', uid: '101', anchorName: '主播',
  title: '直播标题', cover: 'https://i0.hdslb.com/bfs/live/cover.jpg', status: 'live', liveStartTime: 1000,
  online: 0, onlineStale: false, onlineLastSuccessAt: 2000, metadataFetchedAt: 2000, metadataStale: false, resolvedAt: 2000 });
const page = (overrides: Partial<LocalFollowingRoomsPage> = {}): LocalFollowingRoomsPage => ({ accountUid: '42', authEpoch: 'epoch',
  page: 1, pageSize: 50, total: 1, liveCount: 1, hasMore: false, resolvedAt: 1000,
  rooms: [{ roomId: '1', uid: '101', anchorName: '主播', title: '目录标题', status: 'live', online: null, liveStartTime: null, lastLiveTime: null }], ...overrides });
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test('canonical following details require the requested room, owner, account and count evidence', () => {
  const parsed = readFollowingRoomInfo(info(), '1', '101', '42', 'epoch');
  assert.equal(parsed.online, 0); assert.equal(parsed.onlineLastSuccessAt, 2000);
  for (const invalid of [{ ...info(), uid: '102' }, { ...info(), roomId: '2' }, { ...info(), authEpoch: 'old' },
    { ...info(), accountUid: '43' }, { ...info(), onlineLastSuccessAt: undefined }, { ...info(), online: 1.5 },
    { ...info(), cover: 'https://bwatch.icu/proxy/image' }, { ...info(), metadataFetchedAt: 3000 }]) {
    assert.throws(() => readFollowingRoomInfo(invalid, '1', '101', '42', 'epoch'));
  }
});

test('details survive directory replacement but account changes and mismatched owners cannot revive them', async () => {
  const store = new FollowingRoomsStore(async () => page(), () => 2000);
  store.setContext('42', true); await settle();
  store.applyRoomInfo('1', readFollowingRoomInfo(info(), '1', '101', '42', 'epoch'), '42');
  assert.equal(store.getSnapshot().rooms[0].online, 0);
  assert.equal(store.getSnapshot().rooms[0].cover, info().cover);
  store.reload(); await settle();
  assert.equal(store.getSnapshot().rooms[0].online, 0);
  assert.equal(store.getSnapshot().rooms[0].title, '直播标题');
  store.setContext('43', true); await settle();
  store.applyRoomInfo('1', readFollowingRoomInfo(info(), '1', '101', '42', 'epoch'), '42');
  assert.deepEqual(store.getSnapshot().rooms, []);
  assert.deepEqual(store.getTrustedRoomIds(), []); store.dispose();
});

test('relations pages without rooms still advance and unresolved room mapping does not block a complete account directory', async () => {
  let current = 1;
  const responses: LocalFollowingRoomsPage[] = [page({ rooms: [], total: null, liveCount: null, hasMore: true,
    directorySource: 'relations', accountTotal: 2, scannedAccounts: 1, scannedUids: ['100'], unresolvedUids: [] }),
  page({ page: 2, directorySource: 'relations', total: null, liveCount: null, accountTotal: 2, scannedAccounts: 1,
    scannedUids: ['101'], unresolvedUids: ['101'] })];
  for (const response of responses) assert.equal(readFollowingRoomsPage(response, response.page, '42', 'epoch').directorySource, 'relations');
  const store = new FollowingRoomsStore(async index => responses[index - 1], () => current, {
    set(callback) { current += 500; queueMicrotask(callback); return 1 as unknown as ReturnType<typeof setTimeout>; }, clear() {} });
  store.setContext('42', true); await settle(); await settle();
  assert.equal(store.getSnapshot().scannedPages, 2);
  assert.equal(store.getSnapshot().rooms.length, 1);
  assert.equal(store.getSnapshot().complete, true);
  assert.equal(store.getSnapshot().incompleteReason, ''); store.dispose();
});

test('relations payload cannot introduce unresolved identifiers outside the current page', () => {
  assert.throws(() => readFollowingRoomsPage(page({ directorySource: 'relations', accountTotal: 1, scannedAccounts: 1,
    scannedUids: ['101'], unresolvedUids: ['999'] }), 1, '42', 'epoch'));
});

for (const missing of [true, false]) test(`a newer ${missing ? 'missing UID' : 'mismatched room'} status observation cannot revive old live details`, async () => {
  let now = 2000;
  const result: LocalFollowingStatusBatch = { accountUid: '42', authEpoch: 'epoch', uids: ['101'], resolvedAt: 62_000,
    rooms: missing ? [] : [{ uid: '101', roomId: '9', status: 'live', liveStartTime: null, anchorName: '错误主播' }] };
  const store = new FollowingRoomsStore(async () => page(), () => now, undefined, async () => result);
  try {
    store.setContext('42', true, true); await settle();
    store.applyRoomInfo('1', readFollowingRoomInfo(info(), '1', '101', '42', 'epoch'), '42');
    store.setContext('42', false); now = 62_000; store.setContext('42', true); await settle();
    const current = store.getSnapshot().rooms[0];
    assert.equal(current.status, 'unknown'); assert.equal(current.metadataStale, true);
    assert.equal(current.metadataFetchedAt, 62_000); assert.equal(store.getSnapshot().liveCount, null);
    assert.equal(current.anchorName, '主播'); assert.equal(current.cover, info().cover);
  } finally { store.dispose(); }
});

test('newer status names and titles survive detail overlays while canonical covers and independent viewer samples are retained', async () => {
  let now = 2000;
  const store = new FollowingRoomsStore(async () => page(), () => now, undefined, async uids => ({
    accountUid: '42', authEpoch: 'epoch', uids, resolvedAt: 62_000,
    rooms: [{ uid: '101', roomId: '1', status: 'live', liveStartTime: 50_000,
      anchorName: '更新后的主播', title: '更新后的标题', cover: 'https://i0.hdslb.com/bfs/live/batch-cover.jpg' }],
  }));
  try {
    store.setContext('42', true, true); await settle();
    store.applyRoomInfo('1', readFollowingRoomInfo(info(), '1', '101', '42', 'epoch'), '42');
    store.setContext('42', false); now = 62_000; store.setContext('42', true); await settle();
    const current = store.getSnapshot().rooms[0];
    assert.equal(current.status, 'live'); assert.equal(current.metadataStale, false);
    assert.equal(current.anchorName, '更新后的主播'); assert.equal(current.title, '更新后的标题');
    assert.equal(current.cover, info().cover); assert.equal(current.liveStartTime, 50_000);
    assert.equal(current.online, 0); assert.equal(current.onlineLastSuccessAt, 2000);
    assert.equal(current.metadataFetchedAt, 62_000);
  } finally { store.dispose(); }
});
