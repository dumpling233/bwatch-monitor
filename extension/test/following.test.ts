import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AccountVerificationRequired, BrokerError, LocalLoginBroker } from '../lib/broker';
import { LocalCookieTransport } from '../lib/cookieTransport';
import { LocalFollowingService, FOLLOWING_RELATIONS_API, FOLLOWING_STATUS_API, FOLLOWING_ROOM_INIT_API, FOLLOWING_ROOM_BASE_API, FOLLOWING_ROOM_INFO_API, FOLLOWING_ONLINE_API, FOLLOWING_PAGE_SIZE, projectFollowingPage, projectFollowingStatus } from '../lib/following';
import { LoginSessions } from '../lib/loginSessions';

const origin = 'https://bwatch.icu';
const OLD_FOLLOWING_API = 'https://api.live.bilibili.com/xlive/web-ucenter/user/following';
const signal = () => new AbortController().signal;
const cookie = (name: string, value: string) => ({ name, value, domain: '.bilibili.com', path: '/', session: true,
  storeId: '0', secure: true, httpOnly: true, hostOnly: false, sameSite: 'lax' }) as chrome.cookies.Cookie;
const row = (roomid = 1001, uid = 42) => ({ roomid, uid, uname: '关注主播', live_status: 1, title: '正在直播',
  room_cover: 'https://i0.hdslb.com/bfs/live/cover.jpg', face: 'https://i1.hdslb.com/bfs/face/face.jpg', record_live_time: 1_800_000_000 });
const page = (list: unknown[] = [row()]) => ({ code: 0, data: { count: 25, live_count: 3, totalPage: 3, list } });
function harness() {
  let stored: Record<string, unknown> = {}, now = 1_800_000_001_000, uid: string | undefined = '42', cookieUid = '42', cookieReads = 0, navCalls = 0;
  let status = 200, retry = '', payload: unknown = undefined, gate: (() => Promise<void>) | undefined;
  let respond: ((url: URL, init?: RequestInit) => Promise<Response> | Response) | undefined;
  let service: LocalFollowingService;
  const network: Array<{ url: URL; init?: RequestInit; cookie: string }> = [];
  const rules = new Map<number, chrome.declarativeNetRequest.Rule>();
  const transport = new LocalCookieTransport({ extensionId: 'testextension', now: () => now,
    getCookies: async () => { cookieReads++; return [cookie('SESSDATA', 'fixture-session'), cookie('DedeUserID', cookieUid)]; },
    updateRules: async value => { for (const id of value.removeRuleIds ?? []) rules.delete(id);
      for (const rule of value.addRules ?? []) rules.set(rule.id, rule); } });
  const broker = new LocalLoginBroker({ now: () => now, fetch: (async () => {
    navCalls++; return new Response(JSON.stringify(uid ? { code: 0, data: { mid: uid, isLogin: true, uname: 'fixture' } }
      : { code: -101, data: { isLogin: false } }));
  }) as typeof fetch });
  const sessions = new LoginSessions({ broker, storage: { get: async () => structuredClone(stored),
    set: async value => { stored = { ...stored, ...structuredClone(value) }; } }, allowedOrigin: value => value === origin, now: () => now,
    onChange: (_origin, _revision, reason) => { if (['revoked', 'permission-removed', 'logged-out', 'account-changed'].includes(reason)) service?.invalidate(); } });
  service = new LocalFollowingService({ transport, sessions, now: () => now, fetch: (async (input, init) => {
    const url = new URL(String(input));
    const active = [...rules.values()].filter(rule => rule.condition.regexFilter && new RegExp(rule.condition.regexFilter).test(url.href));
    assert.equal(active.length, 1);
    network.push({ url, init, cookie: active[0].action.requestHeaders?.find(header => header.header === 'Cookie')?.value ?? '' });
    await gate?.();
    if (respond) return respond(url, init);
    const fallback = url.pathname === '/x/relation/followings' ? { code: 0, data: { total: 1, list: [{ mid: 101, uname: '关注主播' }] } }
      : { code: 0, data: { '101': { uid: 101, room_id: 1001, live_status: 1, title: '正在直播', live_time: 1_800_000_000 } } };
    return new Response(JSON.stringify(payload ?? fallback), { status, headers: retry ? { 'retry-after': retry } : {} });
  }) as typeof fetch });
  return { service, sessions, broker, transport, network, rules,
    connect: async () => { await sessions.ready; return sessions.authorize(origin, { revision: sessions.read(origin).revision }); },
    get cookieReads() { return cookieReads; }, get navCalls() { return navCalls; }, get stored() { return stored; },
    set payload(value: unknown) { payload = value; }, set now(value: number) { now = value; }, set uid(value: string | undefined) { uid = value; },
    set cookieUid(value: string) { cookieUid = value; }, set status(value: number) { status = value; }, set retry(value: string) { retry = value; },
    set gate(value: (() => Promise<void>) | undefined) { gate = value; },
    set respond(value: ((url: URL, init?: RequestInit) => Promise<Response> | Response) | undefined) { respond = value; } };
}

test('following only reads its fixed own-account DD directory and one anonymous batch without persistence or prefetch', async () => {
  const item = harness(), session = await item.connect(), stored = structuredClone(item.stored);
  assert.equal(item.network.length, 0, 'authorization itself never reads following');
  const result = await item.service.page(origin, { page: 1, authEpoch: session.account!.authEpoch }, signal());
  assert.equal(result.accountUid, '42'); assert.equal(result.page, 1); assert.equal(result.pageSize, 100);
  assert.equal(result.total, null); assert.equal(result.liveCount, null); assert.equal(result.hasMore, false); assert.equal(result.accountTotal, 1);
  assert.equal(result.rooms[0].lastLiveTime, null); assert.equal(result.rooms[0].liveStartTime, 1_800_000_000_000);
  assert.equal(result.directorySource, 'relations'); assert.equal(result.scannedAccounts, 1);
  assert.equal(item.network.length, 2);
  const request = item.network[0];
  assert.equal(request.url.href, `${FOLLOWING_RELATIONS_API}?vmid=42&pn=1&ps=50&order=desc`);
  assert.equal(request.init?.method, 'GET'); assert.equal(request.init?.credentials, 'omit'); assert.equal(request.init?.redirect, 'error');
  assert.match(request.cookie, /DedeUserID=42/); assert.equal(item.rules.size, 0);
  assert.equal(item.network[1].url.href, FOLLOWING_STATUS_API); assert.equal(item.network[1].cookie, '');
  assert.deepEqual(item.stored, stored);
  assert.equal(item.navCalls, 1, 'holding an existing verified identity does not periodically check NAV');
  assert.equal(JSON.stringify(result).includes('fixture-session'), false);
});

test('following projects ordered valid room fields and refuses unsafe images without restoring them from another account', () => {
  const input = page([row(1003, 43), { ...row(1001, 44), live_status: 0, record_live_time: 0, room_cover: 'https://evil.test/a', face: 'http://i0.hdslb.com/face.jpg' },
    { ...row(1002, 45), live_status: 2, room_cover: 'https://i0.hdslb.com/a#fragment', face: 'https://u:p@i0.hdslb.com/a' }, row(1003, 99), row(0, 46), { ...row(1004), uid: 1.5 }]);
  const result = projectFollowingPage(input, { page: 3, accountUid: '42', authEpoch: 'epoch', resolvedAt: 5 });
  assert.deepEqual(result.rooms.map(value => value.roomId), ['1003', '1001', '1002']);
  assert.deepEqual(result.rooms.map(value => value.status), ['live', 'offline', 'unknown']);
  assert.equal(result.rooms[1].cover, ''); assert.equal(result.rooms[1].lastLiveTime, null);
  assert.equal(result.rooms[2].cover, ''); assert.equal(result.hasMore, false);
  assert.equal(projectFollowingPage(page([]), { page: 1, accountUid: '42', authEpoch: 'epoch', resolvedAt: 5 }).hasMore, false);
  assert.throws(() => projectFollowingPage({ code: 0, data: { count: 0 } }, { page: 1, accountUid: '42', authEpoch: 'epoch', resolvedAt: 5 }), /格式/);
  assert.throws(() => projectFollowingPage(page(Array.from({ length: FOLLOWING_PAGE_SIZE + 1 }, () => row())), { page: 1, accountUid: '42', authEpoch: 'epoch', resolvedAt: 5 }), /格式/);
});

test('following requires the unified grant, exact epoch and matching Cookie UID before any relation read', async () => {
  const item = harness();
  await assert.rejects(item.service.page(origin, { page: 1, authEpoch: 'epoch' }, signal()), (error: unknown) => error instanceof BrokerError && error.code === 'UNAUTHORIZED');
  const session = await item.connect();
  await assert.rejects(item.service.page(origin, { page: 1, authEpoch: 'stale' }, signal()), (error: unknown) => error instanceof BrokerError && error.code === 'ACCOUNT_CHANGED');
  item.cookieUid = '43';
  await assert.rejects(item.service.page(origin, { page: 1, authEpoch: session.account!.authEpoch }, signal()), (error: unknown) => error instanceof BrokerError && error.code === 'ACCOUNT_CHANGED');
  assert.equal(item.network.length, 0); assert.equal(item.rules.size, 0);
});

test('following degrades inconsistent upstream statistics while preserving room cards and pagination', () => {
  const result = projectFollowingPage({ code: 0, data: { count: 1, live_count: 2, totalPage: 3, list: [row(1001)] } },
    { page: 1, accountUid: '42', authEpoch: 'epoch', resolvedAt: 5 });
  assert.equal(result.total, null); assert.equal(result.liveCount, null);
  assert.equal(result.rooms[0].roomId, '1001'); assert.equal(result.hasMore, true);
  const valid = projectFollowingPage({ code: 0, data: { count: 1, live_count: 0, totalPage: 1, list: [{ ...row(1001), live_status: 0 }] } },
    { page: 1, accountUid: '42', authEpoch: 'epoch', resolvedAt: 5 });
  assert.equal(valid.total, 1); assert.equal(valid.liveCount, 0); assert.equal(valid.hasMore, false);
});

test('following cannot report fewer live rooms than its own valid cards, and missing statistics remain unknown', () => {
  const context = { page: 1, accountUid: '42', authEpoch: 'epoch', resolvedAt: 5 };
  const result = projectFollowingPage({ code: 0, data: { count: 232, live_count: 0, totalPage: 26, list: [row()] } }, context);
  assert.equal(result.total, 232); assert.equal(result.liveCount, null); assert.equal(result.rooms[0].status, 'live');
  const unknown = projectFollowingPage({ code: 0, data: { list: [row()] } }, context);
  assert.equal(unknown.total, null); assert.equal(unknown.liveCount, null);
  const offline = projectFollowingPage({ code: 0, data: { count: 1, live_count: 0, totalPage: 1, list: [{ ...row(), live_status: 0 }] } }, context);
  assert.equal(offline.total, 1); assert.equal(offline.liveCount, 0); assert.equal(offline.hasMore, false);
});

test('following discards totals below valid cards without treating a contradictory full page as the end', () => {
  const context = { page: 1, accountUid: '42', authEpoch: 'epoch', resolvedAt: 5 };
  const list = Array.from({ length: FOLLOWING_PAGE_SIZE }, (_, index) => ({ ...row(1001 + index), live_status: 0 }));
  const result = projectFollowingPage({ code: 0, data: { count: 0, live_count: 0, totalPage: 0, list } }, context);
  assert.equal(result.total, null); assert.equal(result.liveCount, 0); assert.equal(result.rooms.length, FOLLOWING_PAGE_SIZE); assert.equal(result.hasMore, true);
  const short = projectFollowingPage({ code: 0, data: { count: 0, live_count: 0, totalPage: 0, list: list.slice(0, 2) } }, context);
  assert.equal(short.total, null); assert.equal(short.hasMore, false);
  const empty = projectFollowingPage({ code: 0, data: { count: 0, live_count: 0, totalPage: 0, list: [] } }, context);
  assert.equal(empty.total, 0); assert.equal(empty.liveCount, 0); assert.equal(empty.hasMore, false);
});

test('following falls back only for impossible pagination metadata and preserves coherent explicit boundaries', () => {
  const context = { page: 1, pageSize: 9 as const, accountUid: '42', authEpoch: 'epoch', resolvedAt: 5 };
  const list = Array.from({ length: 9 }, (_, index) => row(1001 + index));
  for (const stats of [{ count: 232, totalPage: 0 }, { count: 232, totalPage: 1 }, { count: 2, totalPage: 1 }]) {
    assert.equal(projectFollowingPage({ data: { ...stats, list } }, context).hasMore, true);
    assert.equal(projectFollowingPage({ data: { ...stats, list: list.slice(0, 3) } }, context).hasMore, false);
  }
  assert.equal(projectFollowingPage({ data: { count: 10, totalPage: 2, list } }, { ...context, page: 2 }).hasMore, true);
  assert.equal(projectFollowingPage({ data: { count: 9, totalPage: 1, list } }, context).hasMore, false);
  assert.equal(projectFollowingPage({ data: { count: 25, totalPage: 3, list } }, { ...context, page: 2 }).hasMore, true);
  assert.equal(projectFollowingPage({ data: { count: 25, totalPage: 3, list: list.slice(0, 7) } }, { ...context, page: 3 }).hasMore, false);
  assert.equal(projectFollowingPage({ data: { totalPage: 3, list: list.slice(0, 3) } }, context).hasMore, true);
});

test('following never returns a late account-bound page after revocation and does not retry it', async () => {
  const item = harness(), session = await item.connect();
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  item.gate = async () => { entered(); await gate; };
  const pending = item.service.page(origin, { page: 1, authEpoch: session.account!.authEpoch }, signal());
  const rejected = assert.rejects(pending);
  await waiting;
  await item.sessions.grant(origin, false);
  release(); await rejected;
  assert.equal(item.network.length, 1); assert.equal(item.rules.size, 0);
});

test('following cancellation aborts the read and never starts another page or leaves an identity rule', async () => {
  const item = harness(), session = await item.connect();
  const controller = new AbortController(); controller.abort();
  await assert.rejects(item.service.page(origin, { page: 1, authEpoch: session.account!.authEpoch }, controller.signal), { name: 'AbortError' });
  for (const value of [0, -1, 1001, 1.5, '2', null]) {
    await assert.rejects(item.service.page(origin, { page: value, authEpoch: session.account!.authEpoch }, signal()), (error: unknown) => error instanceof BrokerError && error.code === 'INVALID_REQUEST');
  }
  assert.equal(item.network.length, 0); assert.equal(item.cookieReads, 0);
});

test('following 412/429 honor Retry-After without retrying or discarding a valid account', async () => {
  const item = harness(), session = await item.connect(); item.status = 429; item.retry = '120';
  const input = { page: 1, authEpoch: session.account!.authEpoch };
  await assert.rejects(item.service.page(origin, input, signal()), (error: unknown) => error instanceof BrokerError && error.code === 'RATE_LIMITED' && error.retryAfter === 120);
  item.status = 200;
  await assert.rejects(item.service.page(origin, input, signal()), (error: unknown) => error instanceof BrokerError && error.code === 'RATE_LIMITED');
  assert.equal(item.network.length, 1); assert.equal(item.sessions.read(origin).granted, true);
  item.now = 1_800_000_121_001;
  await item.service.page(origin, input, signal()); assert.equal(item.network.length, 3);
});

test('following -101 verifies actual account once on demand and does not turn endpoint rejection into automatic logout', async () => {
  const item = harness(), session = await item.connect(); item.payload = { code: -101, message: 'not login' };
  await assert.rejects(item.service.page(origin, { page: 1, authEpoch: session.account!.authEpoch }, signal()), AccountVerificationRequired);
  assert.equal(item.navCalls, 2); assert.equal(item.network.length, 1); assert.equal(item.sessions.read(origin).granted, true);
});

test('following transport rejects the retired official route, anonymous relations and arbitrary query parameters', async () => {
  const item = harness();
  const valid = `${FOLLOWING_RELATIONS_API}?vmid=42&pn=1&ps=50&order=desc`;
  for (const value of [valid.replace('ps=50', 'ps=99'), valid + '&uid=42', valid + '&pn=2', valid.replace('pn=1', 'pn=2001'),
    valid.replace('api.bilibili.com', 'evil.test'), valid.replace('order=desc', 'order=asc'),
    ...[9, 50, 100].map(size => `${OLD_FOLLOWING_API}?page=1&page_size=${size}&ignoreRecord=1&hit_ab=false`)]) {
    await assert.rejects(item.transport.run(new URL(value), 'authenticated', signal(), async () => undefined), /不支持/);
  }
  await assert.rejects(item.transport.run(new URL(valid), 'anonymous', signal(), async () => undefined), /不支持/);
  assert.equal(item.cookieReads, 0);
});

test('legacy pure following projection retains bounded 9, 50 and 100-row compatibility without any business call', () => {
  for (const size of [9, 50, 100] as const) {
    const last = projectFollowingPage({ data: { count: size, totalPage: 1, list: Array.from({ length: size }, (_, index) => row(1001 + index)) } },
      { page: 1, pageSize: size, accountUid: '42', authEpoch: 'epoch', resolvedAt: 5 });
    assert.equal(last.hasMore, false);
    assert.throws(() => projectFollowingPage({ data: { list: Array.from({ length: size + 1 }, () => row()) } },
      { page: 1, pageSize: size, accountUid: '42', authEpoch: 'epoch', resolvedAt: 5 }), /格式/);
  }
});

test('following status uses the fixed anonymous read-only POST under the complete account grant without reading cookies', async () => {
  const item = harness(), session = await item.connect();
  item.payload = { code: 0, data: { '101': { uid: 101, room_id: 2001, live_status: 1, live_time: 1_800_000_000, uname: '主播', title: '标题',
    cover_from_user: 'https://i0.hdslb.com/bfs/live/cover.jpg' }, '102': { uid: 102, room_id: 2002, live_status: 2, live_time: 0 } } };
  const result = await item.service.status(origin, { uids: ['102', '101', '103'], authEpoch: session.account!.authEpoch }, signal());
  assert.deepEqual(result.uids, ['102', '101', '103']); assert.deepEqual(result.rooms.map(room => room.uid), ['102', '101']);
  assert.equal(result.rooms[0].status, 'offline'); assert.equal(result.rooms[1].liveStartTime, 1_800_000_000_000);
  assert.equal(result.accountUid, '42'); assert.equal(item.cookieReads, 0); assert.equal(item.navCalls, 1);
  assert.equal(item.network.length, 1); assert.equal(item.network[0].url.href, FOLLOWING_STATUS_API);
  assert.equal(item.network[0].init?.method, 'POST'); assert.equal(item.network[0].init?.credentials, 'omit'); assert.equal(item.network[0].cookie, '');
  assert.deepEqual(JSON.parse(String(item.network[0].init?.body)), { uids: ['102', '101', '103'] });
  assert.equal(item.rules.size, 0);
});

test('following status validates identifiers, exact payload, bounded batch and epoch before any request', async () => {
  const item = harness();
  await assert.rejects(item.service.status(origin, { uids: ['101'], authEpoch: 'epoch' }, signal()), (error: unknown) => error instanceof BrokerError && error.code === 'UNAUTHORIZED');
  const session = await item.connect();
  for (const uids of [[], ['101', '101'], [101], ['0'], ['01'], ['a'], Array.from({ length: 101 }, (_, index) => String(index + 1))])
    await assert.rejects(item.service.status(origin, { uids, authEpoch: session.account!.authEpoch }, signal()), (error: unknown) => error instanceof BrokerError && error.code === 'INVALID_REQUEST');
  await assert.rejects(item.service.status(origin, { uids: ['101'], authEpoch: 'stale' }, signal()), (error: unknown) => error instanceof BrokerError && error.code === 'ACCOUNT_CHANGED');
  await assert.rejects(item.service.status(origin, { uids: ['101'], authEpoch: session.account!.authEpoch, url: 'https://evil.test' } as never, signal()),
    (error: unknown) => error instanceof BrokerError && error.code === 'INVALID_REQUEST');
  assert.equal(item.network.length, 0); assert.equal(item.cookieReads, 0);
});

test('following status rejects unrequested or mismatched owners and shared room aliases while retaining unknown and explicit offline', () => {
  const result = projectFollowingStatus({ data: {
    '101': { uid: 102, room_id: 2001, live_status: 1 },
    '102': { uid: 102, room_id: 2002, live_status: 1, live_time: 1_800_000_000 },
    '103': { uid: 103, room_id: 2002, live_status: 0 },
    '104': { uid: 104, room_id: 2004, live_status: 9, live_time: 1_800_000_000, cover_from_user: 'https://evil.test/a', title: 'x\u0000y' },
    '105': { uid: 105, room_id: 2005, live_status: 0, live_time: 1_800_000_000 },
    '106': { room_id: 2006, live_status: 1 },
    '999': { uid: 999, room_id: 2999, live_status: 1 }
  } }, { accountUid: '42', authEpoch: 'epoch', uids: ['101', '102', '103', '104', '105', '106'], resolvedAt: 5 });
  assert.deepEqual(result.rooms.map(room => room.uid), ['104', '105']);
  assert.equal(result.rooms[0].status, 'unknown'); assert.equal(result.rooms[0].liveStartTime, null); assert.equal(result.rooms[0].cover, undefined);
  assert.equal(result.rooms[0].title, 'xy'); assert.equal(result.rooms[1].status, 'offline'); assert.equal(result.rooms[1].liveStartTime, null);
});

test('following status remains a read during CSRF rotation, but cancels when the unified account grant is revoked', async () => {
  const item = harness(), session = await item.connect(); item.payload = { code: 0, data: {} };
  item.gate = async () => item.transport.invalidateWrites();
  await item.service.status(origin, { uids: ['101'], authEpoch: session.account!.authEpoch }, signal());
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  item.gate = async () => { entered(); await gate; };
  const pending = item.service.status(origin, { uids: ['101'], authEpoch: session.account!.authEpoch }, signal());
  const rejected = assert.rejects(pending); await waiting; await item.sessions.grant(origin, false); release(); await rejected;
  assert.equal(item.network.length, 2); assert.equal(item.rules.size, 0);
});

test('following status confirms no room only for an explicitly matching requested owner and zero room id', () => {
  const result = projectFollowingStatus({ data: {
    '101': { uid: 101, room_id: 0 }, '102': { uid: '102', room_id: '0' },
    '103': { room_id: 0 }, '104': { uid: 999, room_id: 0 },
    '105': { uid: 105 }, '106': { uid: 106, room_id: null },
    '107': { uid: 107, room_id: 2007, live_status: 0 },
    '999': { uid: 999, room_id: 0 }
  } }, { accountUid: '42', authEpoch: 'epoch', uids: ['101', '102', '103', '104', '105', '106', '107', '108'], resolvedAt: 5 });
  assert.deepEqual(result.noRoomUids, ['101', '102']);
  assert.deepEqual(result.rooms.map(room => room.uid), ['107']);
  assert.equal(result.rooms[0].status, 'offline');
});

test('anonymous following status rejection never checks NAV or turns a valid account into logout', async () => {
  const item = harness(), session = await item.connect(); item.payload = { code: -101, message: 'not login' };
  await assert.rejects(item.service.status(origin, { uids: ['101'], authEpoch: session.account!.authEpoch }, signal()),
    (error: unknown) => error instanceof BrokerError && error.code === 'UNAVAILABLE');
  assert.equal(item.navCalls, 1); assert.equal(item.network.length, 1); assert.equal(item.cookieReads, 0);
  assert.equal(item.sessions.read(origin).granted, true);
});

test('following status transport requires anonymous POST, exact endpoint and query, and shares a same-URL lease', async () => {
  const item = harness(), url = new URL(FOLLOWING_STATUS_API);
  await assert.rejects(item.transport.run(url, 'authenticated', signal(), async () => undefined, { method: 'POST' }), /不支持/);
  await assert.rejects(item.transport.run(url, 'anonymous', signal(), async () => undefined), /不支持/);
  await assert.rejects(item.transport.run(new URL(FOLLOWING_STATUS_API + '?uids=101'), 'anonymous', signal(), async () => undefined, { method: 'POST' }), /不支持/);
  const stages: string[] = [];
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const first = item.transport.run(url, 'anonymous', signal(), async cookies => { assert.deepEqual(cookies, {}); stages.push('first'); entered(); await gate; }, { method: 'POST' });
  await waiting;
  const second = item.transport.run(url, 'anonymous', signal(), async () => { stages.push('second'); }, { method: 'POST' });
  await Promise.resolve(); assert.deepEqual(stages, ['first']); release(); await Promise.all([first, second]);
  assert.deepEqual(stages, ['first', 'second']); assert.equal(item.cookieReads, 0); assert.equal(item.rules.size, 0);
});

const json = (data: unknown) => new Response(JSON.stringify({ code: 0, data }));
const metadata = (overrides: Record<string, unknown> = {}) => ({ room_id: 1001, uid: 101, uname: '真实主播', title: '真实标题', live_status: 1,
  live_time: 1_800_000_000, cover: 'https://i0.hdslb.com/bfs/live/room.jpg', user_cover: 'https://i0.hdslb.com/bfs/live/user.jpg',
  keyframe: 'https://i0.hdslb.com/bfs/live/frame.jpg', face: 'https://i0.hdslb.com/bfs/face/avatar.jpg', online: 9999999, ...overrides });
function publicRoom(item: ReturnType<typeof harness>, values: { base?: Record<string, unknown>; count?: unknown } = {}) {
  item.respond = url => {
    if (url.pathname.endsWith('/room_init')) return json({ room_id: 1001, uid: 101, short_id: 51 });
    if (url.pathname.endsWith('/getRoomBaseInfo')) return json({ by_room_ids: { '1001': values.base ?? metadata() } });
    if (url.pathname.endsWith('/getOnlineGoldRank')) return json({ onlineNum: values.count ?? 123 });
    throw new Error('unexpected endpoint');
  };
}

test('following batch never treats popularity as viewers and room art never falls back to face', () => {
  const result = projectFollowingStatus({ data: { '101': { uid: 101, room_id: 1001, live_status: 1, online: 900000, online_num: 900001, onlineNum: 900002,
    cover_from_user: 'https://i0.hdslb.com/cover.jpg', keyframe: 'https://i0.hdslb.com/frame.jpg', face: 'https://i0.hdslb.com/face.jpg' },
  '102': { uid: 102, room_id: 1002, live_status: 1, face: 'https://i0.hdslb.com/face.jpg' } } },
  { accountUid: '42', authEpoch: 'epoch', uids: ['101', '102'], resolvedAt: 5 });
  assert.equal(result.rooms[0].online, null); assert.equal(result.rooms[0].cover, 'https://i0.hdslb.com/cover.jpg');
  assert.equal(result.rooms[1].cover, undefined);
});

test('following room info verifies canonical room and owner, fetches real onlineNum anonymously, and reuses account-bound metadata', async () => {
  const item = harness(), session = await item.connect(); publicRoom(item);
  const input = { roomId: '1001', uid: '101', authEpoch: session.account!.authEpoch };
  const first = await item.service.roomInfo(origin, input, signal());
  assert.equal(first.accountUid, '42'); assert.equal(first.uid, '101'); assert.equal(first.roomId, '1001');
  assert.equal(first.anchorName, '真实主播'); assert.equal(first.title, '真实标题'); assert.equal(first.status, 'live');
  assert.equal(first.cover, 'https://i0.hdslb.com/bfs/live/room.jpg'); assert.equal(first.online, 123);
  assert.equal(first.liveStartTime, 1_800_000_000_000); assert.equal(first.onlineStale, false); assert.equal(first.metadataStale, false);
  assert.equal(first.metadataFetchedAt, 1_800_000_001_000); assert.equal(first.onlineLastSuccessAt, 1_800_000_001_000);
  assert.deepEqual(item.network.map(value => value.url.href), [
    FOLLOWING_ROOM_INIT_API + '?id=1001', FOLLOWING_ROOM_BASE_API + '?req_biz=web_room_componet&room_ids=1001',
    FOLLOWING_ONLINE_API + '?ruid=101&roomId=1001&page=1&pageSize=1'
  ]);
  item.now = 1_800_000_031_000;
  const second = await item.service.roomInfo(origin, input, signal());
  assert.equal(second.metadataFetchedAt, first.metadataFetchedAt); assert.equal(second.resolvedAt, 1_800_000_031_000);
  assert.equal(item.network.length, 4); assert.equal(item.network[3].url.pathname, new URL(FOLLOWING_ONLINE_API).pathname);
  assert.equal(item.cookieReads, 0); assert.equal(item.navCalls, 1); assert.equal(item.rules.size, 0);
  for (const request of item.network) { assert.equal(request.cookie, ''); assert.equal(request.init?.method, 'GET'); assert.equal(request.init?.credentials, 'omit'); }
});

test('following room info validates exact payload and complete authorization before requests, and refuses an owner or canonical mismatch', async () => {
  const item = harness(), input = { roomId: '1001', uid: '101', authEpoch: 'epoch' };
  await assert.rejects(item.service.roomInfo(origin, input, signal()), (error: unknown) => error instanceof BrokerError && error.code === 'UNAUTHORIZED');
  const session = await item.connect(); input.authEpoch = session.account!.authEpoch;
  for (const invalid of [{ ...input, roomId: 1001 }, { ...input, uid: '01' }, { ...input, authEpoch: '' }, { ...input, url: 'https://evil.test' }])
    await assert.rejects(item.service.roomInfo(origin, invalid as never, signal()), (error: unknown) => error instanceof BrokerError && error.code === 'INVALID_REQUEST');
  await assert.rejects(item.service.roomInfo(origin, { ...input, authEpoch: 'stale' }, signal()), (error: unknown) => error instanceof BrokerError && error.code === 'ACCOUNT_CHANGED');
  assert.equal(item.network.length, 0);
  for (const data of [{ room_id: 1001, uid: 102 }, { room_id: 1002, uid: 101 }, { room_id: 1001, uid: 101, short_id: 52 }]) {
    item.respond = () => json(data);
    await assert.rejects(item.service.roomInfo(origin, data.short_id ? { ...input, roomId: '51' } : input, signal()),
      (error: unknown) => error instanceof BrokerError && error.code === 'STATE_CONFLICT');
  }
  assert.equal(item.network.length, 3); assert.equal(item.cookieReads, 0);
});

test('following room metadata uses safe room artwork only, accepts short ids, and falls back once to get_info after unavailable base', async () => {
  const item = harness(), session = await item.connect();
  item.respond = url => {
    if (url.pathname.endsWith('/room_init')) return json({ room_id: 1001, uid: '101', short_id: 51 });
    if (url.pathname.endsWith('/getRoomBaseInfo')) return new Response('', { status: 503 });
    if (url.pathname.endsWith('/get_info')) return json(metadata({ cover: 'https://evil.test/a', user_cover: 'https://i0.hdslb.com/user.jpg', live_time: '2027-01-15 08:00:00' }));
    return json({ onlineNum: 50 });
  };
  const result = await item.service.roomInfo(origin, { roomId: '51', uid: '101', authEpoch: session.account!.authEpoch }, signal());
  assert.equal(result.roomId, '1001'); assert.equal(result.cover, 'https://i0.hdslb.com/user.jpg');
  assert.equal(result.liveStartTime, Date.parse('2027-01-15T08:00:00+08:00'));
  assert.equal(item.network[2].url.href, FOLLOWING_ROOM_INFO_API + '?room_id=1001'); assert.equal(item.network.length, 4);
});

test('following room count failures retain valid metadata, do not substitute popularity, and respect cooldown without fallback or NAV', async () => {
  const item = harness(), session = await item.connect(); publicRoom(item, { count: '123' });
  const input = { roomId: '1001', uid: '101', authEpoch: session.account!.authEpoch };
  const unknown = await item.service.roomInfo(origin, input, signal());
  assert.equal(unknown.online, null); assert.equal(unknown.onlineStale, true); assert.match(unknown.onlineError!, /人数/);
  item.respond = () => new Response('', { status: 429, headers: { 'retry-after': '120' } });
  const limited = await item.service.roomInfo(origin, input, signal());
  assert.equal(limited.anchorName, '真实主播'); assert.equal(limited.online, null); assert.equal(limited.retryAfterMs, 120_000);
  const network = item.network.length;
  const cooldown = await item.service.roomInfo(origin, input, signal());
  assert.equal(cooldown.retryAfterMs, 120_000); assert.equal(item.network.length, network); assert.equal(item.navCalls, 1);
});

test('following room metadata uses bounded stale data for outages and never extends its success age', async () => {
  const item = harness(), session = await item.connect(); publicRoom(item);
  const input = { roomId: '1001', uid: '101', authEpoch: session.account!.authEpoch };
  const first = await item.service.roomInfo(origin, input, signal());
  item.now = first.metadataFetchedAt + 300_001;
  item.respond = () => new Response('', { status: 503 });
  const stale = await item.service.roomInfo(origin, input, signal());
  assert.equal(stale.metadataStale, true); assert.equal(stale.metadataFetchedAt, first.metadataFetchedAt); assert.ok(stale.metadataError);
  item.now = first.metadataFetchedAt + 600_001;
  await assert.rejects(item.service.roomInfo(origin, input, signal()), (error: unknown) => error instanceof BrokerError && error.code === 'UNAVAILABLE');
});

test('following room offline metadata expires after one minute and never fetches or fabricates viewer counts', async () => {
  const item = harness(), session = await item.connect(); publicRoom(item, { base: metadata({ live_status: 0 }) });
  const input = { roomId: '1001', uid: '101', authEpoch: session.account!.authEpoch };
  const first = await item.service.roomInfo(origin, input, signal());
  assert.equal(first.online, null); assert.equal(first.onlineStale, false); assert.equal(item.network.length, 2);
  item.now = first.metadataFetchedAt + 59_000;
  await item.service.roomInfo(origin, input, signal()); assert.equal(item.network.length, 2);
  item.now = first.metadataFetchedAt + 60_001; publicRoom(item);
  const live = await item.service.roomInfo(origin, input, signal());
  assert.equal(live.status, 'live'); assert.equal(live.online, 123); assert.equal(item.network.length, 5);
});

test('following room info merges same-key in-flight work, permits one consumer cancellation, and rejects every late result after revoke', async () => {
  const item = harness(), session = await item.connect(); publicRoom(item);
  const input = { roomId: '1001', uid: '101', authEpoch: session.account!.authEpoch };
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  item.gate = async () => { entered(); await gate; };
  const controller = new AbortController();
  const first = item.service.roomInfo(origin, input, controller.signal), rejected = assert.rejects(first, { name: 'AbortError' });
  await waiting;
  const second = item.service.roomInfo(origin, input, signal());
  await new Promise(resolve => setTimeout(resolve, 0));
  controller.abort(); await rejected; release(); await second;
  assert.equal(item.network.length, 3);
  let releaseCount!: () => void, enterCount!: () => void;
  const enteredCount = new Promise<void>(resolve => { enterCount = resolve; }), countGate = new Promise<void>(resolve => { releaseCount = resolve; });
  item.gate = async () => { enterCount(); await countGate; };
  const pending = item.service.roomInfo(origin, input, signal()), revoked = assert.rejects(pending);
  await enteredCount; await item.sessions.grant(origin, false); releaseCount(); await revoked;
  assert.equal(item.cookieReads, 0); assert.equal(item.rules.size, 0);
});

test('following room transport fixes public parameters, GET and anonymous mode before any cookie or network access', async () => {
  const item = harness();
  const valid = FOLLOWING_ROOM_BASE_API + '?req_biz=web_room_componet&room_ids=1001';
  const online = FOLLOWING_ONLINE_API + '?ruid=101&roomId=1001&page=1&pageSize=1';
  for (const url of [valid + '&room_ids=1002', valid.replace('web_room_componet', 'other'), online.replace('pageSize=1', 'pageSize=50'), online + '&cookie=x'])
    await assert.rejects(item.transport.run(new URL(url), 'anonymous', signal(), async () => undefined), /不支持/);
  for (const url of [valid, online]) {
    await assert.rejects(item.transport.run(new URL(url), 'authenticated', signal(), async () => undefined), /不支持/);
    await assert.rejects(item.transport.run(new URL(url), 'anonymous', signal(), async () => undefined, { method: 'POST' }), /不支持/);
  }
  assert.equal(item.cookieReads, 0); assert.equal(item.network.length, 0);
});

function ddDirectory(item: ReturnType<typeof harness>, total: number, project?: (uids: string[]) => unknown) {
  item.respond = (url, init) => {
    if (url.pathname === new URL(FOLLOWING_RELATIONS_API).pathname) {
      const offset = (Number(url.searchParams.get('pn')) - 1) * 50;
      return json({ total, list: Array.from({ length: Math.max(0, Math.min(50, total - offset)) }, (_, index) => ({ mid: 101 + offset + index, uname: `关注${offset + index}` })) });
    }
    if (url.pathname === new URL(FOLLOWING_STATUS_API).pathname) {
      const uids = (JSON.parse(String(init?.body)) as { uids: string[] }).uids;
      return json(project ? project(uids) : Object.fromEntries(uids.map(uid => [uid, { uid, room_id: String(Number(uid) + 1000), live_status: 1 }])));
    }
    throw new Error('retired or unexpected endpoint');
  };
}

test('DD directory combines exactly two fifty-account reads into one hundred-UID anonymous status batch', async () => {
  assert.equal(FOLLOWING_PAGE_SIZE, 100);
  const item = harness(), session = await item.connect(); ddDirectory(item, 125);
  const first = await item.service.page(origin, { page: 1, authEpoch: session.account!.authEpoch }, signal());
  assert.equal(first.directorySource, 'relations'); assert.equal(first.pageSize, 100); assert.equal(first.rooms.length, 100); assert.equal(first.hasMore, true);
  assert.equal(first.total, null); assert.equal(first.liveCount, null); assert.equal(first.accountTotal, 125);
  assert.equal(first.scannedAccounts, 100); assert.equal(first.scannedUids?.length, 100); assert.deepEqual(first.unresolvedUids, []);
  assert.deepEqual(item.network.map(value => value.url.href), [FOLLOWING_RELATIONS_API + '?vmid=42&pn=1&ps=50&order=desc',
    FOLLOWING_RELATIONS_API + '?vmid=42&pn=2&ps=50&order=desc', FOLLOWING_STATUS_API]);
  assert.match(item.network[0].cookie, /DedeUserID=42/); assert.match(item.network[1].cookie, /DedeUserID=42/); assert.equal(item.network[2].cookie, '');
  assert.equal((JSON.parse(String(item.network[2].init?.body)) as { uids: string[] }).uids.length, 100);
  assert.equal(item.navCalls, 1); assert.equal(item.cookieReads, 2); assert.equal(item.rules.size, 0);
  const next = await item.service.page(origin, { page: 2, authEpoch: session.account!.authEpoch }, signal());
  assert.equal(next.page, 2); assert.equal(next.rooms.length, 25); assert.equal(next.hasMore, false); assert.equal(next.scannedAccounts, 25);
  assert.equal(item.network[3].url.searchParams.get('pn'), '3'); assert.equal(item.network.length, 5);
});

test('DD directory does not fetch a needless second relation page or any status POST for an empty account', async () => {
  for (const total of [0, 1, 9, 10, 20, 49, 50, 51, 60, 100]) {
    const item = harness(), session = await item.connect(); ddDirectory(item, total);
    const result = await item.service.page(origin, { page: 1, authEpoch: session.account!.authEpoch }, signal());
    assert.equal(result.rooms.length, total); assert.equal(result.scannedAccounts, total); assert.equal(result.hasMore, false);
    assert.equal(item.network.filter(value => value.url.pathname === '/x/relation/followings').length, total > 50 ? 2 : 1);
    assert.equal(item.network.filter(value => value.url.href === FOLLOWING_STATUS_API).length, total ? 1 : 0);
    assert.equal(item.network.some(value => value.url.href.startsWith(OLD_FOLLOWING_API)), false);
  }
});

test('DD logical offsets survive a fresh worker and final logical pages remain within the fixed source-page whitelist', async () => {
  const item = harness(), session = await item.connect(); ddDirectory(item, 250);
  const result = await item.service.page(origin, { page: 2, authEpoch: session.account!.authEpoch }, signal());
  assert.deepEqual(item.network.slice(0, 2).map(value => value.url.searchParams.get('pn')), ['3', '4']);
  assert.equal(result.scannedUids?.[0], '201'); assert.equal(result.scannedUids?.at(-1), '300'); assert.equal(result.hasMore, true);
  const last = harness(), lastSession = await last.connect(); ddDirectory(last, 100_000);
  await last.service.page(origin, { page: 1000, authEpoch: lastSession.account!.authEpoch }, signal());
  assert.deepEqual(last.network.slice(0, 2).map(value => value.url.searchParams.get('pn')), ['1999', '2000']);
});

test('DD directory retains accounts missing from a valid status object and keeps advancing without inventing rooms or no-room results', async () => {
  const item = harness(), session = await item.connect(), authEpoch = session.account!.authEpoch;
  ddDirectory(item, 102, uids => uids[0] === '101' ? {} : { '201': { uid: 201, room_id: 0 }, '202': { uid: 202, room_id: 2002, live_status: 0 } });
  const empty = await item.service.page(origin, { page: 1, authEpoch }, signal());
  assert.equal(empty.rooms.length, 0); assert.equal(empty.hasMore, true); assert.equal(empty.unresolvedUids?.length, 100); assert.equal(empty.scannedAccounts, 100);
  const last = await item.service.page(origin, { page: 2, authEpoch }, signal());
  assert.deepEqual(last.rooms.map(value => value.roomId), ['2002']); assert.equal(last.hasMore, false); assert.deepEqual(last.unresolvedUids, []);
});

test('DD directory rejects malformed account or batch schemas without accepting a failed response as an empty success', async () => {
  for (const invalid of [{ code: 0, data: {} }, { code: 0, data: { total: 1, list: [{ mid: 1.5 }] } },
    { code: 0, data: { total: 51, list: Array.from({ length: 51 }, (_, index) => ({ mid: index + 1 })) } }]) {
    const item = harness(), session = await item.connect(); item.payload = invalid;
    await assert.rejects(item.service.page(origin, { page: 1, authEpoch: session.account!.authEpoch }, signal()));
    assert.equal(item.network.length, 1);
  }
  for (const data of [undefined, null, [], 'failed']) {
    const item = harness(), session = await item.connect(); ddDirectory(item, 1, () => data);
    await assert.rejects(item.service.page(origin, { page: 1, authEpoch: session.account!.authEpoch }, signal()), /状态格式/);
    assert.equal(item.network.length, 2);
  }
});

test('DD never switches APIs or retries to bypass network failure, rejected parameters, risk limits or account rejection', async () => {
  for (const kind of ['network', 'bad-request', 'risk', 'auth'] as const) {
    const item = harness(), session = await item.connect();
    item.respond = () => {
      if (kind === 'network') throw new TypeError('failed to fetch');
      if (kind === 'bad-request') return new Response('', { status: 400 });
      if (kind === 'risk') return new Response('', { status: 429, headers: { 'retry-after': '120' } });
      return new Response(JSON.stringify({ code: -101 }));
    };
    await assert.rejects(item.service.page(origin, { page: 1, authEpoch: session.account!.authEpoch }, signal()));
    assert.equal(item.network.length, 1); assert.equal(item.network[0].url.pathname, '/x/relation/followings');
    assert.equal(item.navCalls, kind === 'auth' ? 2 : 1);
  }
});

test('DD directory never returns an in-flight public status after complete authorization is revoked', async () => {
  const item = harness(), session = await item.connect();
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  item.respond = async url => {
    if (url.pathname === new URL(FOLLOWING_RELATIONS_API).pathname) return json({ total: 1, list: [{ mid: 101 }] });
    entered(); await gate; return json({ '101': { uid: 101, room_id: 1001, live_status: 1 } });
  };
  const pending = item.service.page(origin, { page: 1, authEpoch: session.account!.authEpoch }, signal()), rejected = assert.rejects(pending);
  await waiting; await item.sessions.grant(origin, false); release(); await rejected;
  assert.equal(item.rules.size, 0); assert.equal(item.network.length, 2);
});

test('relation transport permits only the fixed authenticated own-account query shape and bounded fifty-row pages', async () => {
  const item = harness(), valid = FOLLOWING_RELATIONS_API + '?vmid=42&pn=1&ps=50&order=desc';
  for (const value of [valid + '&vmid=43', valid.replace('ps=50', 'ps=100'), valid.replace('pn=1', 'pn=2001'), valid.replace('order=desc', 'order=asc'), valid + '&cookie=x'])
    await assert.rejects(item.transport.run(new URL(value), 'authenticated', signal(), async () => undefined), /不支持/);
  await assert.rejects(item.transport.run(new URL(valid), 'anonymous', signal(), async () => undefined), /不支持/);
  assert.equal(item.cookieReads, 0); assert.equal(item.network.length, 0);
});
