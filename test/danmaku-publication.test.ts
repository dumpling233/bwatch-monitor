import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { DanmakuManager } from '../client/multiview/danmaku/manager.js';
import type { DanmakuEvent, DanmakuMessage, DanmakuRoomState, DanmakuWorkerCommand } from '../client/multiview/danmaku/types.js';
import { normalizeDanmaku } from '../client/multiview/danmaku/normalize.js';
import { DanmakuStore } from '../client/multiview/danmaku/store.js';

const flush = async () => { for (let index = 0; index < 160; index++) await Promise.resolve(); };
const message = (roomId: string, id: number, sc = false): DanmakuMessage => ({ id: `${sc ? 'sc' : 'dm'}:${id}`, roomId,
  kind: sc ? 'sc' : 'danmaku', text: String(id), userName: '测试', color: '#ffffff', sourceTime: id, receivedAt: id });
const event = (roomId: string, id: number, sc = false): DanmakuEvent => ({ type: 'message', message: message(roomId, id, sc) });
// Legacy worker metadata must not act as a retention policy during an upgrade.
const legacySc = (roomId: string, id: number, duration = 1000) => ({ ...message(roomId, id, true), expiresAt: Date.now() + duration });

function harness(t: TestContext, modes: Record<string, 'anonymous' | 'authenticated'> = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const commands: DanmakuWorkerCommand[] = [];
  const publications: Record<string, DanmakuRoomState>[] = [];
  const delivered: Array<{ roomId: string; messages: DanmakuMessage[] }> = [];
  const manager = new DanmakuManager({ bootstrap: async roomId => ({ requestedRoomId: roomId, roomId, token: 'test', buvid: 'test', mode: modes[roomId],
    resolvedAt: Date.now(), hosts: [{ host: 'a.chat.bilibili.com', wssPort: 443, url: 'wss://a.chat.bilibili.com/sub' }] }),
  post: command => commands.push(command), changed: rooms => publications.push(rooms),
  messages: (roomId, messages) => delivered.push({ roomId, messages }), random: () => .5 });
  t.after(() => manager.dispose());
  const generation = (roomId: string) => (commands.filter((command): command is Extract<DanmakuWorkerCommand, { type: 'begin' }> =>
    command.type === 'begin' && command.roomId === roomId).at(-1)!).generation;
  return { manager, publications, delivered, commands, generation,
    latest: () => publications.at(-1)!,
    receive: (roomId: string, events: DanmakuEvent[]) => manager.receive({ type: 'events', roomId, generation: generation(roomId), events }),
    start: async (roomIds: string[], published?: string[]) => {
      if (published !== undefined) manager.setPublishedRooms(published);
      manager.setRooms(roomIds); await flush(); t.mock.timers.tick(100);
    } };
}

test('48-room projection preserves every connection state while hidden messages only reach overlay subscribers', async t => {
  const h = harness(t);
  const rooms = Array.from({ length: 48 }, (_, index) => String(index + 1));
  await h.start(rooms, ['1']);
  assert.equal(Object.keys(h.latest()).length, 48);
  const initial = h.latest();
  const overlay: DanmakuMessage[][] = [];
  h.manager.subscribe('2', messages => overlay.push(messages));
  for (const room of rooms.slice(1)) h.receive(room, [event(room, 1)]);
  h.manager.receive({ type: 'batch', batchId: 1, rooms: [{ roomId: '2', generation: h.generation('2'), clearVersion: 0,
    events: [event('2', 2, true)] }] });
  t.mock.timers.tick(100);
  assert.equal(h.publications.length, 1, 'hidden history never publishes a new React snapshot');
  assert.equal(h.delivered.length, 48);
  assert.equal(overlay.length, 2, 'both ordinary and SC messages still reach the overlay');
  assert.ok(h.commands.some(command => command.type === 'ack' && command.batchId === 1));
  assert.strictEqual(initial['2'].messages, initial['48'].messages);
  assert.strictEqual(initial['2'].messages, initial['2'].superChats);

  h.manager.receive({ type: 'state', roomId: '48', generation: h.generation('48'), state: { status: 'live' } });
  t.mock.timers.tick(100);
  assert.equal(h.publications.length, 2);
  assert.equal(h.latest()['48'].status, 'live', 'hidden rooms remain available to the room selector');
  for (const room of rooms.slice(0, -1)) assert.strictEqual(h.latest()[room], initial[room]);
  const live = h.latest();
  h.manager.receive({ type: 'state', roomId: '48', generation: h.generation('48'), state: { status: 'live' } });
  t.mock.timers.tick(100);
  assert.equal(h.publications.length, 2, 'repeated equivalent transport feedback is silent');
  h.manager.receive({ type: 'state', roomId: '48', generation: h.generation('48'), state: { status: 'error', error: 'offline' } });
  t.mock.timers.tick(100);
  assert.equal(h.publications.length, 3);
  assert.equal(h.latest()['48'].status, 'retrying');
  assert.equal(h.latest()['48'].error, 'offline');
  assert.ok(h.latest()['48'].retryAt! > Date.now());
  assert.strictEqual(h.latest()['2'], live['2']);
});

test('switching the published room reveals its bounded retained history and drops the previous room history', async t => {
  const h = harness(t);
  await h.start(['1', '2'], ['1']);
  h.receive('1', [event('1', 1)]); t.mock.timers.tick(100);
  const first = h.latest();
  h.receive('2', Array.from({ length: 620 }, (_, index) => event('2', index)));
  h.receive('2', Array.from({ length: 120 }, (_, index) => event('2', index, true)));
  t.mock.timers.tick(100);
  assert.equal(h.publications.length, 2);
  const selection = ['2'];
  h.manager.setPublishedRooms(selection); selection[0] = '1';
  t.mock.timers.tick(100);
  assert.equal(h.latest()['2'].messages.length, 500);
  assert.equal(h.latest()['2'].superChats.length, 100);
  assert.deepEqual(h.latest()['2'].messages[0].id, 'dm:120');
  assert.equal(h.latest()['1'].messages.length, 0);
  assert.equal(first['1'].messages.length, 1, 'previously published snapshots remain immutable');
  h.manager.setPublishedRooms(['2', '2']); t.mock.timers.tick(100);
  assert.equal(h.publications.length, 3, 'duplicate IDs do not change the published set');
  h.receive('2', [event('2', 621)]); t.mock.timers.tick(100);
  assert.equal(h.publications.length, 4, 'mutating the caller array cannot change the chosen room');
  h.manager.setPublishedRooms(['1']); t.mock.timers.tick(100);
  assert.deepEqual(h.latest()['1'].messages.map(value => value.id), ['dm:1']);
  assert.equal(h.latest()['2'].messages.length, 0);
});

test('pausing publication retains transport and overlay delivery and restores one current selected snapshot', async t => {
  const h = harness(t);
  await h.start(['1', '2'], ['1']);
  const overlay: DanmakuMessage[][] = [];
  h.manager.subscribe('2', messages => overlay.push(messages));
  h.manager.setPublishing(false);
  h.receive('1', [event('1', 1)]);
  h.receive('2', [event('2', 1), event('2', 2, true)]);
  h.manager.receive({ type: 'state', roomId: '2', generation: h.generation('2'), state: { status: 'live' } });
  h.manager.setPublishedRooms(['2']); t.mock.timers.tick(100);
  assert.equal(h.publications.length, 1);
  assert.equal(overlay[0].length, 2);
  h.manager.setPublishing(true); t.mock.timers.tick(100);
  assert.equal(h.publications.length, 2);
  assert.equal(h.latest()['2'].status, 'live');
  assert.equal(h.latest()['2'].messages.length, 1);
  assert.equal(h.latest()['2'].superChats.length, 1);
  assert.equal(h.latest()['1'].messages.length, 0);
  h.manager.setPublishing(true); t.mock.timers.tick(100);
  assert.equal(h.publications.length, 2);
  h.manager.clear('2'); t.mock.timers.tick(100);
  assert.equal(h.publications.length, 3);
  assert.equal(h.latest()['2'].messages.length, 0);
  assert.equal(h.latest()['2'].superChats.length, 0);
  assert.equal(h.latest()['2'].hasGap, false);
  h.manager.clear('2'); t.mock.timers.tick(100);
  assert.equal(h.publications.length, 3, 'clearing an already empty projection has no visible effect');
});

test('the default mode publishes complete histories, while an empty selection publishes only stable room states', async t => {
  const h = harness(t);
  await h.start(['1', '2']);
  h.receive('1', [event('1', 1)]); h.receive('2', [event('2', 1), event('2', 2, true)]);
  t.mock.timers.tick(100);
  assert.equal(h.latest()['1'].messages.length, 1);
  assert.equal(h.latest()['2'].messages.length, 1);
  assert.equal(h.latest()['2'].superChats.length, 1);
  const full = h.latest();
  h.receive('2', [event('2', 1)]); t.mock.timers.tick(100);
  assert.equal(h.publications.length, 2, 'duplicate messages cannot create equivalent snapshots');
  h.manager.setPublishedRooms([]); t.mock.timers.tick(100);
  assert.equal(Object.keys(h.latest()).length, 2);
  assert.ok(Object.values(h.latest()).every(room => !room.messages.length && !room.superChats.length));
  h.receive('2', [event('2', 3)]); t.mock.timers.tick(100);
  assert.equal(h.publications.length, 3);
  h.manager.setPublishedRooms(); t.mock.timers.tick(100);
  assert.strictEqual(h.latest()['1'].messages, full['1'].messages);
  assert.equal(h.latest()['2'].messages.length, 2);
  h.manager.setRooms(['2']); t.mock.timers.tick(100);
  assert.deepEqual(Object.keys(h.latest()), ['2']);
  h.manager.setRooms([]); t.mock.timers.tick(100);
  assert.deepEqual(h.latest(), {});
  h.manager.setRooms([]); t.mock.timers.tick(100);
  assert.equal(h.publications.length, 6);
});

test('SC history remains after its former highlight deadline and only explicit deletion removes it', async t => {
  const h = harness(t);
  await h.start(['1', '2'], ['1']);
  const sc = legacySc('2', 1);
  h.receive('2', [{ type: 'message', message: sc }]); t.mock.timers.tick(100);
  assert.equal(h.publications.length, 1);
  h.manager.setPublishedRooms(['2']); t.mock.timers.tick(100);
  assert.equal(h.latest()['2'].superChats.length, 1);
  t.mock.timers.tick(800); t.mock.timers.tick(100);
  assert.equal(h.publications.length, 2, 'the former deadline schedules no automatic deletion or publication');
  assert.equal(h.latest()['2'].superChats.length, 1);
  h.receive('2', [event('2', 2, true)]); t.mock.timers.tick(100);
  h.receive('2', [{ type: 'delete-sc', roomId: '2', ids: ['sc:2'] }]); t.mock.timers.tick(100);
  assert.deepEqual(h.latest()['2'].superChats.map(message => message.id), ['sc:1']);
  assert.equal(h.publications.length, 4);
  h.manager.setPublishedRooms([]); t.mock.timers.tick(100);
  h.receive('2', [{ type: 'message', message: legacySc('2', 3, 500) }]);
  t.mock.timers.tick(500); t.mock.timers.tick(100);
  assert.equal(h.publications.length, 5, 'hidden traffic schedules no history publication');
  h.manager.setPublishedRooms(['2']); t.mock.timers.tick(100);
  assert.deepEqual(h.latest()['2'].superChats.map(message => message.id), ['sc:1', 'sc:3']);
  h.receive('2', [{ type: 'delete-sc', roomId: '2', ids: ['sc:1', 'sc:3'] }]); t.mock.timers.tick(100);
  assert.equal(h.latest()['2'].superChats.length, 0);
});

test('hidden traffic still publishes when page bounds evict messages from the selected room', async t => {
  const h = harness(t);
  const rooms = Array.from({ length: 8 }, (_, index) => String(index + 1));
  await h.start(rooms, ['1']);
  h.receive('1', Array.from({ length: 500 }, (_, index) => event('1', index)));
  t.mock.timers.tick(100);
  assert.equal(h.latest()['1'].messages.length, 500);
  for (const [index, room] of rooms.slice(1).entries()) h.receive(room,
    Array.from({ length: 500 }, (_, id) => event(room, (index + 1) * 1000 + id)));
  t.mock.timers.tick(100);
  assert.equal(h.publications.length, 3);
  assert.ok(Object.values(h.latest()).every(room => room.messages.length === 0));
  h.manager.setPublishedRooms(['8']); t.mock.timers.tick(100);
  assert.equal(h.latest()['8'].messages.length, 500, 'hidden histories remain available within page limits');
});

test('a closed log retains bounded SC history and overlay delivery without deadline or publication timers', async t => {
  const h = harness(t);
  await h.start(['1', '2'], []);
  const schedule = t.mock.method(globalThis, 'setTimeout');
  const overlay: DanmakuMessage[][] = [];
  h.manager.subscribe('2', messages => overlay.push(messages));
  h.receive('2', [event('2', 1), { type: 'message', message: legacySc('2', 2, 500) }]);
  h.manager.receive({ type: 'batch', batchId: 1, rooms: [{ roomId: '2', generation: h.generation('2'), clearVersion: 0,
    events: [event('2', 3)] }] });
  assert.equal(schedule.mock.calls.filter(call => call.arguments[1] === 100).length, 0,
    'message traffic does not even schedule the unused 100 ms publication scan');
  assert.equal(overlay.flat().length, 3);
  assert.ok(h.commands.some(command => command.type === 'ack' && command.batchId === 1));
  assert.equal(schedule.mock.calls.length, 0, 'SC does not add a highlight-deadline timer while hidden');
  t.mock.timers.tick(500);
  assert.equal(schedule.mock.calls.filter(call => call.arguments[1] === 100).length, 0,
    'elapsed highlight time does not schedule a publication scan either');
  h.manager.setPublishedRooms(['2']); t.mock.timers.tick(100);
  assert.equal(h.latest()['2'].messages.length, 2);
  assert.equal(h.latest()['2'].superChats.length, 1, 'reopening the log restores retained SC after its former deadline');
  h.manager.setPublishedRooms([]); t.mock.timers.tick(100);
  h.manager.receive({ type: 'state', roomId: '2', generation: h.generation('2'), state: { status: 'live' } });
  t.mock.timers.tick(100);
  assert.equal(h.latest()['2'].status, 'live', 'connection feedback still publishes with a closed log');
});

test('settings freeze the published reading snapshot without materializing incoming history and restore the latest view immediately', async t => {
  const h = harness(t);
  await h.start(['1'], ['1']);
  h.manager.setPublishedRooms(['1'], 'danmaku');
  h.receive('1', [event('1', 1), event('1', 1, true)]); t.mock.timers.tick(100);
  const reading = h.latest()['1'].messages;
  assert.equal(reading.length, 1);
  assert.equal(h.latest()['1'].superChats.length, 0);
  const projections = t.mock.method(DanmakuStore.prototype, 'room');
  const schedule = t.mock.method(globalThis, 'setTimeout');
  const connections = h.commands.filter(command => command.type === 'connect').length;
  const before = h.publications.length;
  h.manager.setPublishedRooms(['1'], 'none');
  h.receive('1', [event('1', 2), { type: 'message', message: legacySc('1', 2, 500) }]);
  t.mock.timers.tick(600);
  assert.equal(projections.mock.calls.length, 0, 'settings never ask the store to materialize either history');
  assert.equal(schedule.mock.calls.filter(call => call.arguments[1] === 100).length, 0, 'hidden traffic and elapsed highlight time do not schedule a UI scan');
  assert.equal(h.publications.length, before);
  h.manager.receive({ type: 'state', roomId: '1', generation: h.generation('1'), state: { status: 'live' } });
  t.mock.timers.tick(100);
  assert.equal(h.latest()['1'].status, 'live');
  assert.strictEqual(h.latest()['1'].messages, reading, 'connection updates preserve the virtual list reading snapshot');
  assert.equal(projections.mock.calls.length, 0);

  h.manager.setPublishedRooms(['1'], 'danmaku');
  assert.deepEqual(h.latest()['1'].messages.map(value => value.id), ['dm:1', 'dm:2'], 'returning does not wait for another message or timer');
  assert.deepEqual(reading.map(value => value.id), ['dm:1'], 'the prior anchor snapshot remains immutable');
  assert.ok(projections.mock.calls.every(call => call.arguments[1] === 'danmaku'));
  h.manager.setPublishedRooms(['1'], 'sc');
  assert.deepEqual(h.latest()['1'].superChats.map(value => value.id), ['sc:1', 'sc:2'], 'settings preserve both SC records after the highlight period');
  assert.equal(h.latest()['1'].messages.length, 0);
  assert.equal(h.commands.filter(command => command.type === 'connect').length, connections, 'view changes retain the existing WSS');
  assert.equal(h.delivered.flatMap(item => item.messages).length, 4, 'Canvas delivery remains independent of the sidebar view');
});

test('SC-only publication ignores ordinary message floods while preserving both bounded histories for view switching and clear', async t => {
  const h = harness(t);
  await h.start(['1'], ['1']);
  h.manager.setPublishedRooms(['1'], 'sc');
  h.receive('1', [event('1', 1, true)]); t.mock.timers.tick(100);
  const superChats = h.latest()['1'].superChats;
  const before = h.publications.length;
  const projections = t.mock.method(DanmakuStore.prototype, 'room');
  for (let round = 0; round < 6; round++) {
    h.receive('1', Array.from({ length: 100 }, (_, index) => event('1', round * 100 + index)));
    t.mock.timers.tick(100);
  }
  assert.equal(h.publications.length, before, 'ordinary messages cannot rerender the SC-only log');
  assert.ok(projections.mock.calls.every(call => call.arguments[1] === 'sc'), 'SC publication never expands ordinary history');
  assert.strictEqual(h.latest()['1'].superChats, superChats);
  h.manager.setPublishedRooms(['1'], 'danmaku');
  assert.equal(h.latest()['1'].messages.length, 500);
  assert.equal(h.latest()['1'].messages[0].id, 'dm:100');
  assert.equal(h.latest()['1'].superChats.length, 0);
  h.manager.setPublishedRooms(['1'], 'sc');
  assert.strictEqual(h.latest()['1'].superChats, superChats, 'ordinary view selection does not rebuild the other message array');
  h.manager.clear('1'); t.mock.timers.tick(100);
  assert.equal(h.latest()['1'].superChats.length, 0);
  h.manager.setPublishedRooms(['1'], 'danmaku');
  assert.equal(h.latest()['1'].messages.length, 0, 'clear still applies to both retained histories');
});

test('explicit clear releases frozen settings records immediately and survives suspended publication', async t => {
  const h = harness(t);
  await h.start(['1'], ['1']);
  for (const suspended of [false, true]) {
    h.manager.setPublishedRooms(['1'], 'danmaku');
    h.receive('1', [event('1', suspended ? 2 : 1)]); t.mock.timers.tick(100);
    assert.equal(h.latest()['1'].messages.length, 1);
    h.manager.setPublishedRooms(['1'], 'none');
    if (suspended) h.manager.setPublishing(false);
    h.manager.clear('1');
    if (suspended) { h.manager.setPublishing(true); t.mock.timers.tick(100); }
    assert.equal(h.latest()['1'].messages.length, 0, 'an explicit clear cannot retain frozen text until reopening');
    h.manager.setPublishedRooms(['1'], 'danmaku');
    assert.equal(h.latest()['1'].messages.length, 0);
  }
  h.manager.setPublishedRooms(['1'], 'sc');
  h.receive('1', [event('1', 1, true)]); t.mock.timers.tick(100);
  h.manager.setPublishedRooms(['1'], 'none');
  h.receive('1', [{ type: 'delete-sc', roomId: '1', ids: ['sc:1'] }]);
  h.manager.setPublishedRooms(['1'], 'sc');
  assert.equal(h.latest()['1'].superChats.length, 0, 'hidden SC deletion cannot revive a frozen record');
});

test('hidden room receive mode follows the actual bootstrap and changes again after anonymous reconnect', async t => {
  const modes: Record<string, 'anonymous' | 'authenticated'> = { 2: 'authenticated' };
  const h = harness(t, modes);
  await h.start(['1', '2'], ['1']);
  assert.equal(h.latest()['1'].receiveMode, 'anonymous');
  assert.equal(h.latest()['2'].receiveMode, 'authenticated');
  assert.equal(h.latest()['2'].status, 'connecting', 'bootstrap identity alone does not imply a live connection');
  h.manager.receive({ type: 'state', roomId: '2', generation: h.generation('2'), state: { status: 'live' } });
  t.mock.timers.tick(100);
  assert.equal(h.latest()['2'].status, 'live');
  assert.equal(h.latest()['2'].receiveMode, 'authenticated');
  modes['2'] = 'anonymous'; h.manager.reconnect('2'); await flush(); t.mock.timers.tick(100);
  assert.equal(h.latest()['2'].receiveMode, 'anonymous');
  assert.equal(h.latest()['2'].status, 'connecting');
  h.manager.receive({ type: 'state', roomId: '2', generation: h.generation('2'), state: { status: 'live' } });
  t.mock.timers.tick(100);
  assert.equal(h.latest()['2'].status, 'live');
  assert.equal(h.latest()['2'].receiveMode, 'anonymous');
});

for (const count of [27, 48]) test(`${count} active overlay rooms do not publish hidden sidebar histories under sustained message traffic`, async t => {
  const h = harness(t), ids = Array.from({ length: count }, (_, index) => String(index + 1));
  await h.start(ids, []);
  const before = h.publications.length, started = performance.now();
  for (let round = 0; round < 100; round++) {
    for (const roomId of ids) {
      const events = Array.from({ length: 10 }, (_, index) => normalizeDanmaku(roomId, { cmd: 'DANMU_MSG',
        info: [[0, 1, 25, 0xffffff, Date.now(), `${round}-${roomId}-${index}`], '普通消息与表情替代文字'.repeat(4), [123, '完整用户昵称']] }, Date.now())[0]);
      h.receive(roomId, events);
    }
    t.mock.timers.tick(100);
  }
  const elapsedMs = performance.now() - started;
  assert.equal(h.publications.length, before, 'healthy hidden traffic never republishes the monitor React state');
  assert.equal(h.delivered.reduce((sum, item) => sum + item.messages.length, 0), count * 1000);
  h.manager.setPublishedRooms(); t.mock.timers.tick(100);
  const retained = Object.values(h.latest()).reduce((sum, room) => sum + room.messages.length, 0);
  assert.equal(retained, 3000, 'retained histories remain bounded across every active room');
  t.diagnostic(JSON.stringify({ rooms: count, normalizedAndStoredMessages: count * 1000, elapsedMs: Math.round(elapsedMs), hiddenReactPublications: 0, retainedMessages: retained }));
});
