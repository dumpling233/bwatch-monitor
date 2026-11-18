import assert from 'node:assert/strict';
import test from 'node:test';
import type { CustomRoomRecord } from '../client/multiview/customRooms.js';
import { CustomRoomRefreshScheduler } from '../client/multiview/customRoomRefresh.js';

const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };

function fakeClock() {
  let time = 1_000_000, nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => time,
    size: () => timers.size,
    setTimer(callback: () => void, delay: number) {
      const id = ++nextId;
      timers.set(id, { at: time + Math.max(0, delay), callback });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer(id: ReturnType<typeof setTimeout>) { timers.delete(id as unknown as number); },
    async advance(ms: number) {
      const end = time + ms;
      let iterations = 0;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        assert.ok(++iterations < 10_000, 'scheduler must not spin on an already due room');
        time = due[1].at;
        timers.delete(due[0]);
        due[1].callback();
        await flush();
      }
      time = end;
      await flush();
    },
  };
}

function room(id: string, overrides: Partial<CustomRoomRecord> = {}): CustomRoomRecord {
  return { source: 'custom', input: id, roomId: id, uid: Number(id), anchorName: `主播${id}`, title: '直播',
    status: 'live', online: 99, onlineStale: false, fansCount: null, fansStale: false, guardCount: null,
    guardStale: false, liveStartTime: 1000, lastUpdatedAt: 1, metadataFetchedAt: 1, metadataStale: false, ...overrides };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test('refresh follows the canonical room id when an original short alias changes owners', async () => {
  const clock = fakeClock(), calls: string[] = [], results: CustomRoomRecord[] = [];
  const current = room('4242', { input: '42', metadataFetchedAt: clock.now(), onlineLastSuccessAt: clock.now() });
  const scheduler = new CustomRoomRefreshScheduler({ ...clock,
    resolve: async input => {
      calls.push(input);
      return input === '42' ? room('9999', { title: '短号已被另一房间使用' })
        : { ...current, title: '正确的原房间', metadataFetchedAt: clock.now() };
    }, onResult: (_id, value) => { results.push(value); },
  });
  try {
    scheduler.sync([current], new Set(['4242']));
    await clock.advance(0);
    assert.deepEqual(calls, ['4242']);
    assert.equal(results.at(-1)?.roomId, '4242'); assert.equal(results.at(-1)?.title, '正确的原房间');
  } finally { scheduler.destroy(); }
});

test('mismatched canonical responses never overwrite identity and changing input does not bypass retry cooldown', async () => {
  const clock = fakeClock(), calls: string[] = [], results: CustomRoomRecord[] = [];
  const current = room('4242', { input: '42', metadataFetchedAt: clock.now(), onlineLastSuccessAt: clock.now() });
  const scheduler = new CustomRoomRefreshScheduler({ ...clock,
    resolve: async input => {
      calls.push(input);
      return calls.length === 1 ? room('9999', { title: '错误房间' }) : { ...current, metadataFetchedAt: clock.now() };
    }, onResult: (id, value) => { assert.equal(id, '4242'); results.push(value); },
  });
  try {
    scheduler.sync([current], new Set(['4242']));
    await clock.advance(0);
    assert.equal(results.at(-1)?.roomId, '4242'); assert.equal(results.at(-1)?.title, '直播');
    assert.equal(results.at(-1)?.metadataStale, true);
    scheduler.sync([{ ...current, input: 'https://live.bilibili.com/4242' }], new Set(['4242']));
    await clock.advance(29_999); assert.deepEqual(calls, ['4242']);
    await clock.advance(1); assert.deepEqual(calls, ['4242', '4242']);
    assert.equal(results.at(-1)?.metadataStale, false);
  } finally { scheduler.destroy(); }
});

for (const scenario of [
  { name: 'selected live', selected: true, offline: false, hidden: false, interval: 30_000 },
  { name: 'selected offline', selected: true, offline: true, hidden: false, interval: 30_000 },
  { name: 'unselected candidate', selected: false, offline: true, hidden: false, interval: 60_000 },
  { name: 'background room', selected: true, offline: false, hidden: true, interval: 120_000 },
]) {
  test(`custom metadata refresh uses the ${scenario.name} cadence without early duplicate requests`, async () => {
    const clock = fakeClock(), calls: number[] = [];
    const current = room('1', { status: scenario.offline ? 'offline' : 'live' });
    const scheduler = new CustomRoomRefreshScheduler({ ...clock,
      resolve: async () => { calls.push(clock.now()); return { ...current, metadataFetchedAt: clock.now() }; },
      onResult() {},
    });
    try {
      scheduler.setHidden(scenario.hidden);
      scheduler.sync([current], new Set(scenario.selected ? ['1'] : []));
      await clock.advance(0);
      assert.equal(calls.length, 1, 'persisted expired metadata is refreshed on activation');
      await clock.advance(scenario.interval - 1);
      assert.equal(calls.length, 1);
      await clock.advance(1);
      assert.deepEqual(calls, [1_000_000, 1_000_000 + scenario.interval]);
    } finally { scheduler.destroy(); }
    assert.equal(clock.size(), 0);
  });
}

test('becoming selected or visible refreshes overdue rooms once without replaying missed periods', async () => {
  const clock = fakeClock(), calls: number[] = [];
  const current = room('1');
  const scheduler = new CustomRoomRefreshScheduler({ ...clock,
    resolve: async () => { calls.push(clock.now()); return { ...current, metadataFetchedAt: clock.now() }; }, onResult() {},
  });
  try {
    scheduler.sync([current], new Set());
    await clock.advance(0);
    await clock.advance(45_000);
    scheduler.sync([current], new Set(['1']));
    await clock.advance(0);
    assert.deepEqual(calls, [1_000_000, 1_045_000]);
    scheduler.setHidden(true);
    await clock.advance(90_000);
    assert.equal(calls.length, 2);
    scheduler.setHidden(false);
    scheduler.setHidden(false);
    await clock.advance(0);
    assert.deepEqual(calls, [1_000_000, 1_045_000, 1_135_000]);
    await clock.advance(29_999);
    assert.equal(calls.length, 3);
  } finally { scheduler.destroy(); }
});

test('global starts are spaced by 2200ms and unresolved transports never exceed two actual requests', async () => {
  const clock = fakeClock();
  const pending: Array<{ id: string; started: number; signal: AbortSignal; work: ReturnType<typeof deferred<CustomRoomRecord>> }> = [];
  let active = 0, peak = 0;
  const scheduler = new CustomRoomRefreshScheduler({ ...clock,
    resolve: (id, signal) => {
      const work = deferred<CustomRoomRecord>();
      pending.push({ id, signal, started: clock.now(), work });
      active++; peak = Math.max(peak, active);
      return work.promise.finally(() => { active--; });
    }, onResult() {},
  });
  try {
    scheduler.sync(['1', '2', '3', '4'].map(id => room(id)), new Set(['1', '2', '3', '4']));
    await clock.advance(0);
    assert.equal(pending.length, 1);
    await clock.advance(2199);
    assert.equal(pending.length, 1);
    await clock.advance(1);
    assert.equal(pending.length, 2);
    await clock.advance(20_000);
    assert.equal(pending.length, 2, 'timer ticks cannot overlap stalled work');
    pending[0].work.resolve(room(pending[0].id, { metadataFetchedAt: clock.now() }));
    await flush();
    await clock.advance(0);
    assert.equal(pending.length, 3);
    assert.equal(peak, 2);
    assert.ok(pending.slice(1).every((entry, index) => entry.started - pending[index].started >= 2200));
  } finally {
    scheduler.destroy();
    for (const entry of pending) entry.work.resolve(room(entry.id));
    await flush();
  }
  assert.equal(active, 0);
  assert.equal(clock.size(), 0);
});

test('failure backoff grows from 30 to 300 seconds, survives repeated sync and resets only on healthy success', async () => {
  const clock = fakeClock(), calls: number[] = [];
  const current = room('1');
  const scheduler = new CustomRoomRefreshScheduler({ ...clock,
    resolve: async () => {
      calls.push(clock.now());
      if (calls.length <= 6) throw new Error('fixture upstream unavailable');
      return { ...current, online: 120, metadataFetchedAt: clock.now() };
    }, onResult() {},
  });
  try {
    scheduler.sync([current], new Set(['1']));
    await clock.advance(0);
    for (const delay of [30_000, 60_000, 120_000, 240_000, 300_000, 300_000]) {
      const before = calls.length;
      scheduler.sync([{ ...current }], new Set(['1']));
      await clock.advance(delay - 1);
      assert.equal(calls.length, before);
      await clock.advance(1);
      assert.equal(calls.length, before + 1);
    }
    await clock.advance(29_999);
    assert.equal(calls.length, 7);
    await clock.advance(1);
    assert.equal(calls.length, 8, 'healthy success restores selected-room cadence');
  } finally { scheduler.destroy(); }
});

test('a partially stale response keeps retry backoff instead of being accepted as healthy metadata', async () => {
  const clock = fakeClock(), calls: number[] = [];
  const current = room('1');
  const scheduler = new CustomRoomRefreshScheduler({ ...clock,
    resolve: async () => {
      calls.push(clock.now());
      return { ...current, metadataFetchedAt: clock.now(), onlineStale: calls.length <= 2,
        metadataStale: calls.length <= 2 };
    }, onResult() {},
  });
  try {
    scheduler.sync([current], new Set(['1']));
    await clock.advance(0);
    await clock.advance(30_000);
    assert.equal(calls.length, 2);
    scheduler.sync([{ ...current }], new Set(['1']));
    await clock.advance(59_999);
    assert.equal(calls.length, 2);
    await clock.advance(1);
    assert.equal(calls.length, 3);
    await clock.advance(30_000);
    assert.equal(calls.length, 4);
  } finally { scheduler.destroy(); }
});

for (const onlineStale of [false, true]) {
  test(`a ${onlineStale ? 'partial' : 'healthy'} response respects Retry-After beyond the backoff cap across sync and visibility changes`, async () => {
    const clock = fakeClock(), calls: number[] = [];
    const current = room('1');
    const scheduler = new CustomRoomRefreshScheduler({ ...clock,
      resolve: async () => {
        calls.push(clock.now());
        return { ...current, onlineStale, metadataFetchedAt: clock.now(), retryAfterMs: 600_000 };
      }, onResult() {},
    });
    try {
      scheduler.sync([current], new Set(['1']));
      await clock.advance(0);
      assert.equal(calls.length, 1);
      await clock.advance(300_000);
      scheduler.sync([{ ...current, online: 123 }], new Set());
      scheduler.setHidden(true);
      await clock.advance(100_000);
      scheduler.setHidden(false);
      scheduler.sync([{ ...current, online: 124 }], new Set(['1']));
      await clock.advance(199_999);
      assert.equal(calls.length, 1, 'metadata renders, selection and visibility must not bypass upstream cooldown');
      await clock.advance(1);
      assert.deepEqual(calls, [1_000_000, 1_600_000]);
    } finally { scheduler.destroy(); }
    assert.equal(clock.size(), 0);
  });
}

test('expired viewer counts clear at the age limit without issuing a network request during cooldown', async () => {
  const clock = fakeClock(), calls: number[] = [], results: CustomRoomRecord[] = [];
  const current = room('1', { metadataFetchedAt: clock.now(), onlineLastSuccessAt: clock.now() });
  const scheduler = new CustomRoomRefreshScheduler({ ...clock,
    resolve: async () => {
      calls.push(clock.now());
      throw Object.assign(new Error('upstream cooldown'), { retryAfterMs: 900_000 });
    }, onResult: (_id, value) => { results.push(value); },
  });
  try {
    scheduler.sync([current], new Set(['1']));
    await clock.advance(0);
    assert.equal(calls.length, 1);
    assert.equal(results.at(-1)?.online, 99, 'a failed refresh may keep a still-valid old count');
    assert.equal(results.at(-1)?.onlineStale, true);
    assert.equal(results.at(-1)?.lastUpdatedAt, clock.now(), 'stale merge uses the injected clock');
    await clock.advance(600_000);
    assert.equal(results.at(-1)?.online, 99);
    await clock.advance(1);
    assert.equal(results.at(-1)?.online, null, 'old viewer count must expire even without another fetch');
    assert.equal(results.at(-1)?.onlineStale, true);
    assert.equal(calls.length, 1, 'expiry is a local state update, not a cooldown bypass');
    scheduler.setHidden(true);
    scheduler.setHidden(false);
    scheduler.sync([results.at(-1)!], new Set(['1']));
    await clock.advance(299_998);
    assert.equal(calls.length, 1);
  } finally { scheduler.destroy(); }
  assert.equal(clock.size(), 0);
});

test('removal and readdition use a new generation, discard late work and destroy clears all scheduling', async () => {
  const clock = fakeClock();
  const pending: Array<{ signal: AbortSignal; work: ReturnType<typeof deferred<CustomRoomRecord>> }> = [];
  const results: CustomRoomRecord[] = [];
  const current = room('1', { metadataFetchedAt: clock.now(), onlineLastSuccessAt: clock.now() });
  const scheduler = new CustomRoomRefreshScheduler({ ...clock,
    resolve: (_id, signal) => {
      const work = deferred<CustomRoomRecord>(); pending.push({ signal, work }); return work.promise;
    }, onResult: (_id, value) => { results.push(value); },
  });
  scheduler.sync([current], new Set(['1']));
  await clock.advance(0);
  assert.equal(pending.length, 1);
  scheduler.sync([], new Set());
  assert.equal(pending[0].signal.aborted, true);
  scheduler.sync([current], new Set(['1']));
  pending[0].work.resolve(room('1', { online: 999 }));
  await clock.advance(2200);
  assert.equal(pending.length, 2);
  assert.equal(results.length, 0, 'late old generation must not update the newly added room');
  pending[1].work.resolve(room('1', { online: 123, metadataFetchedAt: clock.now(), onlineLastSuccessAt: clock.now() }));
  await flush();
  assert.equal(results.length, 1);
  assert.equal(results[0].online, 123);
  await clock.advance(30_000);
  assert.equal(pending.length, 3);
  scheduler.destroy();
  assert.equal(pending[2].signal.aborted, true);
  pending[2].work.reject(new Error('late cancellation'));
  await flush();
  await clock.advance(600_000);
  assert.equal(results.length, 1);
  assert.equal(pending.length, 3);
  assert.equal(clock.size(), 0);
});

test('viewport demand only refreshes demanded rooms and preserves completed cadence when cards return', async () => {
  const clock = fakeClock(), calls: Array<{ id: string; at: number }> = [];
  const rooms = ['1', '2'].map(id => room(id, { metadataFetchedAt: clock.now(), onlineLastSuccessAt: clock.now() }));
  const scheduler = new CustomRoomRefreshScheduler({ ...clock,
    resolve: async id => { calls.push({ id, at: clock.now() }); return room(id, { metadataFetchedAt: clock.now(), onlineLastSuccessAt: clock.now() }); },
    onResult() {},
  });
  try {
    scheduler.sync(rooms, new Set(), new Set(['1']));
    await clock.advance(0);
    scheduler.sync(rooms, new Set(), new Set());
    await clock.advance(20_000);
    scheduler.sync(rooms, new Set(), new Set(['1']));
    await clock.advance(39_999);
    assert.deepEqual(calls, [{ id: '1', at: 1_000_000 }]);
    await clock.advance(1);
    assert.deepEqual(calls, [{ id: '1', at: 1_000_000 }, { id: '1', at: 1_060_000 }]);
  } finally { scheduler.destroy(); }
});

test('removing viewport demand cancels work but retains transport slots until settlement and discards late responses', async () => {
  const clock = fakeClock(), results: CustomRoomRecord[] = [];
  const pending: Array<{ id: string; signal: AbortSignal; work: ReturnType<typeof deferred<CustomRoomRecord>> }> = [];
  const rooms = ['1', '2', '3'].map(id => room(id, { metadataFetchedAt: clock.now(), onlineLastSuccessAt: clock.now() }));
  const scheduler = new CustomRoomRefreshScheduler({ ...clock,
    resolve: (id, signal) => { const work = deferred<CustomRoomRecord>(); pending.push({ id, signal, work }); return work.promise; },
    onResult: (_id, value) => { results.push(value); },
  });
  try {
    scheduler.sync(rooms, new Set(), new Set(['1', '2']));
    await clock.advance(2200);
    assert.equal(pending.length, 2);
    scheduler.sync(rooms, new Set(), new Set(['3']));
    assert.ok(pending.every(entry => entry.signal.aborted));
    await clock.advance(10_000);
    assert.equal(pending.length, 2, 'aborting does not pretend that the real transport already settled');
    pending[0].work.resolve(room('1', { online: 999 }));
    await flush();
    await clock.advance(0);
    assert.equal(results.length, 0); assert.equal(pending.length, 3); assert.equal(pending[2].id, '3');
  } finally {
    scheduler.destroy(); for (const entry of pending) entry.work.resolve(room(entry.id)); await flush();
  }
});

test('scrolling away and back does not bypass an upstream retry cooldown', async () => {
  const clock = fakeClock(), calls: number[] = [];
  const rooms = [room('1', { metadataFetchedAt: clock.now(), onlineLastSuccessAt: clock.now() })];
  const scheduler = new CustomRoomRefreshScheduler({ ...clock,
    resolve: async () => { calls.push(clock.now()); throw Object.assign(new Error('cooldown'), { retryAfterMs: 300_000 }); }, onResult() {},
  });
  try {
    scheduler.sync(rooms, new Set(), new Set(['1'])); await clock.advance(0);
    scheduler.sync(rooms, new Set(), new Set()); await clock.advance(100_000);
    scheduler.sync(rooms, new Set(), new Set(['1'])); await clock.advance(199_999);
    assert.equal(calls.length, 1); await clock.advance(1); assert.equal(calls.length, 2);
  } finally { scheduler.destroy(); }
});

test('offline demand retains its snapshot without requests and reconnects once without replaying missed periods', async () => {
  const clock = fakeClock(), calls: number[] = [], results: CustomRoomRecord[] = [];
  const current = room('1', { metadataFetchedAt: clock.now(), onlineLastSuccessAt: clock.now() });
  const scheduler = new CustomRoomRefreshScheduler({ ...clock,
    resolve: async () => { calls.push(clock.now()); return { ...current, metadataFetchedAt: clock.now(), onlineLastSuccessAt: clock.now() }; },
    onResult: (_id, value) => { results.push(value); },
  });
  try {
    scheduler.setOnline(false); scheduler.sync([current], new Set(['1']));
    await clock.advance(300_000); assert.equal(calls.length, 0); assert.equal(results.length, 0);
    assert.equal(current.online, 99);
    scheduler.setOnline(true); scheduler.setOnline(true); await clock.advance(0);
    assert.deepEqual(calls, [1_300_000]); assert.equal(results.at(-1)?.online, 99);
    scheduler.setOnline(true); await clock.advance(29_999); assert.equal(calls.length, 1);
    await clock.advance(1); assert.deepEqual(calls, [1_300_000, 1_330_000]);
  } finally { scheduler.destroy(); }
});

test('disconnect aborts in-flight transports, discards late results and retains real concurrency slots across reconnect', async () => {
  const clock = fakeClock(), results: CustomRoomRecord[] = [];
  const pending: Array<{ id: string; at: number; signal: AbortSignal; work: ReturnType<typeof deferred<CustomRoomRecord>> }> = [];
  const rooms = ['1', '2', '3'].map(id => room(id, { metadataFetchedAt: clock.now(), onlineLastSuccessAt: clock.now() }));
  const scheduler = new CustomRoomRefreshScheduler({ ...clock,
    resolve: (id, signal) => { const work = deferred<CustomRoomRecord>(); pending.push({ id, at: clock.now(), signal, work }); return work.promise; },
    onResult: (_id, value) => { results.push(value); },
  });
  try {
    scheduler.sync(rooms, new Set(['1', '2', '3'])); await clock.advance(2200);
    assert.equal(pending.length, 2);
    scheduler.setOnline(false); assert.ok(pending.every(entry => entry.signal.aborted));
    await clock.advance(10_000); assert.equal(pending.length, 2);
    scheduler.setOnline(true); scheduler.setOnline(true); await clock.advance(0);
    assert.equal(pending.length, 2, 'the real aborted requests retain their slots until settlement');
    pending[0].work.resolve(room('1', { online: 999 })); await flush(); await clock.advance(0);
    assert.equal(results.length, 0); assert.equal(pending.length, 3);
    pending[1].work.resolve(room('2', { online: 999 })); await flush();
    await clock.advance(2199); assert.equal(pending.length, 3);
    await clock.advance(1); assert.equal(pending.length, 4);
    assert.equal(results.length, 0); assert.equal(pending[3].at - pending[2].at, 2200);
  } finally {
    scheduler.destroy(); for (const entry of pending) entry.work.resolve(room(entry.id)); await flush();
  }
});

test('network reconnect does not bypass upstream cooldown and offline viewer samples expire locally', async () => {
  const clock = fakeClock(), calls: number[] = [], results: CustomRoomRecord[] = [];
  const current = room('1', { metadataFetchedAt: clock.now(), onlineLastSuccessAt: clock.now() });
  const scheduler = new CustomRoomRefreshScheduler({ ...clock,
    resolve: async () => { calls.push(clock.now()); throw Object.assign(new Error('upstream cooldown'), { retryAfterMs: 900_000 }); },
    onResult: (_id, value) => { results.push(value); },
  });
  try {
    scheduler.sync([current], new Set(['1'])); await clock.advance(0);
    scheduler.setOnline(false); await clock.advance(600_001);
    assert.equal(calls.length, 1); assert.equal(results.at(-1)?.online, null);
    assert.equal(results.at(-1)?.status, 'unknown');
    scheduler.setOnline(true); scheduler.setOnline(true); await clock.advance(299_998);
    assert.equal(calls.length, 1, 'an online event is not permission to ignore Retry-After');
    await clock.advance(1); assert.deepEqual(calls, [1_000_000, 1_900_000]);
  } finally { scheduler.destroy(); }
});
