import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PublicAvatarCache, PUBLIC_AVATAR_CACHE_KEY, PUBLIC_AVATAR_CACHE_LIMITS } from '../lib/publicAvatarCache';

const face = (suffix = '') => `https://i0.hdslb.com/bfs/face/avatar${suffix}.jpg`;
const instant = 1_000_000;
const row = (uid: string, usedAt = instant, fetchedAt = instant, avatar = face()) => ({ uid, face: avatar, fetchedAt, usedAt });
function fixture(source: unknown = undefined) {
  let now = instant, stored: Record<string, unknown> = { [PUBLIC_AVATAR_CACHE_KEY]: source }, writes = 0;
  const storage = { get: async () => structuredClone(stored), set: async (value: Record<string, unknown>) => { writes++; stored = { ...stored, ...structuredClone(value) }; } };
  const cache = new PublicAvatarCache(storage, () => now);
  return { cache, storage, get stored() { return stored; }, get writes() { return writes; }, set now(value: number) { now = value; } };
}

test('20,000 repeated messages reuse a single UID record without storage writes per message', async () => {
  const item = fixture(); await item.cache.ready;
  item.cache.set('7', face()); await item.cache.flush();
  item.now = instant + 60_000;
  for (let i = 0; i < 20_000; i++) assert.equal(item.cache.get('7')?.face, face());
  await item.cache.flush();
  assert.equal(item.cache.snapshot().entries, 1); assert.equal(item.writes, 1);
  const restored = new PublicAvatarCache(item.storage, () => instant + 120_000); await restored.ready;
  assert.deepEqual(restored.get('7'), { uid: '7', face: face(), avatarFetchedAt: instant, avatarCacheHit: true });
});

test('cache hits touch idle time without renewing the original one-day freshness', async () => {
  const item = fixture(); await item.cache.ready;
  item.cache.set('7', face()); await item.cache.flush();
  item.now = instant + PUBLIC_AVATAR_CACHE_LIMITS.freshMs - 1;
  assert.equal(item.cache.get('7')?.avatarFetchedAt, instant); await item.cache.flush();
  item.now = instant + PUBLIC_AVATAR_CACHE_LIMITS.freshMs;
  assert.equal(item.cache.get('7'), undefined); await item.cache.flush();
  assert.equal(item.cache.snapshot().entries, 0);
  assert.deepEqual((item.stored[PUBLIC_AVATAR_CACHE_KEY] as { rows: unknown[] }).rows, []);
});

test('restore projects public fields, drops invalid identity, expired, future and forbidden URLs', async () => {
  const item = fixture({ schemaVersion: 1, rows: [
    { ...row('7'), name: 'private-name', accountUid: '42', csrf: 'private-csrf', role: 'moderator' },
    row('0'), row('8', instant + 1), row('9', instant, -PUBLIC_AVATAR_CACHE_LIMITS.freshMs),
    row('10', instant, instant, 'https://evil.test/image.jpg'), row('11', instant, instant, 'https://i0.hdslb.com/face.jpg#secret'),
  ] });
  await item.cache.ready; await item.cache.flush();
  assert.equal(item.cache.snapshot().entries, 1);
  assert.deepEqual((item.stored[PUBLIC_AVATAR_CACHE_KEY] as { rows: unknown[] }).rows, [row('7')]);
  const serialized = JSON.stringify(item.stored);
  assert.equal(serialized.includes('private-'), false); assert.equal(serialized.includes('moderator'), false);
});

test('count limit evicts least recently used UID, independently of the message count', async () => {
  const item = fixture(); await item.cache.ready;
  for (let uid = 1; uid <= PUBLIC_AVATAR_CACHE_LIMITS.entries; uid++) item.cache.set(String(uid), face(String(uid)));
  item.now = instant + 1; item.cache.get('1');
  item.cache.set('2049', face('2049'));
  assert.equal(item.cache.snapshot().entries, PUBLIC_AVATAR_CACHE_LIMITS.entries);
  assert.equal(item.cache.get('2'), undefined); assert.equal(item.cache.get('1')?.face, face('1'));
  await item.cache.flush();
});

test('malformed or oversized persisted caches are discarded and repaired without restoring partial identities', async () => {
  for (const source of [{ schemaVersion: 99, rows: [row('7')] },
    { schemaVersion: 1, rows: Array.from({ length: PUBLIC_AVATAR_CACHE_LIMITS.entries + 1 }, (_, index) => row(String(index + 1))) },
    { schemaVersion: 1, rows: [row('7')], unwanted: 'x'.repeat(PUBLIC_AVATAR_CACHE_LIMITS.bytes / 2) }]) {
    const item = fixture(source); await item.cache.ready; await item.cache.flush();
    assert.equal(item.cache.snapshot().entries, 0);
    assert.deepEqual((item.stored[PUBLIC_AVATAR_CACHE_KEY] as { rows: unknown[] }).rows, []);
  }
});

test('byte limit evicts old rows before the UID count limit and bounds the persisted JSON', async () => {
  const item = fixture(); await item.cache.ready;
  const longFace = face('x'.repeat(1800));
  for (let uid = 1; uid <= 1200; uid++) item.cache.set(String(uid), longFace);
  assert.ok(item.cache.snapshot().entries < 1200); assert.equal(item.cache.get('1'), undefined);
  assert.equal(item.cache.get('1200')?.face, longFace);
  assert.ok(item.cache.snapshot().bytes <= PUBLIC_AVATAR_CACHE_LIMITS.bytes);
  await item.cache.flush();
  assert.ok(JSON.stringify(item.stored[PUBLIC_AVATAR_CACHE_KEY]).length * 2 <= PUBLIC_AVATAR_CACHE_LIMITS.bytes);
});

test('24h without use is removed lazily when another UID is requested', async () => {
  const item = fixture(); await item.cache.ready;
  item.cache.set('7', face()); await item.cache.flush();
  item.now = instant + PUBLIC_AVATAR_CACHE_LIMITS.idleMs;
  assert.equal(item.cache.get('8'), undefined); assert.equal(item.cache.snapshot().entries, 0);
  await item.cache.flush();
});

test('clear defeats delayed restore, queued writes and an older in-flight storage write', async () => {
  let finishRead!: (value: Record<string, unknown>) => void;
  let stored: Record<string, unknown> = {}, finishWrite: (() => void) | undefined;
  let gateWrites = false;
  const storage = {
    get: () => new Promise<Record<string, unknown>>(resolve => { finishRead = resolve; }),
    set: async (value: Record<string, unknown>) => {
      if (gateWrites) { gateWrites = false; await new Promise<void>(resolve => { finishWrite = resolve; }); }
      stored = structuredClone(value);
    },
  };
  const cache = new PublicAvatarCache(storage, () => instant);
  cache.clear(); finishRead({ [PUBLIC_AVATAR_CACHE_KEY]: { schemaVersion: 1, rows: [row('7')] } });
  await cache.ready; await cache.flush(); assert.equal(cache.snapshot().entries, 0);
  gateWrites = true; cache.set('8', face()); const oldWrite = cache.flush();
  await new Promise(resolve => setImmediate(resolve));
  cache.clear(); cache.set('9', face('9'));
  const currentWrite = cache.flush(); finishWrite!(); await oldWrite; await currentWrite;
  assert.deepEqual((stored[PUBLIC_AVATAR_CACHE_KEY] as { rows: unknown[] }).rows, [row('9', instant, instant, face('9'))]);
});

test('optional storage rejection preserves memory service and retries only on demand', async () => {
  let rejectWrites = true, writes = 0;
  const storage = { get: async () => { throw new Error('read unavailable'); }, set: async () => { writes++; if (rejectWrites) throw new Error('quota'); } };
  const cache = new PublicAvatarCache(storage, () => instant); await cache.ready;
  cache.set('7', face()); await cache.flush(); assert.equal(cache.get('7')?.face, face());
  rejectWrites = false; await cache.flush(); assert.equal(writes, 2);
  assert.equal(cache.snapshot().entries, 1);
});
