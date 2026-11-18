import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DanmakuStore } from '../client/multiview/danmaku/store.js';
import { DanmakuOutputQueue, danmakuOutputLimits } from '../client/multiview/danmaku/outputQueue.js';
import { DanmakuManager } from '../client/multiview/danmaku/manager.js';
import { eventBytes, messageBytes } from '../client/multiview/danmaku/budget.js';
import { OverlayResourceBudget, overlayPageLimits } from '../client/multiview/danmaku/overlayBudget.js';
import type { DanmakuMessage, DanmakuRoomState, DanmakuWorkerCommand, DanmakuWorkerEvent } from '../client/multiview/danmaku/types.js';

const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
const message = (roomId: string, id: number, sc = false): DanmakuMessage => ({ id: `${sc ? 'sc' : 'dm'}:${id}`, roomId, kind: sc ? 'sc' : 'danmaku',
  text: '文'.repeat(sc ? 2000 : 500), userName: '名字', color: '#ffffff', receivedAt: id, sourceTime: id,
  avatarUrl: 'https://i0.hdslb.com/' + 'a'.repeat(900), segments: [{ type: 'text', text: 'b'.repeat(1200) }] });
const event = (roomId: string, id: number, sc = false) => ({ type: 'message' as const, message: message(roomId, id, sc) });
type Batch = Extract<DanmakuWorkerEvent, { type: 'batch' }>;
const config = (roomId: string) => ({ requestedRoomId: roomId, roomId, token: 'test', buvid: 'test', resolvedAt: Date.now(),
  hosts: [{ host: 'a.chat.bilibili.com', wssPort: 443, url: 'wss://a.chat.bilibili.com/sub' }] });

test('history counts every rich field and bounds room/page metadata without sorting each event', () => {
  const store = new DanmakuStore();
  const rich = message('1', 1), plain = { ...rich, avatarUrl: undefined, segments: undefined };
  assert.ok(messageBytes(rich) > messageBytes(plain) + 4000);
  for (let room = 1; room <= 12; room++) {
    store.setState(String(room), {});
    store.apply(Array.from({ length: 500 }, (_, id) => event(String(room), id)));
    assert.ok(store.roomBytes(String(room)) <= 1024 * 1024);
  }
  assert.ok(store.stats().bytes <= 8 * 1024 * 1024);
  assert.ok(store.room('12')!.messages.length < 500);
  const before = store.room('12')!.messages;
  store.setState('12', { status: 'live' });
  assert.strictEqual(store.room('12')!.messages, before, 'state updates preserve immutable list identity');
  store.clear('12'); assert.equal(store.roomBytes('12'), 0);
  store.reset(); assert.equal(store.stats().bytes, 0);
});

test('queue, history and SC snapshots share one measurement for each immutable message', () => {
  const source = message('1', 1, true);
  let reads = 0;
  const rich = { ...source, get segments() { reads++; return source.segments; } };
  const bytes = messageBytes(rich);
  assert.equal(reads, 1);
  for (let index = 0; index < 100; index++) {
    assert.equal(messageBytes(rich), bytes);
    assert.equal(eventBytes({ type: 'message', message: rich }), bytes + 64);
  }
  const store = new DanmakuStore(); store.setState('1', {});
  store.apply([{ type: 'message', message: rich }]);
  store.replaceSuperChats({ 1: [rich] });
  assert.equal(reads, 1, 'handoffs never walk the same rich projection again');
  assert.equal(store.stats().bytes, bytes);
  assert.ok(messageBytes({ ...source, segments: undefined }) < bytes, 'a replacement receives its own measurement');
});

test('an older SC snapshot cannot evict newer rooms merely by being inserted later', () => {
  const store = new DanmakuStore();
  for (let room = 1; room <= 4; room++) store.setState(String(room), {});
  for (let room = 1; room <= 3; room++) store.apply(Array.from({ length: 100 }, (_, index) => ({ type: 'message' as const,
    message: { ...message(String(room), room * 1000 + index, true), avatarUrl: undefined, segments: undefined } })));
  store.replaceSuperChats({ 4: Array.from({ length: 100 }, (_, index) => ({ ...message('4', index, true), avatarUrl: undefined, segments: undefined })) });
  assert.equal(store.room('4')!.superChats.length, 0);
  assert.equal(store.stats().superChats, 300);
  for (const room of ['1', '2', '3']) assert.equal(store.room(room)!.superChats.length, 100);
});

test('retained SC with legacy deadlines still obey room/page counts and byte budgets', () => {
  const store = new DanmakuStore();
  for (let room = 1; room <= 5; room++) {
    const roomId = String(room); store.setState(roomId, {});
    store.apply(Array.from({ length: 150 }, (_, index) => ({ type: 'message' as const,
      message: { ...message(roomId, room * 1000 + index, true), expiresAt: Date.now() - 60_000 } })));
    assert.ok(store.room(roomId)!.superChats.length <= 100);
    assert.ok(store.roomBytes(roomId) <= 1024 * 1024);
  }
  assert.equal(store.stats().superChats, 300);
  assert.ok(store.stats().bytes <= 8 * 1024 * 1024);
  store.clear('5'); assert.equal(store.room('5')!.superChats.length, 0);
  store.remove('4'); assert.equal(store.room('4'), undefined);
  store.reset(); assert.deepEqual(store.stats(), { bytes: 0, messages: 0, superChats: 0 });
});

test('full rich SC snapshots share the 256KiB/200-message budget and commit atomically', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const batches: Batch[] = [], commands: DanmakuWorkerCommand[] = [];
  let latest: Record<string, DanmakuRoomState> = {};
  const output = new DanmakuOutputQueue(batch => batches.push(batch));
  const manager = new DanmakuManager({ bootstrap: async id => config(id), changed: value => { latest = value; }, post: command => {
    commands.push(command);
    if (command.type === 'begin') output.begin(command.roomId, command.generation, command.clearVersion, command.superChats);
    if (command.type === 'clear') output.clear(command.roomId, command.generation, command.clearVersion);
    if (command.type === 'ack') output.ack(command.batchId);
    if (command.type === 'disconnect') output.remove(command.roomId, command.generation);
  } });
  try {
    manager.setRooms(['1', '2', '3']); await flush();
    const generation = (room: string) => commands.find((command): command is Extract<DanmakuWorkerCommand, { type: 'begin' }> => command.type === 'begin' && command.roomId === room)!.generation;
    output.add('1', generation('1'), [event('1', -1)]); t.mock.timers.tick(40);
    for (let room = 1; room <= 3; room++) output.add(String(room), generation(String(room)), Array.from({ length: 600 }, (_, id) => event(String(room), id, true)));
    assert.ok(output.stats().pendingBytes <= danmakuOutputLimits.pageBytes);
    let parts = 0;
    for (let index = 0; index < batches.length; index++) {
      assert.ok(index < 100);
      const batch = batches[index];
      const count = batch.rooms.reduce((sum, room) => sum + room.events.length + (room.superChats?.length ?? 0) + (room.scSnapshot?.messages.length ?? 0), 0);
      const bytes = batch.rooms.reduce((sum, room) => sum + room.events.reduce((n, value) => n + eventBytes(value), 0)
        + (room.superChats ?? room.scSnapshot?.messages ?? []).reduce((n, value) => n + messageBytes(value), 0), 0);
      assert.ok(count <= 200); assert.ok(bytes <= 256 * 1024);
      for (const room of batch.rooms) if (room.scSnapshot) {
        parts++;
        if (!room.scSnapshot.complete) assert.equal(latest[room.roomId]?.superChats.length ?? 0, 0, 'partial snapshot is not published');
      }
      manager.receive(batch); t.mock.timers.tick(100);
    }
    assert.ok(parts > 3);
    for (const room of ['1', '2', '3']) assert.ok(latest[room].superChats.length > 0);
  } finally { manager.dispose(); output.dispose(); }
});

test('a congested chunked SC snapshot survives elapsed highlight time without bypassing explicit deletion or snapshot revisions', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const batches: Batch[] = [], commands: DanmakuWorkerCommand[] = [];
  let latest: Record<string, DanmakuRoomState> = {};
  const output = new DanmakuOutputQueue(batch => batches.push(batch));
  const manager = new DanmakuManager({ bootstrap: async id => config(id), changed: value => { latest = value; }, post: command => {
    commands.push(command);
    if (command.type === 'begin') output.begin(command.roomId, command.generation, command.clearVersion, command.superChats);
    if (command.type === 'ack') output.ack(command.batchId);
  } });
  try {
    manager.setRooms(['1']); await flush();
    const generation = (commands.find(command => command.type === 'begin') as Extract<DanmakuWorkerCommand, { type: 'begin' }>).generation;
    output.add('1', generation, [event('1', -1)]); t.mock.timers.tick(40);
    output.add('1', generation, Array.from({ length: 600 }, (_, id) => ({ type: 'message' as const,
      message: { ...message('1', id, true), expiresAt: Date.now() + 50 } })));
    t.mock.timers.tick(60_000);
    const parts: Batch[] = [];
    let handled = 0;
    const drain = () => {
      for (; handled < batches.length; handled++) {
        assert.ok(handled < 100);
        const batch = batches[handled];
        const count = batch.rooms.reduce((total, room) => total + room.events.length + (room.superChats?.length ?? room.scSnapshot?.messages.length ?? 0), 0);
        const bytes = batch.rooms.reduce((total, room) => total + room.events.reduce((sum, event) => sum + eventBytes(event), 0)
          + (room.superChats ?? room.scSnapshot?.messages ?? []).reduce((sum, message) => sum + messageBytes(message), 0), 0);
        assert.ok(count <= danmakuOutputLimits.batchEvents); assert.ok(bytes <= danmakuOutputLimits.batchBytes);
        if (batch.rooms.some(room => room.scSnapshot)) parts.push(batch);
        manager.receive(batch); t.mock.timers.tick(100);
      }
    };
    drain(); assert.ok(parts.length >= 2); assert.ok(latest['1'].superChats.length > 0);
    assert.ok(output.stats().pendingBytes <= danmakuOutputLimits.pageBytes);
    const removed = latest['1'].superChats[0].id;
    output.add('1', generation, [{ type: 'delete-sc', roomId: '1', ids: [removed] }]); t.mock.timers.tick(40); drain();
    assert.equal(latest['1'].superChats.some(message => message.id === removed), false);
    manager.receive(parts[0]); manager.receive(parts.at(-1)!); t.mock.timers.tick(100);
    assert.equal(latest['1'].superChats.some(message => message.id === removed), false, 'old chunk versions cannot restore an explicitly deleted SC');
  } finally { manager.dispose(); output.dispose(); }
});

test('SC clear and revision replacement discard unfinished snapshot parts', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const commands: DanmakuWorkerCommand[] = []; let latest: Record<string, DanmakuRoomState> = {};
  const manager = new DanmakuManager({ bootstrap: async id => config(id), post: command => commands.push(command), changed: value => { latest = value; } });
  try {
    manager.setRooms(['1']); await flush();
    const generation = (commands.find(command => command.type === 'begin') as Extract<DanmakuWorkerCommand, { type: 'begin' }>).generation;
    const part = (id: string, offset: number, clearVersion: number, complete: boolean): Batch => ({ type: 'batch', batchId: offset + 1, rooms: [{ roomId: '1', generation, clearVersion, events: [],
      scSnapshot: { id, offset, total: 2, messages: [message('1', offset, true)], complete } }] });
    manager.receive(part('1', 0, 0, false)); t.mock.timers.tick(100); assert.equal(latest['1'].superChats.length, 0);
    manager.clear('1'); manager.receive(part('1', 1, 0, true)); t.mock.timers.tick(100); assert.equal(latest['1'].superChats.length, 0);
    manager.receive(part('2', 0, 1, false)); manager.receive(part('3', 0, 1, false));
    manager.receive(part('2', 1, 1, true)); t.mock.timers.tick(100); assert.equal(latest['1'].superChats.length, 0);
    manager.receive(part('3', 1, 1, true)); t.mock.timers.tick(100); assert.equal(latest['1'].superChats.length, 2);
  } finally { manager.dispose(); }
});

test('updates during a chunked SC transfer finish the current version and converge to the next one', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const batches: Batch[] = [], commands: DanmakuWorkerCommand[] = [];
  let latest: Record<string, DanmakuRoomState> = {};
  const output = new DanmakuOutputQueue(batch => batches.push(batch));
  const manager = new DanmakuManager({ bootstrap: async id => config(id), changed: value => { latest = value; }, post: command => {
    commands.push(command);
    if (command.type === 'begin') output.begin(command.roomId, command.generation, command.clearVersion, command.superChats);
    if (command.type === 'ack') output.ack(command.batchId);
  } });
  try {
    manager.setRooms(['1']); await flush();
    const generation = (commands.find(command => command.type === 'begin') as Extract<DanmakuWorkerCommand, { type: 'begin' }>).generation;
    output.add('1', generation, [event('1', -1)]); t.mock.timers.tick(40);
    output.add('1', generation, Array.from({ length: 600 }, (_, id) => event('1', id, true)));
    let completed = 0, last = -1;
    for (let index = 0; index < batches.length; index++) {
      assert.ok(index < 100);
      const part = batches[index].rooms[0]?.scSnapshot;
      if (part?.complete) completed++;
      if (part && index < 10) {
        last = 10000 + index;
        output.add('1', generation, [{ type: 'delete-sc', roomId: '1', ids: ['sc:599'] }, event('1', last, true)]);
      }
      assert.ok(output.stats().pendingBytes <= 4 * 1024 * 1024);
      manager.receive(batches[index]); t.mock.timers.tick(100);
    }
    assert.ok(completed >= 2, 'incoming updates cannot indefinitely restart an unfinished transfer');
    assert.equal(latest['1'].superChats.some(message => message.id === 'sc:599'), false);
    assert.ok(latest['1'].superChats.some(message => message.id === 'sc:' + last));
  } finally { manager.dispose(); output.dispose(); }
});

test('output round-robin keeps a flooded room from starving another room', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const batches: Batch[] = [], output = new DanmakuOutputQueue(batch => batches.push(batch));
  output.begin('1', 1, 0, []); output.begin('2', 2, 0, []);
  output.add('1', 1, [event('1', -1)]); t.mock.timers.tick(40);
  output.add('1', 1, Array.from({ length: 500 }, (_, id) => event('1', id)));
  output.add('2', 2, [event('2', 1)]); output.ack(batches[0].batchId);
  assert.ok(batches[1].rooms.some(room => room.roomId === '2' && room.events.length));
  output.dispose();
});

test('SC survives its former deadline, hidden publication and reconnect snapshots until explicit clear', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const commands: DanmakuWorkerCommand[] = []; let latest: Record<string, DanmakuRoomState> = {};
  const manager = new DanmakuManager({ bootstrap: async id => config(id), post: command => commands.push(command), changed: value => { latest = value; } });
  try {
    manager.setRooms(['1']); await flush();
    const generation = (commands.find(command => command.type === 'begin') as Extract<DanmakuWorkerCommand, { type: 'begin' }>).generation;
    const sc = { ...message('1', 1, true), expiresAt: Date.now() + 1000 };
    manager.receive({ type: 'events', roomId: '1', generation, events: [{ type: 'message', message: sc }] });
    t.mock.timers.tick(100); assert.equal(latest['1'].superChats.length, 1);
    manager.setPublishing(false); t.mock.timers.tick(1000);
    manager.receive({ type: 'batch', batchId: 9, rooms: [{ roomId: '1', generation, clearVersion: 0, events: [], superChats: [sc] }] });
    manager.setPublishing(true); t.mock.timers.tick(100);
    assert.equal(latest['1'].superChats.length, 1);
    manager.reconnect('1'); await flush();
    const resumed = commands.filter((command): command is Extract<DanmakuWorkerCommand, { type: 'begin' }> => command.type === 'begin').at(-1)!;
    assert.deepEqual(resumed.superChats.map(message => message.id), ['sc:1']);
    manager.clear('1');
    manager.receive({ type: 'batch', batchId: 10, rooms: [{ roomId: '1', generation: resumed.generation, clearVersion: 0, events: [], superChats: [sc] }] });
    t.mock.timers.tick(100); assert.equal(latest['1'].superChats.length, 0, 'a late pre-clear snapshot still cannot restore deleted history');
  } finally { manager.dispose(); }
});

test('manager limits bootstrap to two, starts four sockets per second and suspends without losing history', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const pending: Array<() => void> = [], commands: DanmakuWorkerCommand[] = [];
  let active = 0, high = 0, published = 0, latest: Record<string, DanmakuRoomState> = {};
  const manager = new DanmakuManager({ bootstrap: id => new Promise(resolve => { active++; high = Math.max(high, active); pending.push(() => { active--; resolve(config(id)); }); }),
    post: value => commands.push(value), changed: value => { published++; latest = value; } });
  try {
    manager.setRooms(['1', '2', '3', '4', '5', '6']); assert.equal(active, 2);
    for (let round = 0; round < 3; round++) { pending.splice(0).forEach(resolve => resolve()); await flush(); }
    assert.equal(high, 2); assert.equal(commands.filter(command => command.type === 'connect').length, 4);
    t.mock.timers.tick(1000); await flush(); assert.equal(commands.filter(command => command.type === 'connect').length, 6);
    const first = commands.find((command): command is Extract<DanmakuWorkerCommand, { type: 'connect' }> => command.type === 'connect' && command.roomId === '1')!;
    manager.receive({ type: 'events', roomId: '1', generation: first.generation, events: [event('1', 1)] }); t.mock.timers.tick(100);
    manager.setPublishing(false); const before = published;
    manager.setActiveRooms([]); t.mock.timers.tick(1000); assert.equal(published, before);
    manager.setPublishing(true); t.mock.timers.tick(100); assert.equal(latest['1'].messages.length, 1);
    manager.setActiveRooms(['1']); await flush();
    assert.equal(commands.filter(command => command.type === 'connect' && command.roomId === '1').length, 2);
  } finally { manager.dispose(); }
});

test('five consecutive failures escalate to a sixty second cooldown', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let latest: Record<string, DanmakuRoomState> = {};
  const manager = new DanmakuManager({ bootstrap: async () => { throw new Error('offline'); }, post: () => {}, changed: value => { latest = value; }, random: () => 0.5 });
  try {
    manager.setRooms(['1']); await flush();
    for (let failure = 1; failure <= 5; failure++) {
      t.mock.timers.tick(100);
      const wait = latest['1'].retryAt! - Date.now();
      if (failure === 5) { assert.ok(wait >= 59_900); break; }
      t.mock.timers.tick(wait); await flush();
    }
  } finally { manager.dispose(); }
});

test('shared overlay admission bounds active/waiting counts, DPR and physical pixels and releases leases', () => {
  const budget = new OverlayResourceBudget();
  const leases = Array.from({ length: 48 }, () => budget.register(() => {}));
  for (const lease of leases) {
    budget.stageSize(lease, 320, 180, 3);
    budget.setWaiting(lease, 80);
    for (let index = 0; index < 80; index++) budget.acquireSprite(lease, 1000);
  }
  const stats = budget.stats();
  assert.ok(stats.active + stats.waiting <= 480);
  assert.ok(stats.stages <= overlayPageLimits.stagePixels);
  assert.ok(stats.sprites <= overlayPageLimits.spritePixels);
  const one = new OverlayResourceBudget(), lease = one.register(() => {});
  assert.equal(one.stageSize(lease, 100, 100, 4).width, 200);
  leases.forEach(lease => budget.unregister(lease));
  assert.deepEqual(budget.stats(), { rooms: 0, active: 0, waiting: 0, sprites: 0, stages: 0 });
});
