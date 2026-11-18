import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DanmakuBootstrap } from '../shared/danmaku.js';
import { DanmakuManager } from '../client/multiview/danmaku/manager.js';
import { normalizeDanmaku } from '../client/multiview/danmaku/normalize.js';
import { DanmakuStore } from '../client/multiview/danmaku/store.js';
import type { DanmakuMessage, DanmakuRoomState, DanmakuWorkerCommand } from '../client/multiview/danmaku/types.js';

const bootstrap = (roomId: string): DanmakuBootstrap => ({ requestedRoomId: roomId, roomId, hosts: [1, 2].map(i => ({ host: `a${i}.chat.bilibili.com`, wssPort: 443, url: `wss://a${i}.chat.bilibili.com/sub` })), token: 'test-only', buvid: 'anonymous-test', resolvedAt: Date.now() });
const message = (roomId: string, id: number, kind: 'danmaku' | 'sc' = 'danmaku'): DanmakuMessage => ({ id: `${kind}:${id}`, roomId, kind, text: String(id), userName: '匿名', color: '#ffffff', sourceTime: id, receivedAt: id });
const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

test('normalizer keeps anonymous names and plain text, limits payload, handles SC deletion', () => {
  const events = normalizeDanmaku('1', { cmd: 'DANMU_MSG:4:0', info: [[0, 0, 0, 0xff00ff, 1000], '<b>hello</b>', [0, '某*']] }, 2000000);
  assert.equal(events[0].type, 'message');
  if (events[0].type !== 'message') return;
  assert.equal(events[0].message.userName, '某*'); assert.equal(events[0].message.text, '<b>hello</b>');
  assert.equal(events[0].message.color, '#ff00ff'); assert.equal(events[0].message.sourceTime, 1000000);
  const long = normalizeDanmaku('1', { cmd: 'DANMU_MSG', info: [[], 'a'.repeat(2000), []] })[0];
  assert.equal(long.type === 'message' && long.message.text.length, 500);
  const sc = normalizeDanmaku('1', { cmd: 'SUPER_CHAT_MESSAGE', data: { id: 45, message: 'SC', price: 30, start_time: 1000, user_info: { uname: '用*' } } });
  assert.equal(sc[0].type === 'message' && sc[0].message.price, 30);
  assert.deepEqual(normalizeDanmaku('1', { cmd: 'SUPER_CHAT_MESSAGE_DELETE', data: { ids: [45] } }), [{ type: 'delete-sc', roomId: '1', ids: ['sc:45'] }]);
  assert.deepEqual(normalizeDanmaku('1', { cmd: 'SEND_GIFT' }), []);
});

test('store bounds per-room and whole-page history, clears and applies SC deletion', () => {
  const store = new DanmakuStore();
  for (let room = 1; room <= 12; room++) {
    store.setState(String(room), { status: 'live' });
    store.apply(Array.from({ length: 600 }, (_, i) => ({ type: 'message' as const, message: message(String(room), room * 10000 + i) })));
    store.apply(Array.from({ length: 120 }, (_, i) => ({ type: 'message' as const, message: message(String(room), room * 10000 + i, 'sc') })));
  }
  const all = Object.values(store.snapshot());
  assert.equal(all.reduce((n, room) => n + room.messages.length, 0), 3000);
  assert.equal(all.reduce((n, room) => n + room.superChats.length, 0), 300);
  assert.ok(all.every(room => room.messages.length <= 500 && room.superChats.length <= 100));
  store.apply([{ type: 'delete-sc', roomId: '12', ids: ['sc:120119'] }]);
  assert.ok(!store.snapshot()['12'].superChats.some(sc => sc.id === 'sc:120119'));
  store.clear('12'); assert.equal(store.snapshot()['12'].messages.length, 0);
  store.remove('12'); assert.equal(store.snapshot()['12'], undefined);
});

test('manager diffs demand without reconnecting surviving rooms and ignores removed-room bootstrap', async () => {
  const posted: DanmakuWorkerCommand[] = [];
  const pending = new Map<string, (config: DanmakuBootstrap) => void>();
  const manager = new DanmakuManager({ bootstrap: roomId => new Promise(resolve => pending.set(roomId, resolve)), post: value => posted.push(value), changed: () => {} });
  manager.setRooms(['1', '2']); manager.setRooms(['1']);
  pending.get('1')!(bootstrap('1')); pending.get('2')!(bootstrap('2')); await tick();
  assert.deepEqual(posted.filter(value => value.type === 'connect').map(value => value.roomId), ['1']);
  manager.setRooms(['1', '3']); await tick();
  assert.equal(posted.filter(value => value.type === 'connect').length, 1);
  manager.dispose(); pending.get('3')!(bootstrap('3')); await tick();
  assert.equal(posted.filter(value => value.type === 'connect').length, 1);
  assert.equal(posted.at(-1)?.type, 'dispose');
});

test('room demand changes preserve surviving history while a removed and readded room gets a new generation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const posted: DanmakuWorkerCommand[] = [];
  const requests: Array<{ id: string; source: string | undefined }> = [];
  let snapshot: Record<string, DanmakuRoomState> = {};
  const manager = new DanmakuManager({
    bootstrap: async (id, _force, _signal, source) => { requests.push({ id, source }); return bootstrap(id); },
    post: value => posted.push(value), changed: value => { snapshot = value; }
  });
  const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
  try {
    manager.setRooms(['1', '2'], { 1: 'custom', 2: 'custom' });
    await flush();
    const first = posted.find(value => value.type === 'connect' && value.roomId === '1')! as Extract<DanmakuWorkerCommand, { type: 'connect' }>;
    manager.receive({ type: 'events', roomId: '1', generation: first.generation,
      events: [{ type: 'message', message: message('1', 1) }, { type: 'message', message: message('1', 2, 'sc') }] });
    t.mock.timers.tick(100);
    const history = snapshot['1'];
    manager.setRooms(['3', '1'], { 1: 'custom', 3: 'custom' });
    await flush(); t.mock.timers.tick(100);
    assert.equal(posted.filter(value => value.type === 'connect' && value.roomId === '1').length, 1);
    assert.equal(posted.some(value => value.type === 'disconnect' && value.roomId === '1'), false);
    assert.strictEqual(snapshot['1'].messages, history.messages);
    assert.strictEqual(snapshot['1'].superChats, history.superChats);
    assert.deepEqual(requests, [{ id: '1', source: 'custom' }, { id: '2', source: 'custom' }, { id: '3', source: 'custom' }]);
    // Removing and readding a room recreates only that stream.
    manager.setRooms(['3'], { 3: 'custom' });
    manager.setRooms(['1', '3'], { 1: 'custom', 3: 'custom' });
    await flush(); t.mock.timers.tick(100);
    const replacement = posted.filter(value => value.type === 'connect' && value.roomId === '1').at(-1)! as Extract<DanmakuWorkerCommand, { type: 'connect' }>;
    assert.notEqual(replacement.generation, first.generation);
    assert.equal(posted.filter(value => value.type === 'connect' && value.roomId === '3').length, 1);
    assert.equal(requests.at(-1)?.source, 'custom');
    assert.equal(snapshot['1'].messages.length, 0);
    assert.equal(snapshot['1'].superChats.length, 0);
    manager.receive({ type: 'events', roomId: '1', generation: first.generation,
      events: [{ type: 'message', message: message('1', 999) }] });
    t.mock.timers.tick(100);
    assert.equal(snapshot['1'].messages.length, 0, 'old-source late events cannot restore cleared history');
  } finally { manager.dispose(); }
});

test('manager rotates hosts, honors retry-after, rejects stale events and terminal permission errors', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const posted: DanmakuWorkerCommand[] = []; let snapshots: any = {}; let calls = 0;
  const manager = new DanmakuManager({ bootstrap: async id => { calls++; return bootstrap(id); }, post: value => posted.push(value), changed: value => snapshots = value, random: () => .5 });
  manager.setRooms(['1']); await Promise.resolve(); await Promise.resolve();
  const first = posted.find(value => value.type === 'connect')! as Extract<DanmakuWorkerCommand, { type: 'connect' }>;
  manager.receive({ type: 'state', roomId: '1', generation: first.generation, state: { status: 'error', error: 'offline' } });
  t.mock.timers.tick(1000); await Promise.resolve(); await Promise.resolve();
  const second = posted.filter(value => value.type === 'connect').at(-1)! as Extract<DanmakuWorkerCommand, { type: 'connect' }>;
  assert.equal(second.hostIndex, 1); assert.equal(calls, 1);
  manager.receive({ type: 'events', roomId: '1', generation: first.generation, events: [{ type: 'message', message: message('1', 1) }] });
  manager.receive({ type: 'events', roomId: '1', generation: second.generation, events: [{ type: 'message', message: message('1', 2) }] });
  t.mock.timers.tick(100); assert.deepEqual(snapshots['1'].messages.map((m: DanmakuMessage) => m.id), ['danmaku:2']);
  manager.dispose();
  let retries = 0;
  const limited = new DanmakuManager({ bootstrap: async () => { retries++; throw Object.assign(new Error('cooldown'), { status: 429, retryAfter: 60 }); }, post: () => {}, changed: () => {}, random: () => .5 });
  limited.setRooms(['1']); await Promise.resolve(); await Promise.resolve(); limited.reconnect('1');
  t.mock.timers.tick(59999); await Promise.resolve(); assert.equal(retries, 1);
  t.mock.timers.tick(1); await Promise.resolve(); await Promise.resolve(); assert.equal(retries, 2); limited.dispose();
  let forbiddenCalls = 0;
  const forbidden = new DanmakuManager({ bootstrap: async () => { forbiddenCalls++; throw Object.assign(new Error('hidden'), { status: 404 }); }, post: () => {}, changed: () => {} });
  forbidden.setRooms(['1']); await Promise.resolve(); await Promise.resolve(); t.mock.timers.tick(120000); await Promise.resolve(); assert.equal(forbiddenCalls, 1); forbidden.dispose();
});

test('unexpected bootstrap AbortError retries, while actual removed-room cancellation stays stopped', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const posted: DanmakuWorkerCommand[] = [];
  let attempts = 0;
  const manager = new DanmakuManager({ bootstrap: async roomId => {
    if (++attempts === 1) throw new DOMException('request interrupted', 'AbortError');
    return bootstrap(roomId);
  }, post: value => posted.push(value), changed: () => {}, random: () => .5 });
  try {
    manager.setRooms(['1']); await Promise.resolve(); await Promise.resolve();
    t.mock.timers.tick(1000); await Promise.resolve(); await Promise.resolve();
    assert.equal(attempts, 2);
    assert.equal(posted.filter(value => value.type === 'connect').length, 1);
  } finally { manager.dispose(); }

  let cancelledAttempts = 0;
  let aborted = false;
  const removed = new DanmakuManager({ bootstrap: (_roomId, _refresh, signal) => {
    cancelledAttempts++;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
      aborted = true; reject(new DOMException('removed', 'AbortError'));
    }, { once: true }));
  }, post: () => {}, changed: () => {} });
  try {
    removed.setRooms(['2']); removed.setRooms([]); await Promise.resolve(); await Promise.resolve();
    t.mock.timers.tick(60000); await Promise.resolve();
    assert.equal(aborted, true); assert.equal(cancelledAttempts, 1);
  } finally { removed.dispose(); }
});
