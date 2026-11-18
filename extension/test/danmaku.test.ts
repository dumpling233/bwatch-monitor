import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { LocalCookieTransport } from '../lib/cookieTransport';
import { BrokerError, LocalLoginBroker } from '../lib/broker';
import { LoginSessions } from '../lib/loginSessions';
import { LocalDanmakuService } from '../lib/danmaku';
import { md5, signWbi } from '../lib/wbi';
import { PUBLIC_AVATAR_CACHE_KEY, PUBLIC_AVATAR_CACHE_LIMITS } from '../lib/publicAvatarCache';

const origin = 'https://bwatch.icu';
const signal = () => new AbortController().signal;
const response = (value: unknown) => new Response(JSON.stringify(value));
const cookie = (name: string, value: string) => ({ name, value, domain: '.bilibili.com', path: '/',
  session: true, storeId: '0', secure: true, httpOnly: true, hostOnly: false, sameSite: 'lax' }) as chrome.cookies.Cookie;
function harness(catalog = false) {
  let stored: Record<string, unknown> = {}, now = 1_000_000, uid: string | undefined = '42', csrf = true;
  let cookiesRead = 0, navRequests = 0, posts = 0, failSave = false, directoryFailure = false;
  let sendPayload: unknown = { code: 0, message: '', data: {} }, directoryPayload: unknown;
  let sendError: Error | undefined, beforePost: (() => Promise<void>) | undefined, beforeRoom: (() => Promise<void>) | undefined;
  let profilePayload: unknown, profileError: Error | undefined, beforeProfile: (() => Promise<void>) | undefined;
  let profileStatus = 200, profileRetryAfter = '';
  const services = new Set<LocalDanmakuService>();
  const rules = new Map<number, chrome.declarativeNetRequest.Rule>();
  const network: Array<{ url: URL; cookie: string; body?: URLSearchParams; credentials?: RequestCredentials }> = [];
  const storage = { get: async () => structuredClone(stored), set: async (value: Record<string, unknown>) => {
    if (failSave) throw new Error('storage failed'); stored = { ...stored, ...structuredClone(value) };
  } };
  const newTransport = () => new LocalCookieTransport({ extensionId: 'testextension', now: () => now,
    getCookies: async () => { cookiesRead++; return [cookie('SESSDATA', 'fixture-session'), cookie('DedeUserID', uid ?? ''),
      ...(csrf ? [cookie('bili_jct', 'fixture-csrf')] : []), cookie('buvid3', 'fixture-cookie-device')]; },
    updateRules: async value => { for (const id of value.removeRuleIds ?? []) rules.delete(id);
      for (const rule of value.addRules ?? []) rules.set(rule.id, rule); } });
  const newBroker = () => new LocalLoginBroker({ now: () => now, fetch: (async () => {
    navRequests++; return response(uid ? { code: 0, data: { isLogin: true, mid: uid, uname: 'fixture' } }
      : { code: -101, data: { isLogin: false } });
  }) as typeof fetch });
  const newSessions = (broker: LocalLoginBroker) => new LoginSessions({ storage, broker, allowedOrigin: value => value === origin, now: () => now,
    onChange: (_origin, _revision, reason) => {
      if (['revoked', 'permission-removed', 'logged-out', 'account-changed', 'playback-disabled'].includes(reason)) for (const service of services) service.invalidate();
    } });
  const transport = newTransport(), broker = newBroker(), sessions = newSessions(broker);
  const fetchMock = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    const matched = [...rules.values()].filter(rule => rule.condition.regexFilter && new RegExp(rule.condition.regexFilter).test(url.href));
    assert.equal(matched.length, 1, 'every network request owns exactly one identity rule');
    const cookieRule = matched[0].action.requestHeaders?.find(header => header.header === 'Cookie');
    network.push({ url, cookie: cookieRule?.value ?? '', credentials: init?.credentials,
      ...(init?.body instanceof URLSearchParams ? { body: init.body } : {}) });
    if (url.pathname.endsWith('/nav')) return response({ code: -101, data: { wbi_img: {
      img_url: `https://i0.hdslb.com/bfs/wbi/${'a'.repeat(32)}.png`, sub_url: `https://i0.hdslb.com/bfs/wbi/${'b'.repeat(32)}.png` } } });
    if (url.pathname.endsWith('/spi')) return response({ code: 0, data: { b_3: 'fixture-anonymous-device' } });
    if (url.pathname.endsWith('/room_init')) { await beforeRoom?.(); return response({ code: 0, data: { room_id: 1001 } }); }
    if (url.pathname.endsWith('/getDanmuInfo')) return response({ code: 0, data: { token: 'fixture-token', host_list: [
      { host: 'broadcastlv.chat.bilibili.com', wss_port: 443 }, { host: 'chat.bilibili.com.evil.test', wss_port: 443 } ] } });
    if (url.pathname.endsWith('/GetEmoticons') && directoryFailure) throw new TypeError('directory offline');
    if (url.pathname.endsWith('/GetEmoticons')) return response(directoryPayload ?? { code: 0, data: { data: [
      { pkg_type: 1, pkg_name: '房间表情', emoticons: [
        { emoticon_unique: 'unlock', emoji: '可用', url: 'https://i0.hdslb.com/unlock.png', perm: 1 },
        { emoticon_unique: 'locked', emoji: '不可用', url: 'https://evil.test/image', perm: 0 } ] },
      { pkg_type: 3, pkg_name: '文字表情', emoticons: [{ emoticon_unique: 'small', emoji: '[笑]', perm: 1 }] }
    ] } });
    if (url.pathname.endsWith('/getInfoByUser')) return response({ code: 0, data: { unknown_variant: true } });
    if (url.pathname === '/live_user/v1/Master/info') {
      await beforeProfile?.(); if (profileError) throw profileError;
      return new Response(JSON.stringify(profilePayload ?? { code: 0, data: {
        info: { uid: url.searchParams.get('uid'), uname: '资料用户', face: 'https://evil.test/face', gender: 1 },
        exp: { master_level: { level: 9 } }, room_id: 0 } }),
        { status: profileStatus, headers: profileRetryAfter ? { 'retry-after': profileRetryAfter } : {} });
    }
    if (url.pathname.endsWith('/msg/send')) {
      posts++; await beforePost?.();
      if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      if (sendError) throw sendError; return response(sendPayload);
    }
    throw new Error('unexpected fixture endpoint');
  }) as typeof fetch;
  const instance = () => {
    const value = new LocalDanmakuService({ transport, broker, sessions, storage,
      ...(catalog ? { catalogStorage: storage } : {}), now: () => now, fetch: fetchMock });
    services.add(value); return value;
  };
  const service = instance();
  // Unlike instance(), rebuild every worker-owned authority and transport.
  // Only browser storage, fixture cookie values and upstream adapters survive.
  const restart = () => {
    const transport = newTransport(), broker = newBroker(), sessions = newSessions(broker);
    const service = new LocalDanmakuService({ transport, broker, sessions, storage,
      ...(catalog ? { catalogStorage: storage } : {}), now: () => now, fetch: fetchMock });
    services.add(service);
    return { transport, broker, sessions, service };
  };
  const connect = async () => { await sessions.ready; return sessions.authorize(origin, { revision: sessions.read(origin).revision }); };
  return { service, instance, restart, sessions, broker, transport, network, rules, connect, storage,
    get cookiesRead() { return cookiesRead; }, get navRequests() { return navRequests; }, get posts() { return posts; }, get stored() { return stored; },
    set now(value: number) { now = value; }, set uid(value: string | undefined) { uid = value; },
    set csrf(value: boolean) { csrf = value; }, set failSave(value: boolean) { failSave = value; },
    set profilePayload(value: unknown) { profilePayload = value; }, set profileError(value: Error | undefined) { profileError = value; },
    set profileStatus(value: number) { profileStatus = value; }, set profileRetryAfter(value: string) { profileRetryAfter = value; },
    set beforeProfile(value: (() => Promise<void>) | undefined) { beforeProfile = value; },
    set directoryFailure(value: boolean) { directoryFailure = value; },
    set directoryPayload(value: unknown) { directoryPayload = value; },
    set sendError(value: Error | undefined) { sendError = value; }, set sendPayload(value: unknown) { sendPayload = value; },
    set beforePost(value: (() => Promise<void>) | undefined) { beforePost = value; },
    set beforeRoom(value: (() => Promise<void>) | undefined) { beforeRoom = value; } };
}

test('browser WBI MD5 matches known and multiblock UTF-8 reference vectors', () => {
  for (const value of ['', 'abc', 'a'.repeat(65), '弹幕'.repeat(100)]) assert.equal(md5(value), createHash('md5').update(value).digest('hex'));
  const signed = signWbi({ id: '1001', type: 0 }, 'fixture', 1_000_000);
  assert.equal(signed.get('w_rid'), createHash('md5').update('id=1001&type=0&wts=1000fixture').digest('hex'));
});

test('anonymous local bootstrap needs no account grant and never reads/injects account cookies', async () => {
  const item = harness();
  const result = await item.service.resolve(origin, { roomId: '1', mode: 'anonymous' }, signal());
  assert.equal(result.uid, '0'); assert.equal(result.accountUid, undefined); assert.equal(result.roomId, '1001');
  assert.equal(result.hosts.length, 1); assert.equal(item.cookiesRead, 0);
  for (const request of item.network) {
    assert.equal(request.credentials, 'omit');
    assert.equal(/SESSDATA|bili_jct|DedeUserID/.test(request.cookie), false);
  }
  assert.equal(item.rules.size, 0, 'HTTP identity rules are removed after requests');
});

test('complete trusted authorization enables all account capabilities and legacy grants cannot grant them', async () => {
  const item = harness(); await item.sessions.grant(origin, true);
  await assert.rejects(item.sessions.update(origin, { revision: item.sessions.read(origin).revision, chatWanted: true }), /设置参数无效/);
  const legacy = await item.sessions.enableChat(origin);
  assert.equal(legacy.chatAllowed, false); assert.equal(legacy.playbackAllowed, false);
  const enabled = await item.connect();
  assert.equal(enabled.chatAllowed, true); assert.equal(enabled.playbackAllowed, true); assert.equal(enabled.danmakuAllowed, true);
  assert.equal((await item.sessions.get(origin)).chatAllowed, true);
  item.uid = '43'; item.broker.invalidate(); item.sessions.credentialsChanged(1);
  assert.equal((await item.sessions.get(origin, undefined, true)).preferences.chatWanted, false);
});

test('authenticated bootstrap uses matching actual device identity and sanitizes hosts', async () => {
  const item = harness(), session = await item.connect();
  const result = await item.service.resolve(origin, { roomId: '1', mode: 'authenticated', authEpoch: session.account!.authEpoch }, signal());
  assert.equal(result.uid, '42'); assert.equal(result.buvid, 'fixture-cookie-device');
  const config = item.network.find(request => request.url.pathname.endsWith('/getDanmuInfo'))!;
  assert.match(config.cookie, /SESSDATA=fixture-session/); assert.match(config.cookie, /buvid3=fixture-cookie-device/);
});

test('context projects text/image permissions without inventing unsupported capability fields', async () => {
  const item = harness(), session = await item.connect();
  const result = await item.service.context(origin, { roomId: '1', authEpoch: session.account!.authEpoch }, signal());
  assert.equal(result.emoticons.find(item => item.unique === 'small')?.kind, 'text');
  assert.equal(result.emoticons.find(item => item.unique === 'locked')?.permitted, false);
  assert.equal(result.emoticons.find(item => item.unique === 'locked')?.url, '');
  assert.equal(result.emoticonsAvailable, true);
  assert.deepEqual(result.emoticonPackages?.map(pkg => pkg.name), ['房间表情', '文字表情']);
  assert.equal(result.maxLength, undefined); assert.equal(result.cooldownSeconds, undefined); assert.equal(result.muted, undefined);
  assert.equal(item.network.some(request => request.url.pathname.endsWith('/getInfoByUser')), false, 'no unused advisory preflight competes with playback');
  const requests = item.network.length;
  await item.service.context(origin, { roomId: '1', authEpoch: session.account!.authEpoch }, signal());
  assert.equal(item.network.length, requests, 'reopening the same fresh context causes no upstream queries');
});

test('a long lived display catalog avoids upstream requests after 30 seconds and worker reconstruction', async () => {
  const item = harness(true), session = await item.connect(), input = { roomId: '1', authEpoch: session.account!.authEpoch };
  const first = await item.service.context(origin, input, signal());
  assert.equal(first.emoticonPermissionsVerified, true); assert.equal(first.emoticonsCached, false);
  await new Promise(resolve => setImmediate(resolve));
  const requests = item.network.length;
  item.now = 1_060_000;
  const cached = await item.service.context(origin, input, signal());
  assert.equal(cached.emoticonsCached, true); assert.equal(cached.emoticonPermissionsVerified, false);
  assert.deepEqual(cached.emoticonPackages, first.emoticonPackages);
  const restarted = item.instance(); await restarted.ready;
  const restored = await restarted.context(origin, input, signal());
  assert.equal(restored.roomId, '1001'); assert.equal(restored.accountUid, '42');
  assert.equal(restored.authEpoch, session.account!.authEpoch); assert.equal(restored.emoticonsCached, true);
  assert.equal(item.network.length, requests, 'no room_init, device or emoticon request for a fresh display catalog');
  assert.doesNotMatch(JSON.stringify(item.stored.bwatchMonitorEmoticonCatalog), /authEpoch|fixture-session|fixture-csrf|fixture-token/);
  let verified = 0;
  const broker = new LocalLoginBroker({ now: () => 1_060_000, fetch: (async () => {
    verified++; return response({ code: 0, data: { isLogin: true, mid: '42', uname: 'fixture' } });
  }) as typeof fetch });
  const sessions = new LoginSessions({ broker, storage: item.storage, allowedOrigin: value => value === origin, now: () => 1_060_000 });
  await sessions.ready;
  const newSession = await sessions.get(origin);
  assert.equal(verified, 1, 'a new worker must verify saved authorization rather than restore account evidence');
  assert.notEqual(newSession.account!.authEpoch, session.account!.authEpoch);
  const newWorker = new LocalDanmakuService({ broker, sessions, transport: item.transport, storage: item.storage, catalogStorage: item.storage,
    now: () => 1_060_000, fetch: (async () => { throw new Error('fresh catalogs need no directory or room request'); }) as typeof fetch });
  const rebound = await newWorker.context(origin, { roomId: '1', authEpoch: newSession.account!.authEpoch }, signal());
  assert.equal(rebound.authEpoch, newSession.account!.authEpoch); assert.equal(rebound.accountUid, '42');
  assert.equal(rebound.emoticonPermissionsVerified, false);
});

test('an expired display catalog refreshes on demand and survives an ordinary outage without granting sends', async () => {
  const item = harness(true), session = await item.connect(), input = { roomId: '1', authEpoch: session.account!.authEpoch };
  await item.service.context(origin, input, signal()); item.now = 1_000_000 + 86_400_000;
  item.directoryFailure = true;
  const fallback = await item.service.context(origin, input, signal());
  assert.equal(fallback.emoticonsCached, true); assert.equal(fallback.emoticonPermissionsVerified, false);
  assert.ok(fallback.emoticons.length > 0);
  const attempts = item.network.length;
  await item.service.context(origin, input, signal());
  assert.equal(item.network.length, attempts, 'repeated openings during a stale refresh outage reuse display data for one minute');
  const forced = await item.service.context(origin, { ...input, force: true }, signal());
  assert.equal(forced.emoticonsAvailable, false); assert.equal(forced.emoticonPermissionsVerified, false);
  assert.deepEqual(forced.emoticons, []);
  await assert.rejects(item.service.send(origin, { ...input, operationId: 'cached-directory-outage', emoticonUnique: 'unlock' }, signal()), /表情目录暂不可用/);
  assert.equal(item.posts, 0);
  item.directoryFailure = false;
  const updated = await item.service.context(origin, { ...input, force: true }, signal());
  assert.equal(updated.emoticonsCached, false); assert.equal(updated.emoticonPermissionsVerified, true);
});

test('explicit display refresh validates strict boolean input and does not accept a fresh old permission', async () => {
  const item = harness(true), session = await item.connect(), input = { roomId: '1', authEpoch: session.account!.authEpoch };
  await item.service.context(origin, input, signal());
  item.directoryPayload = { code: 0, data: { data: [{ pkg_id: 'room', pkg_type: 2, pkg_name: '房间表情',
    emoticons: [{ emoticon_unique: 'unlock', emoji: '粉丝团', perm: 0, identity: 4, unlock_need_level: 10 }] }] } };
  await assert.rejects(item.service.context(origin, { ...input, force: 'true' as never }, signal()), /更新参数/);
  const refreshed = await item.service.context(origin, { ...input, force: true }, signal());
  assert.equal(refreshed.emoticons[0].permitted, false);
  assert.match(refreshed.emoticons[0].unlockHint!, /10 级/);
  await assert.rejects(item.service.send(origin, { ...input, operationId: 'cached-perm-denied', emoticonUnique: 'unlock' }, signal()), /10 级/);
  assert.equal(item.posts, 0);
});

test('invalidating a pending context prevents late results and disk catalogs from returning', async () => {
  const item = harness(true), session = await item.connect(), input = { roomId: '1', authEpoch: session.account!.authEpoch };
  let release!: () => void, begun!: () => void;
  const started = new Promise<void>(resolve => { begun = resolve; });
  item.beforeRoom = () => { begun(); return new Promise(resolve => { release = resolve; }); };
  const pending = item.service.context(origin, input, signal()); await started;
  item.service.invalidate(); item.beforeRoom = undefined; release();
  await assert.rejects(pending, /请求已取消/);
  await new Promise(resolve => setImmediate(resolve));
  const restarted = item.instance(); await restarted.ready;
  const count = item.network.filter(row => row.url.pathname.endsWith('/GetEmoticons')).length;
  await restarted.context(origin, input, signal());
  assert.equal(item.network.filter(row => row.url.pathname.endsWith('/GetEmoticons')).length, count + 1);
});

test('an explicit permission read cannot join an ordinary stale display fallback', async () => {
  const item = harness(true), session = await item.connect(), input = { roomId: '1', authEpoch: session.account!.authEpoch };
  await item.service.context(origin, input, signal()); item.now = 1_000_000 + 86_400_000; item.directoryFailure = true;
  let release!: () => void, begun!: () => void, calls = 0;
  const started = new Promise<void>(resolve => { begun = resolve; });
  item.beforeRoom = async () => { if (++calls === 1) { begun(); await new Promise<void>(resolve => { release = resolve; }); } };
  const ordinary = item.service.context(origin, input, signal()); await started;
  const force = item.service.context(origin, { ...input, force: true }, signal());
  release(); const [cached, fresh] = await Promise.all([ordinary, force]);
  assert.equal(cached.emoticonsCached, true); assert.ok(cached.emoticons.length);
  assert.equal(fresh.emoticonsCached, false); assert.equal(fresh.emoticonsAvailable, false); assert.deepEqual(fresh.emoticons, []);
});

test('cancelling one page does not cancel another shared stale display recovery', async () => {
  const item = harness(true), session = await item.connect(), input = { roomId: '1', authEpoch: session.account!.authEpoch };
  await item.service.context(origin, input, signal()); item.now = 1_000_000 + 86_400_000; item.directoryFailure = true;
  let release!: () => void, begun!: () => void;
  const started = new Promise<void>(resolve => { begun = resolve; });
  item.beforeRoom = () => { begun(); return new Promise(resolve => { release = resolve; }); };
  const controller = new AbortController();
  const first = item.service.context(origin, input, controller.signal); await started;
  const second = item.service.context(origin, input, signal());
  await new Promise(resolve => setImmediate(resolve));
  const cancelled = assert.rejects(first, /请求已取消/);
  controller.abort(); release(); await cancelled;
  assert.equal((await second).emoticonsCached, true);
});

test('revocation and verified account switching clear persisted catalogs before a new authorization', async () => {
  const item = harness(true), initial = await item.connect();
  await item.service.context(origin, { roomId: '1', authEpoch: initial.account!.authEpoch }, signal());
  await new Promise(resolve => setImmediate(resolve));
  assert.ok((item.stored.bwatchMonitorEmoticonCatalog as { rows: unknown[] }).rows.length);
  await item.sessions.grant(origin, false);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual((item.stored.bwatchMonitorEmoticonCatalog as { rows: unknown[] }).rows, []);
  await assert.rejects(item.instance().context(origin, { roomId: '1', authEpoch: initial.account!.authEpoch }, signal()), /授权|连接/);
  const renewed = await item.connect();
  await item.service.context(origin, { roomId: '1', authEpoch: renewed.account!.authEpoch }, signal());
  item.uid = '43'; item.broker.invalidate();
  const changed = await item.sessions.get(origin, signal(), true);
  assert.equal(changed.chatAllowed, false);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual((item.stored.bwatchMonitorEmoticonCatalog as { rows: unknown[] }).rows, []);
  const newAccount = await item.connect(), count = item.network.length;
  const context = await item.instance().context(origin, { roomId: '1', authEpoch: newAccount.account!.authEpoch }, signal());
  assert.equal(context.accountUid, '43'); assert.equal(context.emoticonsCached, false);
  assert.ok(item.network.length > count, 'the replacement account obtains its own official room catalog');
});

test('an empty official directory differs from an unavailable or malformed directory', async () => {
  const item = harness(), session = await item.connect(), input = { roomId: '1', authEpoch: session.account!.authEpoch };
  item.directoryPayload = { code: 0, data: { data: [] } };
  assert.equal((await item.service.context(origin, input, signal(), true)).emoticonsAvailable, true);
  item.directoryPayload = { code: 0, data: { unexpected: [] } };
  assert.equal((await item.service.context(origin, input, signal(), true)).emoticonsAvailable, false);
  item.directoryFailure = true;
  const failed = await item.service.context(origin, input, signal(), true);
  assert.equal(failed.emoticonsAvailable, false); assert.deepEqual(failed.emoticons, []);
  assert.equal((await item.service.send(origin, { ...input, operationId: 'directory-failed-text', text: 'fixture' }, signal())).status, 'submitted');
});

test('large image sends revalidate current room permission and report the actual lock condition', async () => {
  const item = harness(), session = await item.connect(), input = { roomId: '1', authEpoch: session.account!.authEpoch };
  const before = await item.service.context(origin, input, signal());
  assert.equal(before.emoticons.find(emote => emote.unique === 'unlock')?.permitted, true);
  item.directoryPayload = { code: 0, data: { data: [{ pkg_id: 'room', pkg_type: 2, pkg_name: '主播表情',
    emoticons: [{ emoticon_unique: 'unlock', emoji: '舰长表情', perm: 0, identity: 3, unlock_show_text: '舰长' }] }] } };
  await assert.rejects(item.service.send(origin, { ...input, operationId: 'permissions-changed', emoticonUnique: 'unlock' }, signal()), /需要开通本直播间主播的舰长/);
  assert.equal(item.posts, 0);
  const requests = item.network.filter(request => request.url.pathname.endsWith('/GetEmoticons'));
  assert.equal(requests.length, 2); assert.equal(requests.every(request => request.url.searchParams.get('room_id') === '1001'), true);
});

test('an immediate user retry after a directory outage reaches upstream without a failure TTL', async () => {
  const item = harness(), session = await item.connect(), input = { roomId: '1', authEpoch: session.account!.authEpoch };
  item.directoryFailure = true;
  assert.equal((await item.service.context(origin, input, signal())).emoticonsAvailable, false);
  item.directoryFailure = false;
  const recovered = await item.service.context(origin, input, signal());
  assert.equal(recovered.emoticonsAvailable, true);
  assert.ok(recovered.emoticons.length > 0);
  assert.equal(item.network.filter(request => request.url.pathname.endsWith('/GetEmoticons')).length, 2);
  await item.service.context(origin, input, signal());
  assert.equal(item.network.filter(request => request.url.pathname.endsWith('/GetEmoticons')).length, 2, 'successful contexts still reuse their short cache');
  item.directoryFailure = true;
  assert.equal((await item.service.context(origin, input, signal(), true)).emoticonsAvailable, false);
  item.directoryFailure = false;
  const displayOnly = await item.service.context(origin, input, signal());
  assert.equal(displayOnly.emoticonsAvailable, true); assert.equal(displayOnly.emoticonPermissionsVerified, false);
  assert.equal(item.network.filter(request => request.url.pathname.endsWith('/GetEmoticons')).length, 3, 'a forced failure preserves the non-authoritative display catalog');
  assert.equal((await item.service.context(origin, { ...input, force: true }, signal())).emoticonPermissionsVerified, true);
  assert.equal(item.network.filter(request => request.url.pathname.endsWith('/GetEmoticons')).length, 4, 'an explicit permission refresh immediately reaches upstream');
});

test('send uses extension-only CSRF and real room, and one operation ID never posts twice', async () => {
  const item = harness(), session = await item.connect();
  const input = { roomId: '1', authEpoch: session.account!.authEpoch, operationId: 'operation-0001', text: 'fixture message' };
  const [first] = await Promise.all([item.service.send(origin, input, signal()), item.service.send(origin, input, signal())]);
  assert.equal(first.status, 'submitted'); assert.equal(item.posts, 1);
  const request = item.network.find(request => request.body)!;
  assert.equal(request.url.href, 'https://api.live.bilibili.com/msg/send');
  assert.equal(request.body!.get('csrf'), 'fixture-csrf'); assert.equal(request.body!.get('csrf_token'), 'fixture-csrf');
  assert.equal(request.body!.get('roomid'), '1001');
  const result = await item.service.send(origin, input, signal());
  assert.equal(result.status, 'submitted'); assert.equal(item.posts, 1);
  assert.equal(JSON.stringify(item.stored).includes('fixture message'), false);
  assert.equal(JSON.stringify(item.stored).includes('fixture-csrf'), false);
});

test('timeout becomes unknown and remains queryable after worker recreation without retry', async () => {
  const item = harness(), session = await item.connect(); item.sendError = new DOMException('timeout', 'TimeoutError');
  const input = { roomId: '1', authEpoch: session.account!.authEpoch, operationId: 'operation-timeout', text: 'fixture' };
  assert.equal((await item.service.send(origin, input, signal())).status, 'unknown');
  const restored = item.instance(); await restored.ready;
  assert.equal((await restored.result(origin, input.operationId)).status, 'unknown');
  assert.equal((await restored.send(origin, input, signal())).status, 'unknown'); assert.equal(item.posts, 1);
});

test('result joins the same worker in-flight POST and publishes its definitive result without another request', async () => {
  const item = harness(), session = await item.connect();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  item.beforePost = async () => { entered(); await gate; };
  const input = { roomId: '1', authEpoch: session.account!.authEpoch, operationId: 'query-inflight-action', text: 'fixture' };
  const sending = item.service.send(origin, input, signal());
  await started;
  const requests = item.network.length, navRequests = item.navRequests;
  let finished = false;
  const query = item.service.result(origin, input.operationId).then(value => { finished = true; return value; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(finished, false, 'the query remains pending while the existing POST has no result');
  assert.equal(item.posts, 1); assert.equal(item.network.length, requests); assert.equal(item.navRequests, navRequests);
  release();
  assert.equal((await sending).status, 'submitted');
  assert.equal((await query).status, 'submitted');
  assert.equal(item.posts, 1); assert.equal(item.network.length, requests); assert.equal(item.navRequests, navRequests);
});

test('revocation while a result query waits prevents the old completed result from leaking to a changed authorization', async () => {
  for (const reauthorize of [false, true]) {
    const item = harness(), session = await item.connect();
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    item.beforePost = async () => { entered(); await gate; };
    const input = { roomId: '1', authEpoch: session.account!.authEpoch, operationId: `query-revoke-action-${reauthorize}`, text: 'fixture' };
    const sending = item.service.send(origin, input, signal()); await started;
    let finished = false;
    const query = item.service.result(origin, input.operationId).then(value => { finished = true; return value; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(finished, false);
    await item.sessions.grant(origin, false);
    if (reauthorize) await item.connect();
    release();
    assert.equal((await sending).status, 'submitted', 'revoking permission cannot retract an already-dispatched POST');
    assert.equal((await query).status, 'unknown', reauthorize ? 'even a new authorization for the same UID is a new scope' : 'revoked scope cannot read the old result');
    assert.equal(item.posts, 1);
  }
});

test('a complete restarted worker returns restored dispatching as unknown immediately without waiting or resubmitting', async () => {
  const item = harness(), session = await item.connect();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  item.beforePost = async () => { entered(); await gate; };
  const input = { roomId: '1', authEpoch: session.account!.authEpoch, operationId: 'query-restarted-inflight', text: 'fixture' };
  const sending = item.service.send(origin, input, signal()); await started;
  const restarted = item.restart(); await Promise.all([restarted.sessions.ready, restarted.service.ready]);
  const requests = item.network.length, navRequests = item.navRequests;
  let value: Awaited<ReturnType<LocalDanmakuService['result']>> | undefined;
  const query = restarted.service.result(origin, input.operationId).then(result => { value = result; return result; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(value?.status, 'unknown', 'no live task survives reconstruction, so the query does not wait for a nonexistent completion');
  assert.equal((await query).status, 'unknown');
  assert.equal(item.posts, 1); assert.equal(item.network.length, requests); assert.equal(item.navRequests, navRequests);
  release(); await sending;
});

test('a complete worker restart rejects an old send epoch before POST and the same action can prepare its current same-UID epoch', async () => {
  const item = harness(), authorized = await item.connect();
  const input = { roomId: '1', authEpoch: authorized.account!.authEpoch, operationId: 'worker-old-epoch-action', text: 'fixture' };
  const restarted = item.restart();
  await Promise.all([restarted.sessions.ready, restarted.service.ready]);
  assert.notEqual(restarted.broker, item.broker);
  assert.notEqual(restarted.sessions, item.sessions);
  assert.notEqual(restarted.transport, item.transport);
  assert.notEqual(restarted.broker.authEpoch, input.authEpoch);
  assert.deepEqual(restarted.sessions.read(origin), authorized.preferences, 'durable authorization survives, runtime evidence does not');
  assert.equal(item.navRequests, 1, 'constructing a worker never polls the upstream account');
  await assert.rejects(restarted.service.send(origin, input, signal()),
    error => error instanceof BrokerError && error.code === 'ACCOUNT_CHANGED');
  assert.equal(item.posts, 0);
  assert.equal(JSON.stringify(item.stored).includes(input.operationId), false, 'stale epoch fails before a send ledger reservation');
  assert.equal(item.navRequests, 2, 'the rejected old request still restored the bound UID once');
  const prepared = await restarted.sessions.get(origin, signal(), false);
  assert.equal(prepared.chatAllowed, true);
  assert.equal(prepared.account?.uid, authorized.account?.uid);
  assert.notEqual(prepared.account?.authEpoch, input.authEpoch);
  assert.equal(item.navRequests, 2, 'GET_SESSION(false) reuses current worker evidence');
  const request = { ...input, authEpoch: prepared.account!.authEpoch };
  assert.equal((await restarted.service.send(origin, request, signal())).status, 'submitted');
  assert.equal(item.posts, 1, 'preparation continues the user action without a duplicate POST');
  assert.equal((await restarted.service.send(origin, request, signal())).status, 'submitted');
  assert.equal(item.posts, 1, 'the operation ledger remains idempotent after current-epoch preparation');
});

test('preparing the first send after a complete worker restart verifies once and warm explicit sends do not poll NAV', async () => {
  const item = harness(), authorized = await item.connect(), restarted = item.restart();
  const prepared = await restarted.sessions.get(origin, signal(), false);
  assert.equal(prepared.chatAllowed, true);
  assert.equal(prepared.account?.uid, authorized.account?.uid);
  assert.notEqual(prepared.account?.authEpoch, authorized.account?.authEpoch);
  assert.equal(item.navRequests, 2);
  const warm = await restarted.sessions.get(origin, signal(), false);
  assert.equal(warm.account?.authEpoch, prepared.account?.authEpoch);
  assert.equal(item.navRequests, 2, 'per-action preparation adds no upstream HTTP while evidence is healthy');
  const input = { roomId: '1', authEpoch: warm.account!.authEpoch, operationId: 'worker-prepared-first-action', text: 'fixture' };
  assert.equal((await restarted.service.send(origin, input, signal())).status, 'submitted');
  assert.equal(item.posts, 1);
  assert.equal(item.navRequests, 2);
});

test('a replacement UID discovered after a complete worker restart cannot inherit the previous action or authorization', async () => {
  const item = harness(), authorized = await item.connect(); item.uid = '43';
  const restarted = item.restart(), prepared = await restarted.sessions.get(origin, signal(), false);
  assert.equal(prepared.reason, 'account-changed');
  assert.equal(prepared.account?.uid, '43');
  assert.equal(prepared.preferences.expectedUid, '42');
  assert.equal(prepared.chatAllowed, false);
  for (const authEpoch of [authorized.account!.authEpoch, prepared.account!.authEpoch]) {
    await assert.rejects(restarted.service.send(origin, { roomId: '1', authEpoch,
      operationId: 'worker-replacement-action', text: 'fixture' }, signal()),
    error => error instanceof BrokerError && error.code === 'UNAUTHORIZED');
  }
  assert.equal(item.posts, 0);
  assert.equal(JSON.stringify(item.stored).includes('worker-replacement-action'), false);
  assert.equal(item.navRequests, 2);
});

test('persisted revocation survives a complete worker restart and preparation cannot restore the old action', async () => {
  const item = harness(), authorized = await item.connect();
  await item.sessions.grant(origin, false);
  const restarted = item.restart(), prepared = await restarted.sessions.get(origin, signal(), false);
  assert.equal(prepared.reason, 'unauthorized');
  assert.equal(prepared.preferences.granted, false);
  assert.equal(prepared.chatAllowed, false);
  assert.equal(prepared.account, undefined);
  await assert.rejects(restarted.service.send(origin, { roomId: '1', authEpoch: authorized.account!.authEpoch,
    operationId: 'worker-revoked-action', text: 'fixture' }, signal()),
  error => error instanceof BrokerError && error.code === 'UNAUTHORIZED');
  assert.equal(item.posts, 0);
  assert.equal(item.navRequests, 1, 'a revoked origin does not trigger account verification');
  assert.equal(item.cookiesRead, 0);
});

test('explicit upstream refusal with code zero preserves a rejected result', async () => {
  const item = harness(), session = await item.connect(); item.sendPayload = { code: 0, message: 'f' };
  const result = await item.service.send(origin, { roomId: '1', authEpoch: session.account!.authEpoch, operationId: 'operation-refusal', text: 'fixture' }, signal());
  assert.equal(result.status, 'rejected'); assert.match(result.message!, /未接受/);
});

test('locked images, text sent as image, missing CSRF and storage failure do not send', async () => {
  const item = harness(), session = await item.connect(), authEpoch = session.account!.authEpoch;
  for (const emoticonUnique of ['locked', 'small']) await assert.rejects(item.service.send(origin,
    { roomId: '1', authEpoch, operationId: `operation-${emoticonUnique}`, emoticonUnique }, signal()));
  item.csrf = false;
  const result = await item.service.send(origin, { roomId: '1', authEpoch, operationId: 'operation-no-csrf', text: 'fixture' }, signal());
  assert.equal(result.status, 'rejected'); assert.equal(item.posts, 0);
  item.now = 1_002_000; item.failSave = true;
  await assert.rejects(item.service.send(origin, { roomId: '1', authEpoch, operationId: 'operation-no-save', text: 'fixture' }, signal()));
  assert.equal(item.posts, 0);
});

test('revoking complete authorization stops reception, playback and sends with stale epochs', async () => {
  const item = harness(), enabled = await item.connect();
  await item.sessions.grant(origin, false);
  const disabled = await item.sessions.get(origin);
  assert.equal(disabled.chatAllowed, false); assert.equal(disabled.playbackAllowed, false); assert.equal(disabled.danmakuAllowed, false);
  await assert.rejects(item.service.send(origin, { roomId: '1', authEpoch: enabled.account!.authEpoch, operationId: 'operation-disabled', text: 'fixture' }, signal()));
  assert.equal(item.posts, 0);
});

test('public profiles remain anonymous, sanitize images and share a bounded request budget', async () => {
  const item = harness();
  const profile = await item.service.profile('1', signal()); assert.equal(profile.face, '');
  await item.service.profile('1', signal());
  for (let i = 2; i <= 20; i++) await item.service.profile(String(i), signal());
  await assert.rejects(item.service.profile('21', signal()), /过于频繁/);
  assert.equal(item.cookiesRead, 0);
  assert.equal(item.network.every(request => request.url.pathname === '/live_user/v1/Master/info'), true, 'avatar does not require WBI or a personal space request');
  assert.equal(item.network.every(request => request.cookie === '' && request.credentials === 'omit'), true);
});

test('public live avatar response works without a live room and never interprets streamer levels as user levels', async () => {
  const item = harness();
  item.profilePayload = { code: 0, data: { info: { uid: 7, uname: '公开用户', face: '//i0.hdslb.com/bfs/face/fixture.jpg', gender: 1 },
    room_id: 0, exp: { master_level: { level: 9 } } } };
  const profile = await item.service.profile('7', signal());
  assert.equal(profile.avatarCacheHit, undefined, 'a real upstream lookup consumes the request budget');
  assert.deepEqual(profile, { uid: '7', name: '公开用户', face: 'https://i0.hdslb.com/bfs/face/fixture.jpg', avatarFetchedAt: 1_000_000 });
  item.now = 1_061_000; await item.service.profile('7', signal());
  assert.equal(item.network.length, 1, 'successful avatar survives the old one minute TTL');
  assert.equal((await item.service.profile('7', signal())).avatarCacheHit, true, 'a local cache read is distinguishable from a real upstream lookup');
  item.now = 1_000_000 + PUBLIC_AVATAR_CACHE_LIMITS.freshMs + 1; await item.service.profile('7', signal());
  assert.equal(item.network.length, 2, 'avatar refreshes after its bounded one day TTL');
});

test('public avatar cache rejects wrong identities and transient failures without poisoning the UID', async () => {
  const item = harness();
  item.profilePayload = { code: 0, data: { info: { uid: 8, uname: '另一个用户', face: 'https://i0.hdslb.com/face.jpg' } } };
  await assert.rejects(item.service.profile('7', signal()), /暂不可用/);
  item.profilePayload = { code: 0, data: { info: { uid: 7, uname: '不完整字段' } } };
  await assert.rejects(item.service.profile('7', signal()), /暂不可用/);
  item.profileError = new TypeError('temporary offline');
  await assert.rejects(item.service.profile('7', signal()), /temporary offline/);
  item.profileError = undefined;
  item.profilePayload = { code: 0, data: { info: { uid: '7', uname: '正确用户', face: 'https://i0.hdslb.com/face.jpg' } } };
  assert.equal((await item.service.profile('7', signal())).face, 'https://i0.hdslb.com/face.jpg');
  assert.equal(item.network.length, 4);
});

test('an explicit missing avatar has a short negative lifetime', async () => {
  const item = harness();
  await item.service.profile('7', signal());
  item.now = 1_000_000 + 600_000 - 1; await item.service.profile('7', signal());
  assert.equal(item.network.length, 1);
  item.now = 1_000_000 + 600_000 + 1; await item.service.profile('7', signal());
  assert.equal(item.network.length, 2);
});

test('a profile rate limit preserves retry-after and does not stop danmaku initialization', async () => {
  const item = harness();
  item.profileStatus = 429; item.profileRetryAfter = '90'; item.profilePayload = { code: -429 };
  await assert.rejects(item.service.profile('7', signal()), (error: unknown) =>
    !!error && typeof error === 'object' && 'retryAfter' in error && error.retryAfter === 90);
  await assert.rejects(item.service.profile('8', signal()), (error: unknown) =>
    !!error && typeof error === 'object' && 'retryAfter' in error && error.retryAfter === 90);
  assert.equal(item.network.length, 1, 'cooldown does not send another profile request');
  const bootstrap = await item.service.resolve(origin, { roomId: '1', mode: 'anonymous' }, signal());
  assert.equal(bootstrap.uid, '0');
  assert.equal(item.cookiesRead, 0);
});

test('invalidating a pending public lookup cannot refill the old identity cache', async () => {
  const item = harness();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  item.beforeProfile = async () => { entered(); await gate; };
  const pending = item.service.profile('7', signal());
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await started; item.service.invalidate(); release(); await rejected;
  item.beforeProfile = undefined;
  await item.service.profile('7', signal());
  assert.equal(item.network.length, 2);
});

test('the shared avatar LRU retains a recently used identity across many visible users', async () => {
  const item = harness();
  // Advance the request windows while remaining inside the successful avatar lifetime.
  item.profilePayload = { code: 0, data: { info: { uid: '1', uname: '公开用户', face: 'https://i0.hdslb.com/face.jpg' } } };
  await item.service.profile('1', signal());
  for (let uid = 2; uid <= PUBLIC_AVATAR_CACHE_LIMITS.entries; uid++) {
    item.now = 1_000_000 + Math.floor((uid - 1) / 20) * 60_001;
    item.profilePayload = { code: 0, data: { info: { uid: String(uid), uname: '公开用户', face: 'https://i0.hdslb.com/face.jpg' } } };
    await item.service.profile(String(uid), signal());
  }
  await item.service.profile('1', signal());
  const nextUid = String(PUBLIC_AVATAR_CACHE_LIMITS.entries + 1);
  item.profilePayload = { code: 0, data: { info: { uid: nextUid, uname: '公开用户', face: 'https://i0.hdslb.com/face.jpg' } } };
  await item.service.profile(nextUid, signal());
  await item.service.profile('1', signal());
  assert.equal(item.network.length, PUBLIC_AVATAR_CACHE_LIMITS.entries + 1, 'recent UID stays cached after capacity is reached');
  item.profilePayload = { code: 0, data: { info: { uid: '2', uname: '公开用户', face: 'https://i0.hdslb.com/face.jpg' } } };
  await item.service.profile('2', signal());
  assert.equal(item.network.length, PUBLIC_AVATAR_CACHE_LIMITS.entries + 2, 'oldest inactive UID is evicted');
});

test('repeated visible users share one public request and a worker restart restores only public avatar hints', async () => {
  const item = harness(true);
  item.profilePayload = { code: 0, data: { info: { uid: '7', uname: '不应持久化的昵称', face: 'https://i0.hdslb.com/bfs/face/fixture.jpg' } } };
  const replies = await Promise.all(Array.from({ length: 100 }, () => item.service.profile('7', signal())));
  assert.equal(replies.every(value => value.uid === '7'), true);
  assert.equal(item.network.length, 1, 'same UID is shared regardless of message or room count');
  // Storage writes are coalesced rather than running for each visible message.
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(JSON.stringify(item.stored[PUBLIC_AVATAR_CACHE_KEY]).includes('不应持久化的昵称'), false);
  const restored = item.instance();
  assert.deepEqual(await restored.profile('7', signal()), { uid: '7', face: 'https://i0.hdslb.com/bfs/face/fixture.jpg', avatarFetchedAt: 1_000_000, avatarCacheHit: true });
  assert.equal(item.network.length, 1, 'a recreated MV3 worker reuses the local hint without another upstream request');
  restored.invalidate();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual((item.stored[PUBLIC_AVATAR_CACHE_KEY] as { rows: unknown[] }).rows, []);
});

test('a directory outage offers no image permission and does not prevent ordinary text sending', async () => {
  const item = harness(), session = await item.connect(); item.directoryFailure = true;
  const context = await item.service.context(origin, { roomId: '1', authEpoch: session.account!.authEpoch }, signal());
  assert.deepEqual(context.emoticons, []);
  assert.equal((await item.service.send(origin, { roomId: '1', authEpoch: session.account!.authEpoch,
    operationId: 'operation-no-emotes', text: 'fixture' }, signal())).status, 'submitted');
  assert.equal(item.posts, 1);
});

test('legacy partial confirmation cannot transfer complete authorization to a replacement UID', async () => {
  const item = harness(), session = await item.connect(); item.uid = '43'; item.broker.invalidate();
  const switched = await item.sessions.update(origin, { revision: session.preferences.revision, playbackWanted: true, confirmUid: '43' });
  assert.equal(switched.playbackAllowed, false); assert.equal(switched.preferences.chatWanted, false); assert.equal(switched.chatAllowed, false);
  assert.equal(switched.danmakuAllowed, false);
});

test('an explicit upstream logout clears interaction intent, and login returning does not silently re-enable', async () => {
  const item = harness(), session = await item.connect(); item.sendPayload = { code: -101, message: '账号未登录' };
  item.beforePost = async () => { item.uid = undefined; };
  const result = await item.service.send(origin, { roomId: '1', authEpoch: session.account!.authEpoch,
    operationId: 'operation-expired', text: 'fixture' }, signal());
  assert.equal(result.status, 'rejected'); assert.equal(item.sessions.read(origin).chatWanted, false);
  item.uid = '42';
  assert.equal((await item.sessions.get(origin, undefined, true)).chatAllowed, false);
});


test('forced bootstrap refresh is bounded per room', async () => {
  const item = harness();
  await item.service.resolve(origin, { roomId: '1', mode: 'anonymous', force: true }, signal());
  await assert.rejects(item.service.resolve(origin, { roomId: '1', mode: 'anonymous', force: true }, signal()), /过于频繁/);
  item.now = 1_006_000;
  await item.service.resolve(origin, { roomId: '1', mode: 'anonymous', force: true }, signal());
});

test('a server refusal cannot persist a copy of its echoed submitted text', async () => {
  const item = harness(), session = await item.connect(); item.sendPayload = { code: 0, message: 'refused echoed-secret-text' };
  assert.equal((await item.service.send(origin, { roomId: '1', authEpoch: session.account!.authEpoch,
    operationId: 'operation-no-echo', text: 'echoed-secret-text' }, signal())).status, 'rejected');
  assert.equal(JSON.stringify(item.stored).includes('echoed-secret-text'), false);
});

test('send refusals preserve valid authorization and never repeat a POST during account confirmation', async () => {
  const item = harness(), session = await item.connect();
  const input = { roomId: '1', authEpoch: session.account!.authEpoch, operationId: 'operation-account-check', text: 'fixture' };
  item.sendPayload = { code: -101 };
  assert.equal((await item.service.send(origin, input, signal())).status, 'rejected');
  assert.equal((await item.sessions.get(origin)).chatAllowed, true);
  assert.equal(item.navRequests, 2, 'a real upstream rejection causes exactly one account confirmation');
  assert.equal((await item.service.send(origin, input, signal())).status, 'rejected');
  assert.equal(item.posts, 1); assert.equal(item.navRequests, 2);
  item.now = 1_002_000; item.sendPayload = { code: -111 };
  const csrfResult = await item.service.send(origin, { ...input, operationId: 'operation-csrf-rejected' }, signal());
  assert.equal(csrfResult.status, 'rejected'); assert.equal(item.navRequests, 2, 'CSRF rejection is not a logout');
  assert.equal((await item.sessions.get(origin)).chatAllowed, true); assert.equal(item.posts, 2);
});

test('a Cookie UID mismatch and CSRF rotation before dispatch each prevent a POST without clearing account intent', async () => {
  const changed = harness(), session = await changed.connect(); changed.uid = '43';
  assert.equal((await changed.service.send(origin, { roomId: '1', authEpoch: session.account!.authEpoch,
    operationId: 'operation-uid-changed', text: 'fixture' }, signal())).status, 'rejected');
  assert.equal(changed.posts, 0);

  const item = harness(), enabled = await item.connect();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  item.beforeRoom = async () => { entered(); await gate; };
  const pending = item.service.send(origin, { roomId: '1', authEpoch: enabled.account!.authEpoch,
    operationId: 'operation-csrf-rotation', text: 'fixture' }, signal());
  await started; item.transport.invalidateWrites(); release();
  assert.equal((await pending).status, 'rejected'); assert.equal(item.posts, 0);
  assert.equal((await item.sessions.get(origin)).chatAllowed, true);
});

test('CSRF rotation after dispatch makes the result unknown and never resends or revokes the account', async () => {
  const item = harness(), session = await item.connect();
  const input = { roomId: '1', authEpoch: session.account!.authEpoch, operationId: 'operation-csrf-inflight', text: 'fixture' };
  item.beforePost = async () => { item.transport.invalidateWrites(); };
  assert.equal((await item.service.send(origin, input, signal())).status, 'unknown');
  assert.equal((await item.service.send(origin, input, signal())).status, 'unknown');
  assert.equal(item.posts, 1); assert.equal((await item.sessions.get(origin)).chatAllowed, true);
});
