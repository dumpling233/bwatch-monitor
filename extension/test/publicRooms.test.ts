import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LocalPublicRooms } from '../lib/publicRooms';
import { LocalCookieTransport } from '../lib/cookieTransport';
import { BrokerError } from '../lib/broker';

const signal = () => new AbortController().signal;
const json = (data: unknown) => new Response(JSON.stringify({ code: 0, data }), { headers: { 'content-type': 'application/json' } });
function fixture() {
  let now = 1_000_000, cookieReads = 0, failOnline = false;
  const requests: URL[] = [], modes: string[] = [], rules: chrome.declarativeNetRequest.Rule[] = [];
  const transport = new LocalCookieTransport({ extensionId: 'monitor-extension', getCookies: async () => { cookieReads++; throw new Error('anonymous must never read cookies'); },
    updateRules: async value => { rules.push(...value.addRules ?? []); } });
  const service = new LocalPublicRooms({ now: () => now, transport: { run: async (url, mode, inner, operation, options) => {
    modes.push(mode); return transport.run(url, mode, inner, operation, options);
  } }, fetch: (async (input, init) => {
    const url = new URL(String(input)); requests.push(url);
    assert.equal(init?.credentials, 'omit'); assert.equal(init?.redirect, 'error');
    if (url.pathname.endsWith('/room_init')) return json({ room_id: 1001, uid: 42, short_id: 1 });
    if (url.pathname.endsWith('/getRoomBaseInfo')) return json({ by_room_ids: { '1001': { room_id: 1001, uid: 42, uname: '测试主播', title: '测试直播', cover: 'https://i0.hdslb.com/room.jpg', live_status: 1, live_time: '2026-11-18 12:00:00' } } });
    if (url.pathname.endsWith('/getOnlineGoldRank')) return failOnline ? new Response('', { status: 429, headers: { 'retry-after': '60' } }) : json({ onlineNum: 123 });
    if (url.pathname.endsWith('/getRoomPlayInfo')) return json({ live_status: 1, playurl_info: { playurl: {
      g_qn_desc: [{ qn: 250, desc: '超清' }], stream: [{ protocol_name: 'http_hls', format: [{ format_name: 'ts', codec: [{
        codec_name: 'avc', current_qn: 250, accept_qn: [250], base_url: '/live/index.m3u8?', url_info: [{ host: 'https://cdn.bilivideo.com', extra: 'token=fixture%2B' }]
      }] }] }] } } });
    throw new Error('unexpected fixed endpoint ' + url.pathname);
  }) as typeof fetch });
  return { service, requests, modes, rules, get cookieReads() { return cookieReads; }, set now(value: number) { now = value; }, set failOnline(value: boolean) { failOnline = value; } };
}
test('public room canonicalizes custom short ids and reads real metadata/counts without account or cookies', async () => {
  const f = fixture(), result = await f.service.room({ roomId: '1' }, signal());
  assert.equal(result.roomId, '1001'); assert.equal(result.uid, 42); assert.equal(result.anchorName, '测试主播');
  assert.equal(result.source, 'custom'); assert.equal(result.online, 123); assert.equal(result.onlineStale, false);
  assert.equal(result.fansCount, null); assert.equal(result.guardCount, null); assert.equal(f.cookieReads, 0);
  assert.deepEqual(f.modes, ['anonymous', 'anonymous', 'anonymous']);
  assert.equal(f.requests.some(url => url.pathname.endsWith('/nav')), false);
  assert.ok(f.rules.every(rule => rule.action.requestHeaders?.some(header => header.header === 'Cookie' && header.operation === 'remove')));
  assert.equal((await f.service.room({ roomId: '1' }, signal())).roomId, '1001'); assert.equal(f.requests.length, 3);
});
test('public ordinary playback is anonymous, preserves signed URLs and reuses parser/cache', async () => {
  const f = fixture(), result = await f.service.playback({ roomId: '1001', qn: 250 }, signal());
  assert.equal(result.status, 'live'); assert.equal(result.sources[0].actualQuality, 250);
  assert.match(result.sources[0].url, /token=fixture%2B/); assert.equal(f.cookieReads, 0); assert.deepEqual(f.modes, ['anonymous']);
  await f.service.playback({ roomId: '1001', qn: 250 }, signal()); assert.equal(f.requests.length, 1);
});
test('public RPCs reject malformed or extra arguments before network or Cookie access', async () => {
  const f = fixture();
  for (const roomId of ['0', '-1', '1?url=evil', 'https://live.bilibili.com/1'])
    await assert.rejects(f.service.room({ roomId }, signal()), (error: unknown) => error instanceof BrokerError && error.code === 'INVALID_REQUEST');
  await assert.rejects(f.service.room({ roomId: '1', url: 'https://evil.test' } as never, signal()));
  await assert.rejects(f.service.playback({ roomId: '1', qn: 0 }, signal()));
  await assert.rejects(f.service.playback({ roomId: '1', qn: 250, authEpoch: 'account' } as never, signal()));
  assert.equal(f.requests.length, 0); assert.equal(f.cookieReads, 0);
});
test('online failure retains valid room metadata and shared public cooldown does not retry or switch identity', async () => {
  const f = fixture(); f.failOnline = true;
  const room = await f.service.room({ roomId: '1' }, signal());
  assert.equal(room.anchorName, '测试主播'); assert.equal(room.online, null); assert.equal(room.onlineStale, true);
  assert.match(room.onlineError!, /限制/);
  await assert.rejects(f.service.playback({ roomId: '1001', qn: 250 }, signal()), (error: unknown) => error instanceof BrokerError && error.code === 'RATE_LIMITED');
  assert.equal(f.requests.length, 3); assert.equal(f.cookieReads, 0);
});
test('aborted public request never enters transport', async () => {
  const f = fixture(), controller = new AbortController(); controller.abort();
  await assert.rejects(f.service.room({ roomId: '1' }, controller.signal), { name: 'AbortError' });
  assert.equal(f.requests.length, 0);
});

test('public force refresh is limited per room across quality changes', async () => {
  const f = fixture();
  await f.service.playback({ roomId: '1001', qn: 250, force: true }, signal());
  await assert.rejects(f.service.playback({ roomId: '1001', qn: 10000, force: true }, signal()),
    (error: unknown) => error instanceof BrokerError && error.code === 'RATE_LIMITED');
  assert.equal(f.requests.length, 1);
  f.now = 1_005_001;
  await f.service.playback({ roomId: '1001', qn: 10000, force: true }, signal()); assert.equal(f.requests.length, 2);
});
test('ordinary playback joins a force refresh before considering its older cache', async () => {
  let at = 1_000_000, wait: Promise<void> | undefined, release!: () => void, requests = 0;
  const service = new LocalPublicRooms({ now: () => at, transport: { run: async (_url, _mode, inner, operation) => operation({}, inner) },
    fetch: (async () => { requests++; await wait; return json({ live_status: 0 }); }) as typeof fetch });
  const first = await service.playback({ roomId: '1001', qn: 250 }, signal());
  assert.equal(first.resolvedAt, at); at += 1000;
  wait = new Promise(resolve => { release = resolve; });
  const forced = service.playback({ roomId: '1001', qn: 250, force: true }, signal());
  const joined = service.playback({ roomId: '1001', qn: 250 }, signal());
  release(); const [a, b] = await Promise.all([forced, joined]);
  assert.equal(a.resolvedAt, at); assert.equal(b.resolvedAt, at); assert.equal(requests, 2);
});
test('public viewer counts accept safe integer strings and never substitute popularity', async () => {
  for (const [onlineNum, expected] of [['123', 123], ['0', 0], ['1.5', null], ['9007199254740992', null], [-1, null]] as const) {
    const service = new LocalPublicRooms({ transport: { run: async (_url, _mode, inner, operation) => operation({}, inner) },
      fetch: (async (input) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith('/room_init')) return json({ room_id: 1001, uid: 42 });
        if (path.endsWith('/getRoomBaseInfo')) return json({ by_room_ids: { '1001': { room_id: 1001, uid: 42, live_status: 1, online: 999999 } } });
        return json({ onlineNum, online: 999999 });
      }) as typeof fetch });
    const result = await service.room({ roomId: '1' }, signal());
    assert.equal(result.online, expected); assert.equal(result.onlineStale, expected === null);
  }
});
test('public room metadata risk rejection never switches to another endpoint', async () => {
  const paths: string[] = [];
  const service = new LocalPublicRooms({ transport: { run: async (_url, _mode, inner, operation) => operation({}, inner) },
    fetch: (async (input) => {
      const path = new URL(String(input)).pathname; paths.push(path);
      return path.endsWith('/room_init') ? json({ room_id: 1001, uid: 42 }) : new Response('', { status: 412 });
    }) as typeof fetch });
  await assert.rejects(service.room({ roomId: '1' }, signal()), (error: unknown) => error instanceof BrokerError && error.code === 'RATE_LIMITED');
  assert.equal(paths.length, 2); assert.equal(paths.some(path => path.endsWith('/get_info')), false);
});
