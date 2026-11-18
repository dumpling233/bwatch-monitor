import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LocalFollowingRoom, LocalFollowingRoomsPage, LocalFollowingStatusBatch } from '../shared/localFollowing.js';
import { FollowingRoomsStore, readFollowingRoomsPage, readFollowingStatusBatch } from '../client/multiview/followingRooms.js';
import { LocalLoginClientError } from '../client/multiview/localLoginClient.js';

const room = (id: string): LocalFollowingRoom => ({ roomId: id, uid: String(100 + Number(id)), anchorName: `主播${id}`,
  title: `直播${id}`, status: 'live', online: null, liveStartTime: null, lastLiveTime: 1000 });
const page = (index = 1, rooms = [room('1')], hasMore = false): LocalFollowingRoomsPage => ({ accountUid: '42', authEpoch: 'epoch',
  page: index, pageSize: 9, total: null, liveCount: null, hasMore, rooms, resolvedAt: 1000 });
const batch = (uids: string[], rooms: LocalFollowingStatusBatch['rooms'] = uids.map(value => ({ uid: value, roomId: String(Number(value) - 100),
  status: 'offline', liveStartTime: null }))): LocalFollowingStatusBatch => ({ accountUid: '42', authEpoch: 'epoch', uids, rooms, resolvedAt: 2000 });
const relationPage = (owners: string[], rooms: LocalFollowingRoom[] = [], unresolved: string[] = []): LocalFollowingRoomsPage => ({
  ...page(1, rooms), pageSize: 100, directorySource: 'relations', accountTotal: owners.length,
  scannedAccounts: owners.length, scannedUids: owners, unresolvedUids: unresolved,
});
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function clock() {
  type Timer = ReturnType<typeof globalThis.setTimeout>;
  let now = 1, nextId = 0;
  const jobs = new Map<Timer, { at: number; run: () => void }>();
  return { now: () => now, timers: {
    set(run: () => void, delay: number) { const id = ++nextId as unknown as Timer; jobs.set(id, { at: now + delay, run }); return id; },
    clear(id: Timer) { jobs.delete(id); },
  }, async advance(ms: number) {
    const target = now + ms;
    for (;;) {
      const next = [...jobs].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > target) break;
      now = next[1].at; jobs.delete(next[0]); next[1].run(); await settle();
    }
    now = target; await settle();
  } };
}

test('following bridge rejects other accounts, epochs, pages and malformed metadata; unsafe images degrade', () => {
  assert.equal(readFollowingRoomsPage(page(), 1, '42', 'epoch').rooms[0].roomId, '1');
  for (const value of [
    { ...page(), accountUid: '43' }, { ...page(), authEpoch: 'old' }, { ...page(), page: 2 },
    { ...page(), pageSize: 1000 }, { ...page(), total: -1 },
    { ...page(), rooms: [{ ...room('1'), uid: 42 }] }, { ...page(), rooms: [{ ...room('1'), title: 'x'.repeat(513) }] },
  ]) assert.throws(() => readFollowingRoomsPage(value, 1, '42', 'epoch'));
  const unsafe = readFollowingRoomsPage({ ...page(), rooms: [{ ...room('1'), cover: 'https://bwatch.icu/api/proxy/image' }] }, 1, '42', 'epoch');
  assert.equal(unsafe.rooms[0].cover, undefined);
});

test('foreground indexing is finite, serial and paced; duplicate updates retain official order', async () => {
  const time = clock(), first = deferred<LocalFollowingRoomsPage>(), requests: number[] = [];
  const store = new FollowingRoomsStore(index => {
    requests.push(index);
    return index === 1 ? first.promise : Promise.resolve({ ...page(2, [{ ...room('1'), status: 'offline' }, room('3')]), resolvedAt: 2000 });
  }, time.now, time.timers);
  store.setContext('account42', false); assert.deepEqual(requests, []);
  store.setContext('account42', true); store.loadMore(); store.loadMore(); assert.deepEqual(requests, [1]);
  first.resolve(page(1, [room('2'), room('1')], true)); await settle();
  assert.deepEqual(store.getSnapshot().rooms.map(room => room.roomId), ['2', '1']);
  await time.advance(499); assert.deepEqual(requests, [1]);
  await time.advance(1); assert.deepEqual(requests, [1, 2]);
  assert.deepEqual(store.getSnapshot().rooms.map(room => room.roomId), ['2', '1', '3']);
  assert.equal(store.getSnapshot().rooms[1].status, 'offline');
  assert.equal(store.getSnapshot().complete, true); assert.equal(store.getSnapshot().liveCount, 2);
  assert.equal(store.getSnapshot().total, 3);
  await time.advance(3_600_000); assert.deepEqual(requests, [1, 2]); store.dispose();
});

test('closing or backgrounding cancels in-flight work and resumes the same unfinished page', async () => {
  const time = clock(), pending = deferred<LocalFollowingRoomsPage>(), requests: number[] = []; let signal: AbortSignal | undefined;
  const store = new FollowingRoomsStore((index, current) => {
    requests.push(index); signal = current;
    return index === 1 ? Promise.resolve(page(1, [room('1')], true)) : requests.length === 2 ? pending.promise : Promise.resolve(page(2, [room('2')]));
  }, time.now, time.timers);
  store.setContext('account42', true); await settle(); await time.advance(500);
  store.setContext('account42', false); assert.equal(signal?.aborted, true);
  pending.resolve(page(2, [room('9')])); await settle();
  await time.advance(1000); assert.deepEqual(requests, [1, 2]);
  assert.deepEqual(store.getSnapshot().rooms.map(room => room.roomId), ['1']); assert.equal(store.getSnapshot().indexing, false);
  store.setContext('account42', true); await settle();
  assert.deepEqual(requests, [1, 2, 2]);
  assert.deepEqual(store.getSnapshot().rooms.map(room => room.roomId), ['1', '2']); store.dispose();
});

test('account changes clear personal indexes and reject late responses while retaining the rate budget', async () => {
  const time = clock(), previous = deferred<LocalFollowingRoomsPage>(); let calls = 0;
  const store = new FollowingRoomsStore(() => ++calls === 1 ? previous.promise : Promise.resolve({ ...page(1, [room('9')]), accountUid: '43' }), time.now, time.timers);
  store.setContext('account42', true); store.setContext('account43', true);
  assert.deepEqual(store.getSnapshot().rooms, []); assert.equal(calls, 1);
  previous.resolve(page()); await settle(); await time.advance(500);
  assert.deepEqual(store.getSnapshot().rooms.map(room => room.roomId), ['9']); assert.equal(calls, 2);
  store.setContext('', false); assert.deepEqual(store.getSnapshot().rooms, []); store.dispose();
});

test('five-minute completed indexes are reused; expiry is checked only on opening, never polled', async () => {
  const time = clock(); let calls = 0;
  const store = new FollowingRoomsStore(() => Promise.resolve(page(1, [room(String(++calls))])), time.now, time.timers);
  store.setContext('account42', true); await settle();
  store.setContext('account42', false); await time.advance(60_000); store.setContext('account42', true); await settle();
  assert.equal(calls, 1);
  await time.advance(600_000); store.setContext('account42', true); await settle(); assert.equal(calls, 1);
  store.setContext('account42', false); store.setContext('account42', true); await settle();
  assert.equal(calls, 2); assert.deepEqual(store.getSnapshot().rooms.map(room => room.roomId), ['2']); store.dispose();
});

test('refresh retains the complete snapshot and its counts until every replacement page succeeds', async () => {
  const time = clock(), last = deferred<LocalFollowingRoomsPage>(); let refreshing = false;
  const store = new FollowingRoomsStore(index => Promise.resolve(!refreshing ? page() : index === 1 ? page(1, [room('8')], true) : last.promise), time.now, time.timers);
  store.setContext('account42', true); await settle(); await time.advance(500); refreshing = true; store.reload(); await settle();
  assert.deepEqual(store.getSnapshot().rooms.map(room => room.roomId), ['1']);
  assert.equal(store.getSnapshot().refreshing, true); assert.equal(store.getSnapshot().loadedCount, 1);
  assert.equal(store.getSnapshot().total, 1); assert.equal(store.getSnapshot().liveCount, 1);
  await time.advance(500); last.resolve(page(2, [{ ...room('9'), status: 'offline' }])); await settle();
  assert.deepEqual(store.getSnapshot().rooms.map(room => room.roomId), ['8', '9']);
  assert.equal(store.getSnapshot().total, 2); assert.equal(store.getSnapshot().liveCount, 1);
  assert.equal(store.getSnapshot().refreshing, false); store.dispose();
});

test('failed refresh preserves old data, retries the failed page once explicitly, and never self-retries', async () => {
  const time = clock(), requests: number[] = []; let refreshing = false, fail = true;
  const store = new FollowingRoomsStore(async index => {
    requests.push(index);
    if (refreshing && index === 2 && fail) { fail = false; throw new LocalLoginClientError('UNAVAILABLE', '稍后重试'); }
    return !refreshing ? page() : page(index, [room(String(index + 7))], index === 1);
  }, time.now, time.timers);
  store.setContext('account42', true); await settle(); await time.advance(500); refreshing = true; store.reload(); await settle(); await time.advance(500);
  assert.deepEqual(store.getSnapshot().rooms.map(room => room.roomId), ['1']); assert.equal(store.getSnapshot().refreshing, true);
  assert.equal(store.getSnapshot().indexing, false); assert.equal(store.getSnapshot().error, '稍后重试');
  await time.advance(60_000); assert.deepEqual(requests, [1, 1, 2]);
  store.loadMore(); await settle(); assert.deepEqual(requests, [1, 1, 2, 2]);
  assert.deepEqual(store.getSnapshot().rooms.map(room => room.roomId), ['8', '9']); store.dispose();
});

test('rate limits survive account switches and require an explicit retry after cooldown', async () => {
  const time = clock(); let calls = 0;
  const store = new FollowingRoomsStore(async () => { calls++; throw new LocalLoginClientError('RATE_LIMITED', '请稍后重试', 30); }, time.now, time.timers);
  store.setContext('account42', true); await settle(); store.loadMore(); store.reload(); await settle(); assert.equal(calls, 1);
  store.setContext('account43', true); await settle(); assert.equal(calls, 1);
  await time.advance(30_001); assert.equal(calls, 1); store.loadMore(); await settle(); assert.equal(calls, 2); store.dispose();
});

test('contradictory upstream counts become unknown until the complete unique index supplies exact counts', async () => {
  const time = clock();
  const store = new FollowingRoomsStore(index => Promise.resolve({ ...page(index, [room(String(index))], index < 3), total: index === 1 ? 0 : 3, liveCount: 0 }), time.now, time.timers);
  store.setContext('account42', true); await settle();
  assert.equal(store.getSnapshot().total, null); assert.equal(store.getSnapshot().liveCount, null);
  await time.advance(500); assert.equal(store.getSnapshot().total, null); assert.equal(store.getSnapshot().liveCount, null);
  await time.advance(500); assert.equal(store.getSnapshot().complete, true);
  assert.equal(store.getSnapshot().total, 3); assert.equal(store.getSnapshot().liveCount, 3); store.dispose();
});

test('earlier counts are also invalidated when later pages omit counts and exceed the saved lower bound', async () => {
  const time = clock();
  const store = new FollowingRoomsStore(index => Promise.resolve({ ...page(index, [{ ...room(String(index)), status: index === 1 ? 'offline' : 'live' }], index < 3),
    total: index === 1 ? 1 : null, liveCount: index === 1 ? 0 : null }), time.now, time.timers);
  store.setContext('account42', true); await settle();
  assert.equal(store.getSnapshot().total, 1); assert.equal(store.getSnapshot().liveCount, 0);
  await time.advance(500);
  assert.equal(store.getSnapshot().total, null); assert.equal(store.getSnapshot().liveCount, null);
  assert.equal(store.getSnapshot().indexing, true); assert.equal(store.getSnapshot().incompleteReason, '');
  await time.advance(500);
  assert.equal(store.getSnapshot().complete, true); assert.equal(store.getSnapshot().total, 3); assert.equal(store.getSnapshot().liveCount, 2);
  store.dispose();
});

test('a repeated room with another exact string UID stops the index without replacing its owner', async () => {
  const time = clock(), requests: number[] = [];
  const store = new FollowingRoomsStore(index => {
    requests.push(index);
    return Promise.resolve(page(index, [{ ...room('1'), uid: index === 1 ? '9007199254740993' : '9007199254740995',
      anchorName: index === 1 ? '原主播' : '另一主播' }], true));
  }, time.now, time.timers);
  store.setContext('account42', true); await settle(); await time.advance(5000);
  assert.deepEqual(requests, [1, 2]); assert.equal(store.getSnapshot().complete, false);
  assert.match(store.getSnapshot().incompleteReason, /房间信息发生变化/);
  assert.equal(store.getSnapshot().rooms[0].anchorName, '原主播'); assert.equal(store.getSnapshot().rooms[0].uid, null);
  store.dispose();
});

for (const kind of ['duplicate', 'empty', 'early-end'] as const) test(`inconsistent ${kind} pages stop incomplete without endless scanning`, async () => {
  const time = clock(), requests: number[] = [];
  const store = new FollowingRoomsStore(index => {
    requests.push(index);
    return Promise.resolve({ ...page(index, index === 1 || kind === 'duplicate' ? [room('1')] : [], kind !== 'early-end'), total: 20 });
  }, time.now, time.timers);
  store.setContext('account42', true); await settle(); await time.advance(5000);
  assert.equal(store.getSnapshot().complete, false); assert.ok(store.getSnapshot().incompleteReason);
  assert.deepEqual(requests, kind === 'early-end' ? [1] : [1, 2]);
  assert.equal(store.getSnapshot().indexing, false); store.dispose();
});

test('bounded indexes stop at the payload limit instead of silently claiming completion', async () => {
  const time = clock(); let calls = 0;
  const store = new FollowingRoomsStore(index => {
    calls++;
    return Promise.resolve(page(index, Array.from({ length: 9 }, (_, offset) => ({ ...room(String(index * 9 + offset)),
      anchorName: '名'.repeat(128), title: '题'.repeat(512), cover: `https://i0.hdslb.com/${'a'.repeat(1800)}.png` })), true));
  }, time.now, time.timers);
  store.setContext('account42', true); await settle(); await time.advance(600_000);
  assert.equal(store.getSnapshot().complete, false); assert.match(store.getSnapshot().incompleteReason, /较大/);
  assert.ok(calls < 1000); const count = calls; await time.advance(600_000); assert.equal(calls, count); store.dispose();
});

test('unending upstream pages stop at the page limit with an explicitly incomplete index', async () => {
  const time = clock(); let calls = 0;
  const store = new FollowingRoomsStore(index => { calls++; return Promise.resolve(page(index, [room(String(index))], true)); }, time.now, time.timers);
  store.setContext('account42', true); await settle(); await time.advance(600_000);
  assert.equal(calls, 1000); assert.equal(store.getSnapshot().complete, false);
  assert.equal(store.getSnapshot().scannedPages, 1000); assert.match(store.getSnapshot().incompleteReason, /较大/);
  store.dispose();
});

test('unknown room states are not counted as confirmed offline, and duplicates cannot erase a reliable state', async () => {
  const time = clock();
  const store = new FollowingRoomsStore(index => Promise.resolve(page(index,
    index === 1 ? [room('1'), { ...room('2'), status: 'unknown' }] : [{ ...room('1'), status: 'unknown' }, room('3')], index === 1)), time.now, time.timers);
  store.setContext('account42', true); await settle(); await time.advance(500);
  assert.equal(store.getSnapshot().complete, true); assert.equal(store.getSnapshot().total, 3);
  assert.equal(store.getSnapshot().rooms[0].status, 'live'); assert.equal(store.getSnapshot().rooms[1].status, 'unknown');
  assert.equal(store.getSnapshot().liveCount, null); store.dispose();
});

test('status bridge binds exact requested UIDs, account generation and safe metadata', () => {
  assert.equal(readFollowingStatusBatch(batch(['101']), ['101'], '42', 'epoch').rooms[0].roomId, '1');
  assert.deepEqual(readFollowingStatusBatch(batch(['101'], []), ['101'], '42', 'epoch').rooms, []);
  for (const value of [
    { ...batch(['101']), accountUid: '43' }, { ...batch(['101']), authEpoch: 'old' }, { ...batch(['101']), uids: ['102'] },
    batch(['101'], [{ uid: '102', roomId: '1', status: 'live', liveStartTime: null }]),
    batch(['101'], [{ uid: '101', roomId: '1', status: 'live', liveStartTime: null, cover: 'https://bwatch.icu/proxy' }]),
    batch(['101', '102'], [{ uid: '101', roomId: '1', status: 'live', liveStartTime: null }, { uid: '101', roomId: '2', status: 'live', liveStartTime: null }]),
  ]) assert.throws(() => readFollowingStatusBatch(value, ['101'], '42', 'epoch'));
  assert.throws(() => readFollowingStatusBatch(batch(['101', '101']), ['101', '101'], '42', 'epoch'));
});

test('supported page sizes are accepted but a directory generation cannot mix them', async () => {
  for (const pageSize of [9, 50, 100]) assert.equal(readFollowingRoomsPage({ ...page(), pageSize }, 1, '42', 'epoch').pageSize, pageSize);
  const time = clock();
  const store = new FollowingRoomsStore(index => Promise.resolve({ ...page(index, [room(String(index))], true), pageSize: index === 1 ? 50 : 100 }), time.now, time.timers);
  store.setContext('account42', true); await settle(); await time.advance(500);
  assert.equal(store.getSnapshot().complete, false); assert.match(store.getSnapshot().incompleteReason, /发生变化/);
  assert.deepEqual(store.getSnapshot().rooms.map(room => room.roomId), ['1']); store.dispose();
});

test('a short relation directory cannot claim completion before all unique account UIDs have been scanned', async () => {
  const time = clock(); let requests = 0;
  const store = new FollowingRoomsStore(async index => {
    requests++;
    return { ...page(index, [room('1')]), pageSize: 50, directorySource: 'relations', accountTotal: 3,
      scannedAccounts: 2, scannedUids: ['101', '102'], unresolvedUids: [] };
  }, time.now, time.timers);
  store.setContext('account42', true); await settle();
  assert.equal(store.getSnapshot().complete, false);
  assert.match(store.getSnapshot().incompleteReason, /部分关注账号尚未读取完整/);
  await time.advance(600_000); assert.equal(requests, 1); store.dispose();
});

test('new capability reuses a fifteen-minute directory and monitors status only while the following view is active', async () => {
  const time = clock(); let directories = 0, statuses = 0;
  const store = new FollowingRoomsStore(async () => { directories++; return page(); }, time.now, time.timers,
    async uids => { statuses++; return batch(uids); });
  store.setContext('account42', true, true); await settle();
  assert.equal(directories, 1); assert.equal(statuses, 0);
  store.setContext('account42', false); await time.advance(59_999); store.setContext('account42', true); await settle();
  assert.equal(statuses, 0);
  await time.advance(1); assert.equal(statuses, 1);
  await time.advance(60_000); store.setContext('account42', true); assert.equal(statuses, 2);
  assert.equal(directories, 1); assert.equal(store.getSnapshot().rooms[0].status, 'offline');
  store.setContext('account42', false); await time.advance(24 * 60 * 60_000); store.setContext('account42', true); await settle();
  assert.equal(directories, 2); assert.equal(statuses, 2); store.dispose();
});

test('continuous foreground status monitoring uses serial batches every sixty seconds after atomic completion without re-reading the directory', async () => {
  const time = clock(), requests: Array<{ size: number; at: number }> = []; let directories = 0;
  const rows = Array.from({ length: 202 }, (_, index) => room(String(index + 1)));
  const store = new FollowingRoomsStore(async index => {
    directories++; return { ...page(index, rows.slice((index - 1) * 100, index * 100), index < 3), pageSize: 100 };
  }, time.now, time.timers, async uids => { requests.push({ size: uids.length, at: time.now() }); return batch(uids); });
  store.setContext('account42', true, true); await settle(); await time.advance(1000);
  assert.equal(directories, 3); assert.equal(store.getSnapshot().complete, true);
  await time.advance(59_999); assert.equal(requests.length, 0);
  await time.advance(1); assert.deepEqual(requests, [{ size: 100, at: 61_001 }]);
  await time.advance(499); assert.equal(requests.length, 1);
  await time.advance(501); assert.deepEqual(requests.map(value => value.size), [100, 100, 2]);
  assert.equal(store.getSnapshot().refreshKind, null); assert.equal(store.getSnapshot().liveCount, 0);
  await time.advance(59_999); assert.equal(requests.length, 3);
  await time.advance(1); assert.equal(requests.length, 4);
  await time.advance(1000); assert.deepEqual(requests.map(value => value.size), [100, 100, 2, 100, 100, 2]);
  assert.equal(directories, 3);
  store.setContext('account42', false); await time.advance(600_000); assert.equal(requests.length, 6);
  store.setContext('account42', true); await settle(); assert.equal(requests.length, 7);
  store.setContext('account42', true); await settle(); assert.equal(requests.length, 7, 'repeated active context does not duplicate the recovery scan');
  await time.advance(1000); assert.equal(requests.length, 9); assert.equal(directories, 3);
  store.dispose(); await time.advance(600_000); assert.equal(requests.length, 9);
});

test('manual directory refresh cancels the status deadline and rearms only sixty seconds after successful replacement', async () => {
  const time = clock(), replacement = deferred<LocalFollowingRoomsPage>(); let directories = 0, statuses = 0;
  const store = new FollowingRoomsStore(async () => ++directories === 1 ? page() : replacement.promise, time.now, time.timers,
    async uids => { statuses++; return batch(uids); });
  store.setContext('account42', true, true); await settle(); await time.advance(59_000);
  store.reload(); await settle(); await time.advance(120_000);
  assert.equal(statuses, 0); assert.equal(directories, 2);
  replacement.resolve(page()); await settle();
  await time.advance(59_999); assert.equal(statuses, 0);
  await time.advance(1); assert.equal(statuses, 1); assert.equal(directories, 2); store.dispose();
});

test('status refresh does not prolong the directory lifetime and manual refresh always syncs the directory', async () => {
  const time = clock(); let directories = 0, statuses = 0;
  const store = new FollowingRoomsStore(async () => { directories++; return page(); }, time.now, time.timers,
    async uids => { statuses++; return batch(uids); });
  store.setContext('account42', true, true); await settle(); store.setContext('account42', false);
  await time.advance(14 * 60_000); store.setContext('account42', true); await settle();
  assert.equal(directories, 1); assert.equal(statuses, 1);
  store.setContext('account42', false); await time.advance(60_000 + 1); store.setContext('account42', true); await settle();
  assert.equal(directories, 2); assert.equal(statuses, 1);
  await time.advance(500); store.reload(); await settle(); assert.equal(directories, 3); assert.equal(statuses, 1); store.dispose();
});

test('status batches are serial, paced and atomic; closing resumes the aborted batch without reordering the directory', async () => {
  const time = clock(), held = deferred<LocalFollowingStatusBatch>(), calls: string[][] = []; let signal: AbortSignal | undefined;
  const rows = Array.from({ length: 202 }, (_, index) => room(String(index + 1)));
  const store = new FollowingRoomsStore(async index => ({ ...page(index, rows.slice((index - 1) * 100, index * 100), index < 3), pageSize: 100 }), time.now, time.timers,
    async (uids, current) => { calls.push(uids); signal = current; return calls.length === 2 ? held.promise : batch(uids); });
  store.setContext('account42', true, true); await settle(); await time.advance(1000);
  assert.equal(store.getSnapshot().complete, true);
  store.setContext('account42', false); await time.advance(60_000); store.setContext('account42', true); await settle();
  assert.equal(calls.length, 1); assert.equal(calls[0].length, 100); assert.equal(store.getSnapshot().refreshKind, 'status');
  assert.equal(store.getSnapshot().rooms[0].status, 'live');
  await time.advance(499); assert.equal(calls.length, 1); await time.advance(1); assert.equal(calls.length, 2);
  store.setContext('account42', false); assert.equal(signal?.aborted, true); held.resolve(batch(calls[1])); await settle();
  await time.advance(500); store.setContext('account42', true); await settle();
  assert.deepEqual(calls[2], calls[1]); assert.equal(store.getSnapshot().rooms[0].status, 'live');
  await time.advance(500); assert.equal(calls[3].length, 2);
  assert.equal(store.getSnapshot().refreshKind, null); assert.equal(store.getSnapshot().liveCount, 0);
  assert.deepEqual(store.getSnapshot().rooms.map(room => room.roomId), rows.map(room => room.roomId)); store.dispose();
});

test('missing UID or changed room ownership becomes unknown without replacing names, covers or large string UID ownership', async () => {
  const time = clock(), original = [room('1'), { ...room('2'), uid: '9007199254740993', cover: 'https://i0.hdslb.com/bfs/live/old.png' }, room('3')];
  let requested: string[] = [];
  const store = new FollowingRoomsStore(async () => page(1, original), time.now, time.timers, async uids => {
    requested = uids;
    return batch(uids, [{ uid: '101', roomId: '1', status: 'offline', liveStartTime: null },
      { uid: original[1].uid, roomId: '9', status: 'live', liveStartTime: null, anchorName: '错误归属', title: '错误房间' }]);
  });
  store.setContext('account42', true, true); await settle(); store.setContext('account42', false); await time.advance(60_000);
  store.setContext('account42', true); await settle();
  assert.deepEqual(requested, ['101', '9007199254740993', '103']);
  const rows = store.getSnapshot().rooms;
  assert.equal(rows[0].status, 'offline'); assert.equal(rows[1].status, 'unknown'); assert.equal(rows[2].status, 'unknown');
  assert.equal(rows[1].anchorName, '主播2'); assert.equal(rows[1].cover, original[1].cover); assert.equal(rows[1].metadataStale, true);
  assert.equal(store.getSnapshot().liveCount, null); store.dispose();
});

test('failed status refresh keeps old snapshot without self retry; explicit retry and revocation cannot revive stale results', async () => {
  const time = clock(), held = deferred<LocalFollowingStatusBatch>(); let calls = 0, signal: AbortSignal | undefined;
  const store = new FollowingRoomsStore(async () => page(), time.now, time.timers, async (uids, current) => {
    calls++; signal = current; if (calls === 1) throw new LocalLoginClientError('RATE_LIMITED', '暂时无法更新', 30); return held.promise;
  });
  store.setContext('account42', true, true); await settle(); await time.advance(60_000);
  assert.equal(calls, 1); assert.equal(store.getSnapshot().rooms[0].status, 'live');
  store.loadMore(); await settle(); assert.equal(calls, 1, 'an explicit early retry still respects cooldown');
  await time.advance(180_000); assert.equal(calls, 1); store.loadMore(); await settle(); assert.equal(calls, 2);
  store.setContext('', false); assert.equal(signal?.aborted, true); held.resolve(batch(['101'])); await settle();
  assert.deepEqual(store.getSnapshot().rooms, []); store.dispose();
});

test('adding a capability does not trigger background work; losing it cancels status and retains legacy five-minute refresh', async () => {
  const time = clock(), held = deferred<LocalFollowingStatusBatch>(); let directories = 0, statuses = 0, signal: AbortSignal | undefined;
  const store = new FollowingRoomsStore(async () => { directories++; return page(); }, time.now, time.timers,
    async (_uids, current) => { statuses++; signal = current; return held.promise; });
  store.setContext('account42', true, false); await settle(); await time.advance(60_000);
  store.setContext('account42', true, true); await settle(); assert.equal(statuses, 0);
  store.setContext('account42', false); store.setContext('account42', true); await settle(); assert.equal(statuses, 1);
  store.setContext('account42', true, false); assert.equal(signal?.aborted, true); held.resolve(batch(['101'])); await settle();
  assert.equal(store.getSnapshot().rooms[0].status, 'live');
  store.setContext('account42', false); await time.advance(300_000); store.setContext('account42', true); await settle();
  assert.equal(directories, 2); assert.equal(statuses, 1); store.dispose();
});

test('an expired manual directory sync restarts its own generation instead of silently becoming a status refresh', async () => {
  const time = clock(), pages: number[] = []; let syncing = false, statuses = 0;
  const store = new FollowingRoomsStore(async index => {
    pages.push(index); if (index === 2) throw new LocalLoginClientError('UNAVAILABLE', '暂不可用');
    return page(index, [room(syncing ? '2' : '1')], syncing);
  }, time.now, time.timers, async uids => { statuses++; return batch(uids); });
  store.setContext('account42', true, true); await settle(); await time.advance(500); syncing = true; store.reload(); await settle(); await time.advance(500);
  assert.deepEqual(pages, [1, 1, 2]); store.setContext('account42', false); await time.advance(300_000);
  store.setContext('account42', true); await settle();
  assert.deepEqual(pages, [1, 1, 2, 1]); assert.equal(statuses, 0); assert.equal(store.getSnapshot().refreshKind, 'directory');
  assert.equal(store.getSnapshot().rooms[0].roomId, '1'); store.dispose();
});

test('relation bridge accepts a hundred-account logical page and bounds every account list to that page', () => {
  const owners = Array.from({ length: 100 }, (_, index) => String(101 + index));
  const response = relationPage(owners, [room('1')], owners.slice(1));
  assert.equal(readFollowingRoomsPage(response, 1, '42', 'epoch').scannedUids?.length, 100);
  for (const invalid of [
    { ...response, pageSize: 50 }, { ...response, scannedAccounts: 101 },
    { ...response, scannedUids: [...owners, '999'] }, { ...response, unresolvedUids: [...owners, '999'] },
    { ...response, rooms: [{ ...room('1'), uid: '999' }] },
  ]) assert.throws(() => readFollowingRoomsPage(invalid, 1, '42', 'epoch'));
  assert.equal(readFollowingRoomsPage({ ...relationPage(owners.slice(0, 50)), pageSize: 50 }, 1, '42', 'epoch').pageSize, 50);
});

test('explicit room zero is distinct from a missing status and cannot overlap positive room observations', () => {
  const response = { ...batch(['101', '102'], []), noRoomUids: ['102'] };
  assert.deepEqual(readFollowingStatusBatch(response, ['101', '102'], '42', 'epoch').noRoomUids, ['102']);
  for (const noRoomUids of [['999'], ['102', '102'], ['101']]) {
    const value = { ...batch(['101', '102'], [{ uid: '101', roomId: '1', status: 'live', liveStartTime: null }]), noRoomUids };
    assert.throws(() => readFollowingStatusBatch(value, ['101', '102'], '42', 'epoch'));
  }
});

test('known rooms refresh each minute, unresolved accounts only every five minutes, and explicit no-room accounts wait for directory sync', async () => {
  const time = clock(), calls: Array<{ at: number; owners: string[] }> = []; let directories = 0;
  const store = new FollowingRoomsStore(async () => { directories++; return { ...relationPage(['101', '102', '103'], [room('1')], ['102']), resolvedAt: time.now() }; },
    time.now, time.timers, async owners => {
      calls.push({ at: time.now(), owners });
      return { ...batch(owners, owners.map(owner => ({ uid: owner, roomId: String(Number(owner) - 100), status: 'live', liveStartTime: null }))), resolvedAt: time.now() };
    });
  try {
    store.setContext('account42', true, true); await settle();
    assert.equal(store.getSnapshot().complete, true); assert.deepEqual(store.getSnapshot().rooms.map(room => room.roomId), ['1']);
    assert.equal(store.getSnapshot().unmappedCount, 1);
    await time.advance(299_999);
    assert.equal(calls.length, 4); assert.ok(calls.every(call => call.owners.join(',') === '101'));
    await time.advance(1); assert.deepEqual(calls[4].owners, ['101', '102']);
    assert.deepEqual(store.getSnapshot().rooms.map(room => room.roomId), ['1', '2']);
    assert.equal(store.getSnapshot().unmappedCount, 0);
    await time.advance(60_000); assert.deepEqual(calls[5].owners, ['101', '102']);
    assert.equal(directories, 1); assert.ok(calls.every(call => !call.owners.includes('103')));
  } finally { store.dispose(); }
});

test('without known rooms unresolved accounts do not cause minute polling and successful room-zero responses stop the five-minute checks', async () => {
  const time = clock(), calls: string[][] = []; let directories = 0;
  const store = new FollowingRoomsStore(async () => { directories++; return relationPage(['101', '102'], [], ['101']); },
    time.now, time.timers, async owners => { calls.push(owners); return { ...batch(owners, []), noRoomUids: owners, resolvedAt: time.now() }; });
  try {
    store.setContext('account42', true, true); await settle();
    assert.equal(store.getSnapshot().unmappedCount, 1);
    await time.advance(299_999); assert.equal(calls.length, 0); assert.equal(store.getSnapshot().rooms.length, 0);
    await time.advance(1); assert.deepEqual(calls, [['101']]);
    assert.equal(store.getSnapshot().unmappedCount, 0);
    await time.advance(599_999); assert.equal(calls.length, 1); assert.equal(directories, 1);
    await time.advance(1); assert.equal(directories, 2, 'the only remaining deadline is the fifteen-minute directory sync');
  } finally { store.dispose(); }
});

test('a completed relation replacement keeps still-followed missing rooms unknown and removes only explicitly unfollowed owners', async () => {
  const time = clock(); let replacing = false;
  const store = new FollowingRoomsStore(async () => ({ ...(!replacing ? relationPage(['101', '102'], [room('1'), room('2')])
    : relationPage(['101', '103'], [room('3')], ['101'])), resolvedAt: time.now() }), time.now, time.timers);
  try {
    store.setContext('account42', true); await settle(); await time.advance(500); replacing = true; store.reload(); await settle();
    assert.equal(store.getSnapshot().complete, true);
    const rows = store.getSnapshot().rooms;
    assert.deepEqual(rows.map(room => room.roomId).sort(), ['1', '3']);
    assert.equal(rows.find(room => room.roomId === '1')?.status, 'unknown');
    assert.equal(rows.find(room => room.roomId === '1')?.uid, 101); assert.equal(store.getSnapshot().liveCount, null);
  } finally { store.dispose(); }
});

test('room discovery is limited to committed follow UIDs and existing room ownership is never rebound', async () => {
  const time = clock(); let replacing = false;
  const store = new FollowingRoomsStore(async () => ({ ...(!replacing ? relationPage(['101', '102'], [room('1')], ['102'])
    : relationPage(['101', '102'], [{ ...room('9'), uid: '101' }], ['102'])), resolvedAt: time.now() }), time.now, time.timers,
  async owners => ({ ...batch(owners, [
    { uid: '101', roomId: '9', status: 'live', liveStartTime: null },
    { uid: '102', roomId: '1', status: 'live', liveStartTime: null },
    { uid: '999', roomId: '999', status: 'live', liveStartTime: null },
  ]), resolvedAt: time.now() }));
  try {
    store.setContext('account42', true, true); await settle(); await time.advance(500); replacing = true; store.reload(); await settle();
    assert.deepEqual(store.getSnapshot().rooms.map(room => room.roomId), ['1']);
    assert.equal(store.getSnapshot().rooms[0].status, 'unknown');
    await time.advance(300_000);
    assert.deepEqual(store.getSnapshot().rooms.map(room => room.roomId), ['1']);
    assert.equal(store.getSnapshot().rooms[0].uid, 101); assert.equal(store.getSnapshot().rooms[0].status, 'unknown');
  } finally { store.dispose(); }
});

test('one foreground deadline prioritizes the fifteen-minute directory over coinciding status and cancels all background work', async () => {
  const time = clock(); let directories = 0, statuses = 0;
  const store = new FollowingRoomsStore(async () => { directories++; return { ...relationPage(['101'], [room('1')]), resolvedAt: time.now() }; },
    time.now, time.timers, async owners => { statuses++; return { ...batch(owners), resolvedAt: time.now() }; });
  try {
    store.setContext('account42', true, true); await settle(); await time.advance(899_999);
    assert.equal(directories, 1); assert.equal(statuses, 14);
    await time.advance(1); assert.equal(directories, 2); assert.equal(statuses, 14);
    store.setContext('account42', false); await time.advance(3_600_000);
    assert.equal(directories, 2); assert.equal(statuses, 14);
    store.setContext('account42', true); await settle(); assert.equal(directories, 3); assert.equal(statuses, 14);
    await time.advance(60_000); assert.equal(statuses, 15);
  } finally { store.dispose(); }
});

test('an existing room confirmed as room zero keeps its unknown card but waits for directory sync instead of minute polling', async () => {
  const time = clock(); let directories = 0, statuses = 0;
  const store = new FollowingRoomsStore(async () => { directories++; return { ...relationPage(['101'], [room('1')]), resolvedAt: time.now() }; },
    time.now, time.timers, async owners => { statuses++; return { ...batch(owners, []), noRoomUids: owners, resolvedAt: time.now() }; });
  try {
    store.setContext('account42', true, true); await settle(); await time.advance(60_000);
    assert.equal(statuses, 1); assert.equal(store.getSnapshot().rooms[0].status, 'unknown');
    assert.equal(store.getSnapshot().rooms[0].roomId, '1'); assert.equal(store.getSnapshot().unmappedCount, 0);
    await time.advance(60_000); assert.equal(statuses, 1);
    await time.advance(779_999); assert.equal(statuses, 1); assert.equal(directories, 1);
    await time.advance(1); assert.equal(directories, 2); assert.equal(statuses, 1);
    assert.equal(store.getSnapshot().rooms[0].status, 'live');
    await time.advance(60_000); assert.equal(statuses, 2, 'a later positive directory response restores normal status monitoring');
  } finally { store.dispose(); }
});
