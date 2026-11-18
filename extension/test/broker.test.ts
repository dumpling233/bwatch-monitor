import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LocalLoginBroker, BrokerError } from '../lib/broker';
import { allowedPage } from '../lib/origins';
import { isTrustedPlaybackUrl, parsePlaybackInfo } from '../../shared/playbackParser';
import { accountEventNotifier } from '../lib/accountEvents';

const origin = 'https://bwatch.icu';
const nav = { code: 0, data: { isLogin: true, mid: 123, uname: '测试账号', wallet: { secret: 'not-exposed' } } };
function play(qn = 10000) {
  return { code: 0, data: { live_status: 1, playurl_info: { playurl: {
    g_qn_desc: [{ qn: 250, desc: '超清' }, { qn: 10000, desc: '原画' }],
    stream: [{ protocol_name: 'http_hls', format: [{ format_name: 'ts', codec: [{ codec_name: 'avc', current_qn: qn,
      accept_qn: [250, 10000], base_url: '/live/index.m3u8?', url_info: [{ host: 'https://cdn.bilivideo.com', extra: 'token=fixture%2B&deadline=2000000000' }] }] }] }]
  } } } };
}
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

test('only exact monitor paths and explicitly enabled local origins are permitted', () => {
  assert.equal(allowedPage('https://dumpling233.github.io/bwatch-monitor?from=admin'), true);
  assert.equal(allowedPage('https://dumpling233.github.io/bwatch-monitor/'), true);
  for (const value of ['https://bwatch.icu.evil.test/monitor', 'https://dumpling233.github.io/bwatch-monitor-bad', 'http://bwatch.icu/monitor', 'https://u:p@bwatch.icu/monitor']) assert.equal(allowedPage(value), false);
  assert.equal(allowedPage('http://127.0.0.1:5173/', false), false);
  assert.equal(allowedPage('http://127.0.0.1:5173/', true), true);
  assert.equal(allowedPage('http://127.0.0.1:9000/monitor', true), false);
});

test('no Bilibili requests occur before user authorization', async () => {
  let calls = 0;
  const broker = new LocalLoginBroker({ fetch: (async () => { calls++; return json(nav); }) as typeof fetch });
  assert.equal((await broker.account(origin)).state, 'unauthorized');
  await assert.rejects(broker.resolve(origin, { roomId: '1', qn: 250, authEpoch: broker.authEpoch }, new AbortController().signal), (value: unknown) => value instanceof BrokerError && value.code === 'UNAUTHORIZED');
  assert.equal(calls, 0);
});

test('account status is verified and projected; requests use the local cookie jar', async () => {
  const broker = new LocalLoginBroker({ fetch: (async (url, options) => {
    assert.equal(String(url), 'https://api.bilibili.com/x/web-interface/nav');
    assert.equal(options?.credentials, 'include'); assert.equal(options?.redirect, 'error');
    assert.deepEqual(options?.headers, { accept: 'application/json' });
    return json(nav);
  }) as typeof fetch });
  broker.authorize(origin, true);
  const account = await broker.account(origin);
  assert.deepEqual(account, { state: 'logged-in', uid: '123', name: '测试账号', authEpoch: broker.authEpoch });
  assert.equal(JSON.stringify(account).includes('wallet'), false);
});

test('default browser fetch keeps a valid global receiver', async context => {
  context.mock.method(globalThis, 'fetch', async function (this: unknown) {
    assert.ok(this === undefined || this === globalThis, 'browser fetch rejects a business object receiver');
    return json(nav);
  });
  const broker = new LocalLoginBroker();
  broker.authorize(origin, true);
  assert.equal((await broker.account(origin)).uid, '123');
});

test('logged-out and network failure remain distinguishable', async () => {
  const loggedOut = new LocalLoginBroker({ fetch: (async () => json({ code: -101, data: { isLogin: false } })) as typeof fetch });
  loggedOut.authorize(origin, true);
  assert.equal((await loggedOut.account(origin)).state, 'logged-out');
  const failed = new LocalLoginBroker({ fetch: (async () => { throw Error('sensitive URL'); }) as typeof fetch });
  failed.authorize(origin, true);
  await assert.rejects(failed.account(origin), (value: unknown) => value instanceof BrokerError && value.code === 'UNAVAILABLE' && !value.message.includes('sensitive'));
});

test('invalid RPC values never start a credential request; revoke preserves the external cookie jar', async () => {
  let calls = 0;
  const broker = new LocalLoginBroker({ fetch: (async () => { calls++; return json(nav); }) as typeof fetch });
  broker.authorize(origin, true);
  for (const input of [
    { roomId: ['1'], qn: 250, authEpoch: broker.authEpoch },
    { roomId: '1', qn: '250', authEpoch: broker.authEpoch },
    { roomId: '1', qn: 250, force: 'yes', authEpoch: broker.authEpoch },
    { roomId: 'https://evil.test', qn: 250, authEpoch: broker.authEpoch },
    { roomId: '1', qn: 250, authEpoch: 'x'.repeat(129) }
  ]) await assert.rejects(broker.resolve(origin, input as never, new AbortController().signal), (value: unknown) => value instanceof BrokerError && value.code === 'INVALID_REQUEST');
  assert.equal(calls, 0);
  broker.authorize(origin, false);
  assert.equal((await broker.account(origin)).state, 'unauthorized');
  assert.equal(calls, 0);
});

test('playback validates upstream URLs, preserves signature bytes and actual quality', async () => {
  let requests = 0;
  const broker = new LocalLoginBroker({ fetch: (async url => { requests++; return json(String(url).includes('/nav') ? nav : play(250)); }) as typeof fetch });
  broker.authorize(origin, true);
  const input = { roomId: '123', qn: 10000, authEpoch: broker.authEpoch };
  const result = await broker.resolve(origin, input, new AbortController().signal);
  assert.equal(result.requestedQuality, 10000); assert.equal(result.sources[0].actualQuality, 250);
  assert.equal(result.sources[0].url, 'https://cdn.bilivideo.com/live/index.m3u8?token=fixture%2B&deadline=2000000000');
  await broker.resolve(origin, input, new AbortController().signal);
  assert.equal(requests, 2);
  for (const url of ['http://cdn.bilivideo.com/a.flv', 'https://bilivideo.com.evil.test/a.flv', 'https://u:p@cdn.bilivideo.com/a.flv']) assert.equal(isTrustedPlaybackUrl(url), false);
  const unsafe = play();
  unsafe.data.playurl_info.playurl.stream[0].format[0].codec[0].url_info[0].host = 'https://evil.test';
  assert.equal(parsePlaybackInfo(unsafe.data, '1', 10000, Date.now()).sources.length, 0);
});

test('future bounded quality IDs work through the broker and malformed IDs never send requests', async () => {
  let requests = 0;
  const broker = new LocalLoginBroker({ fetch: (async url => {
    requests++;
    if (String(url).includes('/nav')) return json(nav);
    assert.equal(new URL(String(url)).searchParams.get('qn'), '32000');
    const value = play(32000);
    value.data.playurl_info.playurl.g_qn_desc.push({ qn: 32000, desc: '上游新画质' });
    value.data.playurl_info.playurl.stream[0].format[0].codec[0].accept_qn.push(32000);
    return json(value);
  }) as typeof fetch });
  broker.authorize(origin, true);
  for (const qn of [0, -1, 250.5, 100001, Infinity]) {
    await assert.rejects(broker.resolve(origin, { roomId: '1', qn, authEpoch: broker.authEpoch }, new AbortController().signal),
      (error: unknown) => error instanceof BrokerError && error.code === 'INVALID_REQUEST');
  }
  assert.equal(requests, 0);
  const info = await broker.resolve(origin, { roomId: '1', qn: 32000, authEpoch: broker.authEpoch }, new AbortController().signal);
  assert.equal(info.sources[0].actualQuality, 32000);
  assert.ok(info.capabilities?.[0].qualities.some(item => item.qn === 32000));
  assert.equal(requests, 2);
});

test('same-key callers share work and one caller cancellation does not abort another', async () => {
  let release!: () => void, calls = 0;
  const gate = new Promise<void>(resolve => release = resolve);
  const broker = new LocalLoginBroker({ fetch: (async url => {
    if (String(url).includes('/nav')) return json(nav);
    calls++; await gate; return json(play());
  }) as typeof fetch });
  broker.authorize(origin, true);
  await broker.account(origin);
  const first = new AbortController(), second = new AbortController();
  const input = { roomId: '1', qn: 10000, authEpoch: broker.authEpoch };
  const a = broker.resolve(origin, input, first.signal), b = broker.resolve(origin, input, second.signal);
  const rejected = assert.rejects(a, { name: 'AbortError' });
  await tick(); first.abort(); release(); await rejected;
  assert.equal((await b).status, 'live'); assert.equal(calls, 1);
});

test('ordinary caller joins a forced refresh before considering an older cached source', async () => {
  let release!: () => void, calls = 0;
  const gate = new Promise<void>(resolve => release = resolve);
  const broker = new LocalLoginBroker({ fetch: (async url => {
    if (String(url).includes('/nav')) return json(nav);
    calls++;
    if (calls === 2) { await gate; return json(play(10000)); }
    return json(play(250));
  }) as typeof fetch });
  broker.authorize(origin, true);
  const input = { roomId: '1', qn: 10000, authEpoch: broker.authEpoch };
  await broker.resolve(origin, input, new AbortController().signal);
  const forced = broker.resolve(origin, { ...input, force: true }, new AbortController().signal);
  await tick();
  const ordinary = broker.resolve(origin, input, new AbortController().signal);
  release();
  const [a, b] = await Promise.all([forced, ordinary]);
  assert.equal(a.sources[0].actualQuality, 10000); assert.deepEqual(b, a); assert.equal(calls, 2);
});

test('a burst of session cookie notifications emits only its latest account epoch', async () => {
  const epochs: string[] = [];
  const notify = accountEventNotifier(epoch => epochs.push(epoch), 10);
  for (let index = 0; index < 20; index++) notify(String(index));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(epochs, ['19']);
});

test('account epoch invalidates old pending results and clears old cache', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => release = resolve);
  const broker = new LocalLoginBroker({ fetch: (async url => {
    if (String(url).includes('/nav')) return json(nav);
    await gate; return json(play());
  }) as typeof fetch });
  broker.authorize(origin, true);
  const old = broker.authEpoch;
  const pending = broker.resolve(origin, { roomId: '1', qn: 10000, authEpoch: old }, new AbortController().signal);
  const rejected = assert.rejects(pending, (value: unknown) => value instanceof BrokerError && value.code === 'ACCOUNT_CHANGED');
  await tick(); broker.invalidate(); release(); await rejected;
  assert.notEqual(old, broker.authEpoch);
  await assert.rejects(broker.resolve(origin, { roomId: '1', qn: 10000, authEpoch: old }, new AbortController().signal), (value: unknown) => value instanceof BrokerError && value.code === 'ACCOUNT_CHANGED');
});

test('force refresh limit is per room across different qualities', async () => {
  const broker = new LocalLoginBroker({ fetch: (async url => json(String(url).includes('/nav') ? nav : play())) as typeof fetch });
  broker.authorize(origin, true);
  await broker.resolve(origin, { roomId: '1', qn: 10000, force: true, authEpoch: broker.authEpoch }, new AbortController().signal);
  await assert.rejects(broker.resolve(origin, { roomId: '1', qn: 250, force: true, authEpoch: broker.authEpoch }, new AbortController().signal), (value: unknown) => value instanceof BrokerError && value.code === 'RATE_LIMITED');
});

test('risk responses apply global cooldown; changing accounts cannot bypass it', async () => {
  let calls = 0;
  const broker = new LocalLoginBroker({ fetch: (async () => { calls++; return new Response('', { status: 429, headers: { 'retry-after': '40' } }); }) as typeof fetch });
  broker.authorize(origin, true);
  await assert.rejects(broker.account(origin), (value: unknown) => value instanceof BrokerError && value.code === 'RATE_LIMITED' && value.retryAfter === 40);
  broker.invalidate();
  await assert.rejects(broker.account(origin), (value: unknown) => value instanceof BrokerError && value.code === 'RATE_LIMITED');
  assert.equal(calls, 1);
});

test('upstream playback requests are limited to four concurrently', async () => {
  let active = 0, peak = 0;
  const broker = new LocalLoginBroker({ fetch: (async url => {
    if (String(url).includes('/nav')) return json(nav);
    peak = Math.max(peak, ++active); await tick(); active--; return json(play());
  }) as typeof fetch });
  broker.authorize(origin, true);
  await broker.account(origin);
  await Promise.all(Array.from({ length: 12 }, (_, index) => broker.resolve(origin, { roomId: String(index + 1), qn: 250, authEpoch: broker.authEpoch }, new AbortController().signal)));
  assert.equal(peak, 4);
});

test('verified identity is reused across long healthy use until a credential event or explicit check', async () => {
  let now = 1_000, navRequests = 0;
  const broker = new LocalLoginBroker({ now: () => now, fetch: (async url => {
    if (String(url).includes('/nav')) { navRequests++; return json(nav); }
    return json(play(250));
  }) as typeof fetch });
  broker.authorize(origin, true);
  await broker.account(origin);
  now += 7 * 24 * 60 * 60_000;
  await Promise.all(Array.from({ length: 12 }, (_, index) => broker.resolve(origin,
    { roomId: String(index + 1), qn: 250, authEpoch: broker.authEpoch }, new AbortController().signal)));
  assert.equal(navRequests, 1, 'normal work does not periodically revalidate the same credentials');
  await broker.account(origin, undefined, true); assert.equal(navRequests, 2);
  broker.invalidate(); await broker.account(origin); assert.equal(navRequests, 3);
});

test('network errors and non-logout NAV payloads preserve previously verified identity', async () => {
  let payload: unknown = nav, offline = false, requests = 0;
  const broker = new LocalLoginBroker({ fetch: (async () => {
    requests++; if (offline) throw new TypeError('offline'); return json(payload);
  }) as typeof fetch });
  broker.authorize(origin, true);
  const first = await broker.account(origin);
  offline = true;
  await assert.rejects(broker.account(origin, undefined, true), (value: unknown) => value instanceof BrokerError && value.code === 'UNAVAILABLE');
  assert.deepEqual(await broker.account(origin), first); assert.equal(requests, 2);
  offline = false; payload = { code: -500, data: { isLogin: false } };
  await assert.rejects(broker.account(origin, undefined, true), (value: unknown) => value instanceof BrokerError && value.code === 'UNAVAILABLE');
  assert.deepEqual(await broker.account(origin), first); assert.equal(requests, 3);
});
