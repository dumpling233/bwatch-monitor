import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EmoticonCatalog, EMOTICON_CATALOG_FRESH_MS, EMOTICON_CATALOG_IDLE_MS,
  EMOTICON_CATALOG_KEY, EMOTICON_CATALOG_MAX_BYTES, catalogBytes } from '../lib/emoticonCatalog';
import { projectEmoticons } from '../lib/emoticons';
import type { LocalChatContext } from '../../shared/localDanmaku';

const fixture = (count = 2, path = '') => ({
  emoticons: Array.from({ length: count }, (_, index) => ({ unique: `emote:${index}`, text: `[表情${index}]`,
    url: `https://i0.hdslb.com/bfs/emote/${path}${index}.png`, permitted: index === 0,
    packageName: '房间表情', packageId: 'room', kind: 'image' as const, ...(index ? { unlockHint: '需要加入本直播间主播的粉丝团' } : {}) })),
  emoticonPackages: [{ id: 'room', name: '房间表情', icon: 'https://i0.hdslb.com/room.png', type: 2,
    emoticonUniques: Array.from({ length: count }, (_, index) => `emote:${index}`) }], emoticonsTruncated: false });
function harness(initial: Record<string, unknown> = {}) {
  let now = 1_000_000_000, stored = structuredClone(initial), writes = 0, fail = false;
  let beforeGet: (() => Promise<void>) | undefined, beforeSet: (() => Promise<void>) | undefined;
  const storage = { get: async () => { await beforeGet?.(); return structuredClone(stored); },
    set: async (value: Record<string, unknown>) => { writes++; await beforeSet?.(); if (fail) throw new Error('disk unavailable');
      stored = { ...stored, ...structuredClone(value) }; } };
  const create = () => new EmoticonCatalog(storage, () => now);
  return { create, storage, get stored() { return stored; }, get writes() { return writes; },
    get now() { return now; }, set now(value: number) { now = value; }, set fail(value: boolean) { fail = value; },
    set beforeGet(value: (() => Promise<void>) | undefined) { beforeGet = value; },
    set beforeSet(value: (() => Promise<void>) | undefined) { beforeSet = value; } };
}

test('display catalogs survive worker reconstruction and retain ordered room groups only', async () => {
  const item = harness(), cache = item.create(); await cache.ready;
  cache.set('42', '1001', '1', { ...fixture(), authEpoch: 'must-not-persist', muted: true, cooldownSeconds: 99 } as LocalChatContext);
  await cache.flush();
  const serialized = JSON.stringify(item.stored);
  assert.doesNotMatch(serialized, /authEpoch|must-not-persist|muted|cooldownSeconds/);
  const restarted = item.create(); await restarted.ready;
  assert.deepEqual(restarted.peek('42', '1')?.directory, fixture());
  assert.equal(restarted.peek('42', '1001')?.fresh, true);
  assert.equal(restarted.peek('43', '1'), undefined);
  assert.equal(restarted.peek('42', '2'), undefined, 'a catalog is never invented for another room');
});

test('projected biliimg directory images and covers retain the 2048-character contract after restart', async () => {
  const prefix = 'https://i0.biliimg.com/';
  const atLimit = prefix + 'a'.repeat(2048 - prefix.length);
  const value = projectEmoticons([{ pkg_id: 'room', pkg_type: 2, pkg_name: '房间表情', current_cover: atLimit,
    emoticons: [{ emoticon_unique: 'room_1', emoji: '专属', url: atLimit, perm: 0 }] }]);
  const item = harness(), cache = item.create(); await cache.ready;
  await cache.set('42', '1001', '1', value);
  const restarted = item.create(); await restarted.ready;
  assert.deepEqual(restarted.peek('42', '1')?.directory, value);
  assert.equal(restarted.peek('42', '1')?.directory.emoticons[0].permitted, false);
  assert.equal(restarted.peek('43', '1'), undefined);
});

test('persisted CDN validation rejects credentials, ports, fragments and unsafe or oversized URLs', async () => {
  const base = harness(), cache = base.create(); await cache.ready;
  await cache.set('42', '1001', '1', fixture());
  const source = base.stored[EMOTICON_CATALOG_KEY] as { schemaVersion: number; rows: Array<{ directory: ReturnType<typeof fixture> }> };
  for (const url of ['https://biliimg.com.evil.test/a.png', 'http://i0.biliimg.com/a.png', '//i0.biliimg.com/a.png',
    'https://user@i0.biliimg.com/a.png', 'https://i0.biliimg.com:8443/a.png', 'https://i0.biliimg.com/a.png#fragment',
    'https://i0.biliimg.com/a b.png', 'https://i0.biliimg.com/a\\b.png', `https://i0.biliimg.com/${'a'.repeat(2048)}`]) {
    const stored = structuredClone(source);
    stored.rows[0].directory.emoticons[0].url = url;
    const restored = harness({ [EMOTICON_CATALOG_KEY]: stored }).create(); await restored.ready;
    assert.equal(restored.peek('42', '1'), undefined, url);
  }
});

test('one day freshness and seven day display inactivity are distinct demand-only limits', async () => {
  const item = harness(), cache = item.create(); await cache.ready;
  cache.set('42', '1001', '1', fixture()); await cache.flush();
  item.now += EMOTICON_CATALOG_FRESH_MS;
  assert.equal(cache.peek('42', '1')?.fresh, false);
  cache.touch('42', '1001'); await cache.flush();
  item.now += EMOTICON_CATALOG_IDLE_MS - 1;
  assert.ok(cache.peek('42', '1'));
  item.now++;
  assert.equal(cache.peek('42', '1'), undefined);
  await cache.flush();
  assert.deepEqual((item.stored[EMOTICON_CATALOG_KEY] as { rows: unknown[] }).rows, [], 'demand-driven expiry also removes the disk entry');
  const restarted = item.create(); await restarted.ready;
  assert.equal(restarted.peek('42', '1'), undefined);
});

test('restoring an idle catalog prunes the persisted entry without a scheduled sweep', async () => {
  const item = harness(), cache = item.create(); await cache.ready;
  await cache.set('42', '1001', '1', fixture());
  item.now += EMOTICON_CATALOG_IDLE_MS;
  const restarted = item.create(); await restarted.ready; await restarted.flush();
  assert.deepEqual((item.stored[EMOTICON_CATALOG_KEY] as { rows: unknown[] }).rows, []);
  const writes = item.writes;
  restarted.peek('42', '1'); restarted.peek('42', '1'); await restarted.flush();
  assert.equal(item.writes, writes, 'empty peeks do not repeatedly rewrite storage');
});

test('frequent openings coalesce touch writes but still persist hourly use', async () => {
  const item = harness(), cache = item.create(); await cache.ready;
  cache.set('42', '1001', '1', fixture()); await cache.flush();
  const initial = item.writes;
  for (let minute = 0; minute < 59; minute++) { item.now += 60_000; cache.touch('42', '1001'); }
  await cache.flush(); assert.equal(item.writes, initial);
  item.now += 60_000; cache.touch('42', '1001'); await cache.flush();
  assert.equal(item.writes, initial + 1);
  item.now += EMOTICON_CATALOG_IDLE_MS - 1;
  const restarted = item.create(); await restarted.ready;
  assert.ok(restarted.peek('42', '1'), 'recent persisted use survives a worker sleep');
});

test('repeated identical send-time permission reads do not rewrite the entire catalog per send', async () => {
  const item = harness(), cache = item.create(); await cache.ready;
  cache.set('42', '1001', '1', fixture()); await cache.flush();
  const initial = item.writes;
  for (let index = 0; index < 20; index++) { item.now += 1000; cache.set('42', '1001', '1', fixture()); }
  await cache.flush(); assert.equal(item.writes, initial);
  const updated = fixture(); updated.emoticons[0].permitted = false;
  cache.set('42', '1001', '1', updated); await cache.flush(); assert.equal(item.writes, initial + 1);
});

test('room count is capped at 32 with least recently displayed eviction', async () => {
  const item = harness(), cache = item.create(); await cache.ready;
  for (let index = 1; index <= 32; index++) { cache.set('42', String(1000 + index), String(index), fixture()); item.now++; }
  cache.touch('42', '1001'); item.now++;
  cache.set('42', '1033', '33', fixture()); await cache.flush();
  assert.ok(cache.peek('42', '1')); assert.equal(cache.peek('42', '2'), undefined);
  assert.equal((item.stored[EMOTICON_CATALOG_KEY] as { rows: unknown[] }).rows.length, 32);
});

test('serialized application payload including row metadata stays within four MiB', async () => {
  const item = harness(), cache = item.create(); await cache.ready;
  const large = fixture(512, 'p'.repeat(600));
  assert.ok(catalogBytes(large) < 1600 * 1024);
  for (let index = 1; index <= 10; index++) { cache.set('42', String(1000 + index), String(index), large); item.now++; }
  await cache.flush();
  const snapshot = item.stored[EMOTICON_CATALOG_KEY];
  assert.ok(catalogBytes(snapshot) <= EMOTICON_CATALOG_MAX_BYTES);
  assert.ok(cache.peek('42', '10')); assert.equal(cache.peek('42', '1'), undefined);
  assert.ok((snapshot as { rows: unknown[] }).rows.length < 10);
});

test('damaged catalogs, foreign image hosts and unsupported schema cannot restore', async () => {
  const base = harness(), cache = base.create(); await cache.ready;
  cache.set('42', '1001', '1', fixture()); await cache.flush();
  const rows = (base.stored[EMOTICON_CATALOG_KEY] as { rows: Array<{ directory: ReturnType<typeof fixture> }> }).rows;
  rows[0].directory.emoticons[0].url = 'https://bwatch.icu/proxy/image';
  const item = harness({ [EMOTICON_CATALOG_KEY]: { schemaVersion: 1, rows } }), restored = item.create(); await restored.ready;
  assert.equal(restored.peek('42', '1'), undefined);
  const unsupported = harness({ [EMOTICON_CATALOG_KEY]: { schemaVersion: 2, rows } }).create(); await unsupported.ready;
  assert.equal(unsupported.peek('42', '1'), undefined);
});

test('optional storage failures preserve memory functionality', async () => {
  const item = harness(), cache = item.create(); await cache.ready; item.fail = true;
  cache.set('42', '1001', '1', fixture()); await cache.flush();
  assert.deepEqual(cache.peek('42', '1')?.directory, fixture());
  cache.clear(); await cache.flush(); assert.equal(cache.peek('42', '1'), undefined);
});

test('late restoration cannot revive catalogs cleared by logout or revocation', async () => {
  const item = harness(), initial = item.create(); await initial.ready;
  initial.set('42', '1001', '1', fixture()); await initial.flush();
  let release!: () => void;
  item.beforeGet = () => new Promise(resolve => { release = resolve; });
  const pending = item.create(); pending.clear();
  release(); await pending.ready; await pending.flush();
  assert.equal(pending.peek('42', '1'), undefined);
  assert.deepEqual((item.stored[EMOTICON_CATALOG_KEY] as { rows: unknown[] }).rows, []);
});

test('a late disk write is followed by the clear, never the other way round', async () => {
  const item = harness(), cache = item.create(); await cache.ready;
  let release!: () => void, started!: () => void;
  const begun = new Promise<void>(resolve => { started = resolve; });
  item.beforeSet = () => { started(); return new Promise(resolve => { release = resolve; }); };
  cache.set('42', '1001', '1', fixture()); await begun;
  cache.clear(); item.beforeSet = undefined; release(); await cache.flush();
  assert.deepEqual((item.stored[EMOTICON_CATALOG_KEY] as { rows: unknown[] }).rows, []);
  const restarted = item.create(); await restarted.ready; assert.equal(restarted.peek('42', '1'), undefined);
});
