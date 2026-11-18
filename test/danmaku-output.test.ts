import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DanmakuOutputQueue, danmakuOutputLimits as limits } from '../client/multiview/danmaku/outputQueue.js';
import { DanmakuManager } from '../client/multiview/danmaku/manager.js';
import { DanmakuStore } from '../client/multiview/danmaku/store.js';
import { MAX_ADAPTIVE_GRID_ROOMS } from '../client/multiview/adaptiveGrid.js';
import type { DanmakuBootstrap } from '../shared/danmaku.js';
import type { DanmakuEvent, DanmakuMessage, DanmakuWorkerCommand, DanmakuWorkerEvent } from '../client/multiview/danmaku/types.js';

type Batch = Extract<DanmakuWorkerEvent, { type: 'batch' }>;
const message = (roomId: string, id: number, kind: 'danmaku' | 'sc' = 'danmaku'): DanmakuMessage => ({
  id: `${kind}:${id}`, roomId, kind, text: String(id), userName: '用户', color: '#ffffff', sourceTime: id, receivedAt: id,
});
const event = (roomId: string, id: number, kind: 'danmaku' | 'sc' = 'danmaku'): DanmakuEvent => ({ type: 'message', message: message(roomId, id, kind) });
const config = (roomId: string): DanmakuBootstrap => ({ requestedRoomId: roomId, roomId, token: 'test', buvid: 'anonymous-test', resolvedAt: Date.now(),
  hosts: [{ host: 'a.chat.bilibili.com', wssPort: 443, url: 'wss://a.chat.bilibili.com/sub' }] });
const connected = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };
function queue() {
  const batches: Batch[] = [];
  const output = new DanmakuOutputQueue(batch => batches.push(structuredClone(batch)));
  return { output, batches };
}
function drain(output: DanmakuOutputQueue, batches: Batch[], consume: (batch: Batch) => void = () => {}): void {
  for (let index = 0; index < batches.length; index++) {
    assert.ok(index < 100, 'bounded buffers drain within a finite number of batches');
    consume(batches[index]); output.ack(batches[index].batchId);
  }
}

test('output keeps the normal 40ms cadence and per-room event order, with only one unacknowledged batch', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { output, batches } = queue();
  output.begin('1', 1, 0, []);
  output.add('1', 1, [event('1', 1), event('1', 2, 'sc'), { type: 'delete-sc', roomId: '1', ids: ['sc:2'] }, event('1', 3)]);
  t.mock.timers.tick(39); assert.equal(batches.length, 0);
  t.mock.timers.tick(1); assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].rooms[0].events.map(value => value.type === 'message' ? value.message.id : 'delete'), ['danmaku:1', 'sc:2', 'delete', 'danmaku:3']);
  assert.equal(batches[0].rooms[0].superChats, undefined, 'normal traffic stays as ordered SC events');
  output.add('1', 1, [event('1', 4)]);
  t.mock.timers.tick(60000); assert.equal(batches.length, 1);
  output.ack(batches[0].batchId);
  assert.equal(batches.length, 2); assert.equal(batches[1].rooms[0].events[0].type === 'message' && batches[1].rooms[0].events[0].message.id, 'danmaku:4');
  output.dispose();
});

test('no ACK bounds every room and the whole page, retaining the newest ordinary messages', () => {
  const { output, batches } = queue();
  for (let room = 1; room <= MAX_ADAPTIVE_GRID_ROOMS + 1; room++) output.begin(String(room), room, 0, []);
  assert.equal(output.stats().rooms, MAX_ADAPTIVE_GRID_ROOMS);
  for (let room = 1; room <= 12; room++) for (let id = 0; id < 1000; id++) output.add(String(room), room, [event(String(room), room * 10000 + id)]);
  assert.equal(batches.length, 1);
  assert.equal(output.stats().inFlight, 1);
  assert.equal(output.stats().pendingEvents, limits.pageEvents);
  assert.ok(output.stats().pendingBytes <= limits.pageBytes);
  const retained = new Map<string, string[]>();
  drain(output, batches, batch => {
    if (batch.batchId === 1) return;
    for (const room of batch.rooms) for (const value of room.events) if (value.type === 'message') {
      const ids = retained.get(room.roomId) ?? []; ids.push(value.message.id); retained.set(room.roomId, ids);
    }
  });
  assert.ok([...retained.values()].every(ids => ids.length <= limits.roomEvents));
  assert.deepEqual(retained.get('12'), Array.from({ length: 500 }, (_, i) => `danmaku:${120500 + i}`));
  assert.equal(output.stats().pendingEvents, 0); assert.equal(output.stats().inFlight, 0);
  output.dispose();
});

test('the byte budget includes SC state, and malformed, duplicate or late ACKs never grant extra credit', () => {
  const { output, batches } = queue();
  for (let room = 1; room <= 12; room++) output.begin(String(room), room, 0, []);
  output.add('1', 1, Array.from({ length: 200 }, (_, id) => event('1', id)));
  for (let room = 1; room <= 12; room++) for (let id = 0; id < 500; id++) {
    const value = message(String(room), room * 10000 + id); value.text = '文'.repeat(500); value.userName = '名'.repeat(100);
    output.add(String(room), room, [{ type: 'message', message: value }]);
  }
  for (let room = 1; room <= 12; room++) for (let id = 0; id < 100; id++) {
    const value = message(String(room), room * 10000 + id, 'sc'); value.text = '付'.repeat(2000);
    output.add(String(room), room, [{ type: 'message', message: value }]);
  }
  assert.ok(output.stats().pendingBytes <= limits.pageBytes);
  assert.equal(output.stats().scMessages, 300);
  assert.ok(output.stats().pendingEvents < limits.pageEvents, 'long strings hit the byte cap before the event count');
  output.ack(99999); output.ack(-1); output.ack(Number.NaN); assert.equal(batches.length, 1);
  output.ack(batches[0].batchId); assert.equal(batches.length, 2);
  output.ack(batches[0].batchId); assert.equal(batches.length, 2, 'old ACK cannot acknowledge the new batch');
  output.dispose(); output.ack(batches[1].batchId); assert.equal(output.stats().inFlight, 0); assert.equal(batches.length, 2);
});

test('close and reopen discard old pending events but cannot bypass the outstanding posted task', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { output, batches } = queue();
  output.begin('1', 1, 0, []); output.add('1', 1, [event('1', 1)]); t.mock.timers.tick(40);
  output.add('1', 1, [event('1', 2, 'sc')]);
  output.remove('1', 1); output.begin('1', 2, 0, []);
  output.add('1', 1, [event('1', 3)]); output.add('1', 2, [event('1', 4)]);
  output.remove('1', 1); output.clear('1', 1, 10); t.mock.timers.tick(1000);
  assert.equal(batches.length, 1); assert.equal(output.stats().pendingEvents, 1);
  output.ack(batches[0].batchId);
  assert.equal(batches.length, 2); assert.equal(batches[1].rooms[0].generation, 2);
  assert.deepEqual(batches[1].rooms[0].events, [event('1', 4)]);
  output.ack(batches[0].batchId); assert.equal(output.stats().inFlight, 1);
  output.dispose();
});

test('congestion preserves bounded SC order, duplicates, deletion and delete-then-readd across rooms', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { output, batches } = queue();
  const reference = new DanmakuStore(), applied = new DanmakuStore();
  const scChanges = new Map<string, DanmakuEvent[]>();
  for (let room = 1; room <= 12; room++) {
    const id = String(room); output.begin(id, room, 0, []); reference.setState(id, {}); applied.setState(id, {});
  }
  output.add('1', 1, [event('1', -1)]); t.mock.timers.tick(40);
  const send = (roomId: string, value: DanmakuEvent) => {
    const changes = scChanges.get(roomId) ?? []; changes.push(value); scChanges.set(roomId, changes);
    output.add(roomId, Number(roomId), [value]);
  };
  for (let room = 1; room <= 12; room++) for (let id = 0; id < 120; id++) send(String(room), event(String(room), room * 10000 + id, 'sc'));
  send('12', { type: 'delete-sc', roomId: '12', ids: ['sc:120119', 'sc:120118'] });
  send('12', event('12', 120118, 'sc'));
  const duplicate = event('12', 120118, 'sc'); if (duplicate.type === 'message') duplicate.message.text = 'duplicate must not overwrite';
  send('12', duplicate);
  for (const changes of scChanges.values()) reference.apply(changes);
  for (let id = 0; id < 700; id++) output.add('12', 12, [event('12', id)]);
  assert.equal(output.stats().scMessages, Object.values(reference.snapshot()).reduce((sum, room) => sum + room.superChats.length, 0));
  assert.ok(output.stats().pendingEvents <= limits.pageEvents);
  drain(output, batches, batch => {
    for (const room of batch.rooms) applied.apply(room.events);
    applied.replaceSuperChats(Object.fromEntries(batch.rooms.filter(room => room.superChats !== undefined).map(room => [room.roomId, room.superChats!])));
  });
  assert.ok(batches.some(batch => batch.rooms.some(room => room.superChats !== undefined)), 'only congested SC uses a final-state snapshot');
  for (const [id, room] of Object.entries(reference.snapshot())) assert.deepEqual(applied.snapshot()[id].superChats, room.superChats);
  assert.equal(applied.snapshot()['12'].superChats.at(-1)?.id, 'sc:120118');
  output.dispose();
});

test('SC added then deleted in one normal batch does not evict an older visible SC during later congestion', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { output, batches } = queue();
  const applied = new DanmakuStore();
  for (let room = 1; room <= 4; room++) {
    const id = String(room), seed = room <= 3 ? Array.from({ length: 100 }, (_, index) => message(id, room * 1000 + index, 'sc')) : [];
    output.begin(id, room, 0, seed); applied.setState(id, { superChats: seed });
  }
  const initial = Object.values(applied.snapshot()).flatMap(room => room.superChats);
  output.add('4', 4, [event('4', 99999, 'sc'), { type: 'delete-sc', roomId: '4', ids: ['sc:99999'] }]);
  t.mock.timers.tick(40);
  for (const room of batches[0].rooms) applied.apply(room.events);
  output.ack(batches[0].batchId);
  output.add('4', 4, [event('4', -1)]); t.mock.timers.tick(40);
  output.add('4', 4, [{ type: 'delete-sc', roomId: '4', ids: ['sc:missing'] }, ...Array.from({ length: 600 }, (_, index) => event('4', index))]);
  for (let index = 1; index < batches.length; index++) {
    const batch = batches[index];
    for (const room of batch.rooms) applied.apply(room.events);
    applied.replaceSuperChats(Object.fromEntries(batch.rooms.filter(room => room.superChats !== undefined).map(room => [room.roomId, room.superChats!])));
    output.ack(batch.batchId);
  }
  assert.deepEqual(Object.values(applied.snapshot()).flatMap(room => room.superChats), initial);
  output.dispose();
});

function integration() {
  const batches: Batch[] = [], commands: DanmakuWorkerCommand[] = [];
  let latest: ReturnType<DanmakuStore['snapshot']> = {};
  const output = new DanmakuOutputQueue(batch => batches.push(structuredClone(batch)));
  const manager = new DanmakuManager({ bootstrap: async id => config(id), changed: value => latest = value, post: command => {
    commands.push(command);
    if (command.type === 'begin') output.begin(command.roomId, command.generation, command.clearVersion, command.superChats);
    if (command.type === 'clear') output.clear(command.roomId, command.generation, command.clearVersion);
    if (command.type === 'disconnect') output.remove(command.roomId, command.generation);
    if (command.type === 'ack') output.ack(command.batchId);
    if (command.type === 'dispose') output.dispose();
  } });
  const generation = (roomId: string) => (commands.filter((command): command is Extract<DanmakuWorkerCommand, { type: 'begin' }> => command.type === 'begin' && command.roomId === roomId).at(-1)!).generation;
  return { output, manager, batches, commands, generation, latest: () => latest };
}

for (const roomCount of [13, MAX_ADAPTIVE_GRID_ROOMS]) test(`manager and worker output deliver every demanded room at ${roomCount} rooms`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = integration();
  const roomIds = Array.from({ length: roomCount }, (_, i) => String(i + 1));
  try {
    h.manager.setRooms(roomIds); await connected();
    for (let index = 0; index < Math.ceil(roomCount / 4); index++) { t.mock.timers.tick(1000); await connected(); }
    assert.deepEqual(h.commands.filter(command => command.type === 'connect').map(command => command.roomId), roomIds);
    assert.equal(h.output.stats().rooms, roomCount);
    for (const roomId of roomIds) h.output.add(roomId, h.generation(roomId), [event(roomId, Number(roomId)), event(roomId, Number(roomId), 'sc')]);
    t.mock.timers.tick(40);
    drain(h.output, h.batches, batch => h.manager.receive(batch));
    t.mock.timers.tick(100);
    for (const roomId of roomIds) {
      assert.equal(h.latest()[roomId].messages[0]?.id, `danmaku:${roomId}`);
      assert.equal(h.latest()[roomId].superChats[0]?.id, `sc:${roomId}`);
    }
  } finally { h.manager.dispose(); h.output.dispose(); }
});

test('demand caps unique valid rooms at 48 and releases removed rooms before admitting replacements', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = integration();
  const roomIds = Array.from({ length: MAX_ADAPTIVE_GRID_ROOMS }, (_, i) => String(i + 1));
  const extraId = String(MAX_ADAPTIVE_GRID_ROOMS + 1);
  try {
    h.manager.setRooms(['', '-1', '0', 'url', '1', ...roomIds, extraId]); await connected();
    for (let index = 0; index < 12; index++) { t.mock.timers.tick(1000); await connected(); }
    assert.deepEqual(h.commands.filter(command => command.type === 'connect').map(command => command.roomId), roomIds);
    assert.equal(h.output.stats().rooms, MAX_ADAPTIVE_GRID_ROOMS);
    h.output.begin(extraId, 999, 0, []);
    assert.equal(h.output.current(extraId, 999), false, 'the worker independently refuses a 49th room');

    const removedGeneration = h.generation('1');
    const retainedGeneration = h.generation('48');
    h.output.add('1', removedGeneration, [event('1', 1)]);
    h.manager.setRooms([...roomIds.slice(1), extraId]); t.mock.timers.tick(1000); await connected();
    assert.ok(h.commands.some(command => command.type === 'disconnect' && command.roomId === '1'));
    assert.equal(h.output.current('1', removedGeneration), false);
    assert.equal(h.output.stats().rooms, MAX_ADAPTIVE_GRID_ROOMS);
    assert.equal(h.generation('48'), retainedGeneration, 'surviving connections retain their generation');
    h.output.add('1', removedGeneration, [event('1', 2)]);
    h.output.add(extraId, h.generation(extraId), [event(extraId, 49)]);
    t.mock.timers.tick(40);
    drain(h.output, h.batches, batch => h.manager.receive(batch));
    t.mock.timers.tick(100);
    assert.equal(h.latest()['1'], undefined);
    assert.equal(h.latest()[extraId].messages[0]?.id, 'danmaku:49');

    h.manager.setRooms(roomIds.slice(1, 13)); await connected(); t.mock.timers.tick(100);
    assert.equal(h.output.stats().rooms, 12, 'fixed-mode demand releases the extra connections');
    h.manager.setRooms([]); t.mock.timers.tick(100);
    assert.deepEqual(h.latest(), {});
    assert.deepEqual(h.output.stats(), { rooms: 0, pendingEvents: 0, pendingBytes: 0, inFlight: 0, scMessages: 0 });
  } finally { h.manager.dispose(); h.output.dispose(); }
});

test('clear is a version barrier for already posted data and keeps new SC/deletion ordered', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = integration();
  h.manager.setRooms(['1']); await connected();
  const generation = h.generation('1');
  h.output.add('1', generation, [event('1', 1, 'sc'), event('1', 2)]); t.mock.timers.tick(40);
  h.manager.clear('1');
  h.output.add('1', generation, [event('1', 3, 'sc'), event('1', 4, 'sc'), { type: 'delete-sc', roomId: '1', ids: ['sc:3'] }, event('1', 5)]);
  h.manager.receive(h.batches[0]);
  assert.equal(h.batches.length, 2); assert.equal(h.batches[1].rooms[0].clearVersion, 1);
  h.manager.receive(h.batches[1]); t.mock.timers.tick(100);
  assert.deepEqual(h.latest()['1'].messages.map(value => value.id), ['danmaku:5']);
  assert.deepEqual(h.latest()['1'].superChats.map(value => value.id), ['sc:4']);
  h.manager.dispose();
});

test('clear also rejects an already posted congestion snapshot instead of reviving its old SC', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = integration();
  h.manager.setRooms(['1']); await connected();
  const generation = h.generation('1');
  h.output.add('1', generation, [event('1', -1)]); t.mock.timers.tick(40);
  h.output.add('1', generation, Array.from({ length: 600 }, (_, id) => event('1', id, 'sc')));
  h.manager.receive(h.batches[0]);
  assert.equal(h.batches[1].rooms[0].superChats?.length, 100);
  h.manager.clear('1'); h.output.add('1', generation, [event('1', 9000, 'sc')]);
  h.manager.receive(h.batches[1]); h.manager.receive(h.batches[2]); t.mock.timers.tick(100);
  assert.deepEqual(h.latest()['1'].superChats.map(value => value.id), ['sc:9000']);
  h.manager.dispose();
});

test('reconnect keeps delivered SC, rejects old generation batches, and control state bypasses an unacknowledged batch', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = integration();
  h.manager.setRooms(['1']); await connected();
  const first = h.generation('1');
  h.output.add('1', first, [event('1', 1, 'sc')]); t.mock.timers.tick(40); h.manager.receive(h.batches[0]);
  h.output.add('1', first, [event('1', 2, 'sc')]); t.mock.timers.tick(40);
  h.manager.receive({ type: 'state', roomId: '1', generation: first, state: { status: 'live' } }); t.mock.timers.tick(100);
  assert.equal(h.latest()['1'].status, 'live', 'state publication does not wait for the data ACK');
  h.manager.reconnect('1'); await connected();
  const second = h.generation('1'); assert.notEqual(first, second);
  h.output.add('1', second, [event('1', 3, 'sc')]);
  h.manager.receive(h.batches[1]); assert.equal(h.batches.length, 3);
  h.manager.receive(h.batches[2]); t.mock.timers.tick(100);
  assert.deepEqual(h.latest()['1'].superChats.map(value => value.id), ['sc:1', 'sc:3']);
  h.manager.dispose();
});

test('permission removal and disposal discard buffered snapshots and ACK stale batches without resurrecting rooms', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = integration();
  h.manager.setRooms(['1']); await connected();
  const generation = h.generation('1');
  h.output.add('1', generation, [event('1', 1)]); t.mock.timers.tick(40);
  h.output.add('1', generation, Array.from({ length: 600 }, (_, id) => event('1', id, 'sc')));
  h.manager.receive(h.batches[0]);
  assert.equal(h.batches[1].rooms[0].superChats?.length, 100);
  h.manager.setRooms([]); h.manager.receive(h.batches[1]); t.mock.timers.tick(100);
  assert.deepEqual(h.latest(), {}); assert.equal(h.batches.length, 2);
  assert.deepEqual(h.output.stats(), { rooms: 0, pendingEvents: 0, pendingBytes: 0, inFlight: 0, scMessages: 0 });
  h.manager.dispose(); h.manager.receive(h.batches[0]);
  assert.equal(h.commands.at(-1)?.type, 'dispose');
});

test('subscriber failures still acknowledge data so the transport cannot stay blocked', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = integration();
  h.manager.setRooms(['1']); await connected();
  const unsubscribe = h.manager.subscribe('1', () => { throw new Error('subscriber failed'); });
  h.output.add('1', h.generation('1'), [event('1', 1)]); t.mock.timers.tick(40);
  assert.throws(() => h.manager.receive(h.batches[0]), /subscriber failed/);
  assert.equal(h.output.stats().inFlight, 0); assert.equal(h.commands.at(-1)?.type, 'ack');
  unsubscribe(); h.manager.dispose();
});
