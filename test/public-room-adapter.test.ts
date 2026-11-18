import assert from 'node:assert/strict';
import test from 'node:test';
import { BilibiliRoomMetadataAdapter } from '../client/multiview/customRooms.js';

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const info = (roomId = '999') => ({ roomId, uid: 42, anchorName: '主播', title: '直播中', status: 'live',
  online: 0, onlineStale: false, onlineLastSuccessAt: 1_000, liveStartTime: 900,
  metadataFetchedAt: 1_000, metadataStale: false });

test('equivalent room inputs share public metadata work and return the canonical ID with each user input', async () => {
  let calls = 0, release!: (value: unknown) => void;
  const adapter = new BilibiliRoomMetadataAdapter({ now: () => 1_000,
    resolve: async id => { calls++; assert.equal(id, '123'); return new Promise(resolve => { release = resolve; }); } });
  const first = adapter.resolve('123'), second = adapter.resolve('https://live.bilibili.com/123');
  await flush(); assert.equal(calls, 1); release(info());
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.roomId, '999'); assert.equal(b.roomId, '999');
  assert.equal(a.input, '123'); assert.equal(b.input, 'https://live.bilibili.com/123');
  assert.equal(a.online, 0); assert.equal(a.onlineLastSuccessAt, 1_000);
  assert.equal(a.fansCount, null); assert.equal(a.guardCount, null);
});

test('cancelling one metadata consumer preserves the remaining consumer and its extension request', async () => {
  let signal!: AbortSignal, release!: (value: unknown) => void;
  const adapter = new BilibiliRoomMetadataAdapter({ now: () => 1_000,
    resolve: (_id, requestSignal) => { signal = requestSignal; return new Promise(resolve => { release = resolve; }); } });
  const controller = new AbortController();
  const first = adapter.resolve('123', controller.signal), survivor = adapter.resolve('123');
  const rejected = assert.rejects(first, { name: 'AbortError' });
  await flush(); controller.abort(); await rejected;
  assert.equal(signal.aborted, false);
  release(info()); assert.equal((await survivor).roomId, '999');
});

test('all-consumer cancellation frees the room immediately and late extension results cannot replace fresh work', async () => {
  const releases: Array<(value: unknown) => void> = [], signals: AbortSignal[] = [];
  const adapter = new BilibiliRoomMetadataAdapter({ now: () => 1_000, resolve: (_id, signal) => {
    signals.push(signal); return new Promise(resolve => releases.push(resolve));
  } });
  const controller = new AbortController(), old = adapter.resolve('123', controller.signal);
  const rejected = assert.rejects(old, { name: 'AbortError' });
  await flush(); controller.abort(); await rejected;
  assert.equal(signals[0].aborted, true);
  const fresh = adapter.resolve('123'); await flush();
  releases[0]({ ...info(), title: '旧资料' }); releases[1]({ ...info(), title: '新资料' });
  assert.equal((await fresh).title, '新资料'); assert.equal(signals.length, 2);
});

test('a resolver that ignores AbortSignal still times out and does not hold the next request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0, firstSignal!: AbortSignal;
  const adapter = new BilibiliRoomMetadataAdapter({ now: () => 1_000, timeoutMs: 20,
    resolve: (_id, signal) => { calls++; if (calls === 1) { firstSignal = signal; return new Promise(() => {}); } return Promise.resolve(info()); } });
  const first = adapter.resolve('123'), rejected = assert.rejects(first, /超时/);
  await flush(); t.mock.timers.tick(20); await rejected;
  assert.equal(firstSignal.aborted, true);
  assert.equal((await adapter.resolve('123')).roomId, '999'); assert.equal(calls, 2);
});

test('invalid inputs never dispatch and malformed public room data cannot create an invented room', async () => {
  let calls = 0;
  const adapter = new BilibiliRoomMetadataAdapter({ resolve: async () => { calls++; return { arbitrary: 'payload' }; } });
  for (const input of ['https://example.invalid/123', 'https://live.bilibili.com.evil.invalid/123', '0', 'javascript:alert(1)'])
    await assert.rejects(adapter.resolve(input), /有效房间号/);
  assert.equal(calls, 0);
  await assert.rejects(adapter.resolve('123'), /有效直播间资料/); assert.equal(calls, 1);
});
