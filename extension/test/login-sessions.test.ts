import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BrokerError, LocalLoginBroker } from '../lib/broker';
import { LOGIN_PREFERENCES_KEY, LoginSessions } from '../lib/loginSessions';

const origin = 'https://bwatch.icu';
const local = 'http://127.0.0.1:8080';
const failureCode = (code: string) => (error: unknown) => error instanceof BrokerError && error.code === code;
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const playback = { code: 0, data: { live_status: 1, playurl_info: { playurl: { g_qn_desc: [{ qn: 250, desc: '超清' }],
  stream: [{ protocol_name: 'http_hls', format: [{ format_name: 'ts', codec: [{ codec_name: 'avc', current_qn: 250, accept_qn: [250],
    base_url: '/live/index.m3u8?', url_info: [{ host: 'https://cdn.bilivideo.com', extra: 'token=fixture' }] }] }] }] } } } };

function fixture(initial: Record<string, unknown> = {}) {
  let stored = structuredClone(initial), failWrite = false, offline = false, accountUid: string | undefined = '123';
  let requests = 0, navRequests = 0, delayedNav: (() => Promise<void>) | undefined;
  let playbackPayload: unknown = playback, navError: Error | undefined;
  const changes: Array<{ origin: string; revision: number; reason: string }> = [];
  const storage = { get: async () => structuredClone(stored), set: async (values: Record<string, unknown>) => {
    if (failWrite) throw new Error('storage unavailable');
    stored = { ...stored, ...structuredClone(values) };
  } };
  const newInstance = () => {
    const broker = new LocalLoginBroker({ fetch: (async url => {
      requests++;
      if (offline) throw new Error('offline');
      if (!String(url).includes('/nav')) return response(playbackPayload);
      navRequests++;
      if (navError) throw navError;
      const snapshot = accountUid;
      await delayedNav?.();
      return response(snapshot ? { code: 0, data: { isLogin: true, mid: snapshot, uname: `账号${snapshot}` } } : { code: -101, data: { isLogin: false } });
    }) as typeof fetch });
    const sessions = new LoginSessions({ broker, storage, allowedOrigin: value => [origin, local].includes(value),
      onChange: (origin, revision, reason) => changes.push({ origin, revision, reason }) });
    return { broker, sessions };
  };
  return { ...newInstance(), newInstance, changes, storage,
    get requests() { return requests; }, get navRequests() { return navRequests; }, get stored() { return structuredClone(stored); },
    get failWrite() { return failWrite; }, set failWrite(value: boolean) { failWrite = value; },
    get offline() { return offline; }, set offline(value: boolean) { offline = value; },
    get uid() { return accountUid; }, set uid(value: string | undefined) { accountUid = value; },
    get playbackPayload() { return playbackPayload; }, set playbackPayload(value: unknown) { playbackPayload = value; },
    get navError() { return navError; }, set navError(value: Error | undefined) { navError = value; },
    get delay() { return delayedNav; }, set delay(value: (() => Promise<void>) | undefined) { delayedNav = value; } };
}
async function connect(item: ReturnType<typeof fixture>, site = origin) {
  await item.sessions.grant(site, true);
  return item.sessions.update(site, { revision: item.sessions.read(site).revision, connectionWanted: true });
}
async function enable(item: ReturnType<typeof fixture>, site = origin) {
  await item.sessions.ready;
  return item.sessions.authorize(site, { revision: item.sessions.read(site).revision });
}

test('a grant or legacy migration never silently connects, reads an account or enables playback', async () => {
  const item = fixture({ bwatchMonitorAuthorizedOrigins: [origin, 'https://evil.test'] });
  await item.sessions.ready;
  const result = await item.sessions.get(origin, undefined, true);
  assert.equal(result.preferences.granted, true);
  assert.equal(result.preferences.connectionWanted, false);
  assert.equal(result.playbackAllowed, false);
  assert.equal(result.account, undefined);
  assert.equal(item.requests, 0);
  assert.equal(item.sessions.read(local).granted, false);
});

test('refresh, a new tab and a new worker restore intent only after verifying the bound UID', async () => {
  const item = fixture();
  const first = await enable(item);
  assert.equal(first.playbackAllowed, true);
  assert.equal(first.preferences.expectedUid, '123');
  const next = item.newInstance();
  await next.sessions.ready;
  assert.equal(item.navRequests, 1);
  const restored = await next.sessions.get(origin);
  assert.equal(restored.playbackAllowed, true);
  assert.equal(restored.account?.uid, '123');
  assert.notEqual(restored.account?.authEpoch, first.account?.authEpoch);
  assert.equal(item.navRequests, 2);
  const serialized = JSON.stringify(item.stored);
  for (const forbidden of ['authEpoch', 'SESSDATA', 'token=', 'verifiedAt', 'uname', 'logged-in']) assert.equal(serialized.includes(forbidden), false);
});

test('closing the switch preserves a verified connected account and survives refresh without reading NAV to save', async () => {
  const item = fixture();
  const active = await enable(item);
  item.offline = true;
  const calls = item.requests;
  const disabled = await item.sessions.update(origin, { revision: active.preferences.revision, playbackWanted: false });
  assert.equal(item.requests, calls);
  assert.equal(disabled.playbackAllowed, false);
  assert.equal(disabled.account?.uid, '123');
  assert.equal(disabled.preferences.connectionWanted, true);
  item.offline = false;
  const reloaded = await item.newInstance().sessions.get(origin);
  assert.equal(reloaded.playbackAllowed, false);
  assert.equal(reloaded.account?.uid, '123');
  assert.equal(item.changes.at(-1)?.reason, 'playback-disabled');
});

test('explicit upstream logout clears enabled intent and re-login does not re-enable it', async () => {
  const item = fixture();
  await enable(item);
  item.uid = undefined; item.broker.invalidate(); item.sessions.credentialsChanged(1);
  const loggedOut = await item.sessions.get(origin, undefined, true);
  assert.equal(loggedOut.reason, 'logged-out');
  assert.equal(loggedOut.preferences.playbackWanted, false);
  assert.equal(loggedOut.preferences.granted, true);
  item.uid = '123'; item.broker.invalidate(); item.sessions.credentialsChanged(1);
  const returned = await item.sessions.get(origin, undefined, true);
  assert.equal(returned.account?.uid, '123');
  assert.equal(returned.playbackAllowed, false);
  assert.equal((await item.newInstance().sessions.get(origin)).playbackAllowed, false);
});

test('account switching suspends old intent until the newly verified UID is explicitly confirmed', async () => {
  const item = fixture();
  const active = await enable(item);
  item.uid = '456'; item.broker.invalidate(); item.sessions.credentialsChanged(1);
  const switched = await item.sessions.get(origin, undefined, true);
  assert.equal(switched.reason, 'account-changed');
  assert.equal(switched.preferences.expectedUid, '123');
  assert.equal(switched.preferences.playbackWanted, false);
  assert.equal(switched.playbackAllowed, false);
  await assert.rejects(item.sessions.update(origin, { revision: switched.preferences.revision, playbackWanted: true, confirmUid: '123' }), failureCode('ACCOUNT_CHANGED'));
  await assert.rejects(item.sessions.update(origin, { revision: active.preferences.revision, playbackWanted: true, confirmUid: '456' }), failureCode('STATE_CONFLICT'));
  const confirmed = await item.sessions.authorize(origin, { revision: switched.preferences.revision, uid: '456', authEpoch: switched.account!.authEpoch });
  assert.equal(confirmed.playbackAllowed, true);
  assert.equal(confirmed.preferences.expectedUid, '456');
});

test('the connected account is bound even while using anonymous playback', async () => {
  const item = fixture();
  const connected = await connect(item);
  assert.equal(connected.preferences.expectedUid, '123');
  item.uid = '456'; item.broker.invalidate();
  assert.equal((await item.sessions.get(origin, undefined, true)).reason, 'account-changed');
});

test('normal same-UID cookie rotation invalidates old RPC epochs without losing the enabled choice', async () => {
  const item = fixture();
  const active = await enable(item);
  item.broker.invalidate(); item.sessions.credentialsChanged(1);
  const refreshed = await item.sessions.get(origin, undefined, true);
  assert.equal(refreshed.playbackAllowed, true);
  assert.equal(refreshed.preferences.revision, active.preferences.revision);
  assert.notEqual(refreshed.account!.authEpoch, active.account!.authEpoch);
  await assert.rejects(item.sessions.resolve(origin, { roomId: '1', qn: 250, authEpoch: active.account!.authEpoch }, new AbortController().signal), failureCode('ACCOUNT_CHANGED'));
});

test('a temporary network failure preserves intent but supplies no new login evidence', async () => {
  const item = fixture();
  const active = await enable(item);
  item.offline = true; item.broker.invalidate();
  await assert.rejects(item.sessions.get(origin, undefined, true), failureCode('UNAVAILABLE'));
  assert.deepEqual(item.sessions.read(origin), active.preferences);
  item.offline = false;
  assert.equal((await item.sessions.get(origin, undefined, true)).playbackAllowed, true);
});

test('revocation is origin-scoped, persists a tombstone and blocks legacy/direct playback', async () => {
  const item = fixture();
  const active = await enable(item);
  await enable(item, local);
  const localRevision = item.sessions.read(local).revision;
  await item.sessions.grant(origin, false);
  assert.equal((await item.sessions.get(origin)).reason, 'unauthorized');
  assert.equal(item.sessions.read(origin).expectedUid, undefined);
  assert.equal(item.sessions.read(local).revision, localRevision);
  assert.equal((await item.sessions.get(local)).playbackAllowed, true);
  await assert.rejects(item.sessions.resolve(origin, { roomId: '1', qn: 250, authEpoch: active.account!.authEpoch }, new AbortController().signal), failureCode('UNAUTHORIZED'));
  await assert.rejects(item.sessions.update(origin, { revision: active.preferences.revision, connectionWanted: true }), failureCode('STATE_CONFLICT'));
  assert.equal((await item.newInstance().sessions.get(origin)).preferences.granted, false);
});

test('parallel tab changes use CAS; a delayed enable cannot overwrite a successful disable', async () => {
  const item = fixture();
  const active = await enable(item);
  let release!: () => void;
  item.delay = () => new Promise<void>(resolve => { release = resolve; });
  const lateEnable = item.sessions.update(origin, { revision: active.preferences.revision, playbackWanted: true, confirmUid: '123' });
  while (!release) await new Promise(resolve => setTimeout(resolve, 1));
  const disabled = await item.sessions.update(origin, { revision: active.preferences.revision, playbackWanted: false });
  release();
  await assert.rejects(lateEnable, failureCode('STATE_CONFLICT'));
  assert.equal(item.sessions.read(origin).playbackWanted, false);
  assert.equal(disabled.preferences.revision, active.preferences.revision + 1);
});

test('a delayed NAV cannot revive an origin revoked while verification was pending', async () => {
  const item = fixture();
  const connected = await connect(item);
  let release!: () => void;
  item.delay = () => new Promise<void>(resolve => { release = resolve; });
  const checking = item.sessions.get(origin, undefined, true);
  while (!release) await new Promise(resolve => setTimeout(resolve, 1));
  await item.sessions.grant(origin, false);
  release();
  await assert.rejects(checking, failureCode('UNAUTHORIZED'));
  assert.equal(item.sessions.read(origin).playbackWanted, false);
  assert.ok(item.sessions.read(origin).revision > connected.preferences.revision);
});

test('an identity event between NAV and a confirmation prevents stale UID binding', async () => {
  const item = fixture();
  const connected = await connect(item);
  let release!: () => void;
  item.delay = () => new Promise<void>(resolve => { release = resolve; });
  const enabling = item.sessions.authorize(origin, { revision: connected.preferences.revision, uid: '123' });
  while (!release) await new Promise(resolve => setTimeout(resolve, 1));
  item.broker.invalidate(); item.sessions.credentialsChanged(1); release();
  await assert.rejects(enabling);
  assert.equal(item.sessions.read(origin).playbackWanted, false);
});

test('failed storage writes fail closed and another origin cannot persist the failed enable', async () => {
  const item = fixture();
  const connected = await connect(item);
  item.failWrite = true;
  await assert.rejects(item.sessions.update(origin, { revision: connected.preferences.revision, playbackWanted: true, confirmUid: '123' }), failureCode('UNAVAILABLE'));
  assert.equal(item.sessions.read(origin).playbackWanted, false);
  await assert.rejects(item.sessions.get(origin), failureCode('UNAVAILABLE'));
  item.failWrite = false;
  await item.sessions.grant(local, true);
  const restored = await item.newInstance().sessions.get(origin);
  assert.equal(restored.playbackAllowed, false);
  assert.equal(restored.preferences.playbackWanted, false);
});

test('cookie invalidation during a disk write cannot return a stale verified playback permission', async () => {
  const item = fixture();
  const connected = await connect(item);
  const write = item.storage.set;
  let release!: () => void;
  item.storage.set = async values => { await new Promise<void>(resolve => { release = resolve; }); await write(values); };
  const enabling = item.sessions.authorize(origin, { revision: connected.preferences.revision, uid: '123' });
  while (!release) await new Promise(resolve => setTimeout(resolve, 1));
  item.broker.invalidate(); item.sessions.credentialsChanged(1); release();
  const result = await enabling;
  assert.equal(result.playbackAllowed, false);
  assert.equal(result.account, undefined);
  assert.equal(result.verifiedAt, undefined);
  assert.equal(result.reason, 'unverified');
  item.storage.set = write;
  assert.equal((await item.sessions.get(origin, undefined, true)).playbackAllowed, true);
});

test('failed disable and revoke stop personal work in the current worker and never report success', async () => {
  const item = fixture();
  const active = await enable(item);
  item.failWrite = true;
  await assert.rejects(item.sessions.update(origin, { revision: active.preferences.revision, playbackWanted: false }), failureCode('UNAVAILABLE'));
  assert.equal(item.sessions.read(origin).playbackWanted, false);
  await assert.rejects(item.sessions.resolve(origin, { roomId: '1', qn: 250, authEpoch: active.account!.authEpoch }, new AbortController().signal), failureCode('UNAVAILABLE'));
  await assert.rejects(item.sessions.grant(origin, false), failureCode('UNAVAILABLE'));
  assert.equal(item.sessions.read(origin).granted, false);
  assert.equal(item.broker.isAuthorized(origin), false);
});

test('GET_SESSION retries a failed disable by saving only the safe anonymous choice without changing CAS revision', async () => {
  const item = fixture();
  const active = await enable(item);
  item.failWrite = true;
  await assert.rejects(item.sessions.update(origin, { revision: active.preferences.revision, playbackWanted: false }), failureCode('UNAVAILABLE'));
  const safe = item.sessions.read(origin);
  await assert.rejects(item.sessions.get(origin), failureCode('UNAVAILABLE'));
  item.failWrite = false;
  const [recovered, parallel] = await Promise.all([item.sessions.get(origin), item.sessions.get(origin)]);
  for (const session of [recovered, parallel]) {
    assert.equal(session.playbackAllowed, false);
    assert.equal(session.preferences.playbackWanted, false);
    assert.equal(session.preferences.connectionWanted, true);
    assert.equal(session.preferences.revision, safe.revision);
  }
  assert.equal((await item.newInstance().sessions.get(origin)).playbackAllowed, false);
  assert.equal(item.changes.at(-1)?.reason, 'playback-disabled');
});

test('GET_SESSION persists a failed revoke before the unauthorized fast path and does not resurrect the grant', async () => {
  const item = fixture();
  await enable(item);
  item.failWrite = true;
  await assert.rejects(item.sessions.grant(origin, false), failureCode('UNAVAILABLE'));
  const safe = item.sessions.read(origin);
  await assert.rejects(item.sessions.get(origin), failureCode('UNAVAILABLE'));
  item.failWrite = false;
  const recovered = await item.sessions.get(origin);
  assert.equal(recovered.reason, 'unauthorized');
  assert.equal(recovered.playbackAllowed, false);
  assert.equal(recovered.preferences.revision, safe.revision);
  assert.equal(item.broker.isAuthorized(origin), false);
  const restored = await item.newInstance().sessions.get(origin);
  assert.equal(restored.preferences.granted, false);
  assert.equal(restored.preferences.connectionWanted, false);
  assert.equal(restored.preferences.playbackWanted, false);
  assert.equal(restored.preferences.expectedUid, undefined);
  assert.equal(item.changes.at(-1)?.reason, 'revoked');
});

test('a failed enable converges through GET_SESSION to anonymous state and is never retried as an enable', async () => {
  const item = fixture();
  const connected = await connect(item);
  item.failWrite = true;
  await assert.rejects(item.sessions.update(origin, { revision: connected.preferences.revision, playbackWanted: true, confirmUid: '123' }), failureCode('UNAVAILABLE'));
  const safe = item.sessions.read(origin);
  item.failWrite = false;
  const recovered = await item.sessions.get(origin);
  assert.equal(recovered.playbackAllowed, false);
  assert.equal(recovered.preferences.playbackWanted, false);
  assert.equal(recovered.preferences.revision, safe.revision);
  assert.equal((await item.newInstance().sessions.get(origin)).playbackAllowed, false);
});

test('permission removal clears all saved authorization and intent across worker restart', async () => {
  const item = fixture();
  await enable(item); await enable(item, local);
  await item.sessions.revokeAll();
  const restored = item.newInstance();
  for (const site of [origin, local]) {
    const session = await restored.sessions.get(site);
    assert.equal(session.preferences.granted, false);
    assert.equal(session.preferences.connectionWanted, false);
    assert.equal(session.preferences.playbackWanted, false);
    assert.equal(session.preferences.expectedUid, undefined);
  }
});

test('the playback gate cannot be bypassed using a valid epoch from a connected anonymous account', async () => {
  const item = fixture();
  const connected = await connect(item);
  const requests = item.requests;
  await assert.rejects(item.sessions.resolve(origin, { roomId: '1', qn: 250, authEpoch: connected.account!.authEpoch }, new AbortController().signal), failureCode('ACCOUNT_CHANGED'));
  assert.equal(item.requests, requests);
});

test('retrying an old disconnect cannot revoke a later grant after an acknowledgement was lost', async () => {
  const item = fixture();
  const active = await enable(item);
  await item.sessions.grant(origin, false, 'revoked', active.preferences.revision);
  await item.sessions.grant(origin, true);
  const revision = item.sessions.read(origin).revision;
  await assert.rejects(item.sessions.grant(origin, false, 'revoked', active.preferences.revision), failureCode('STATE_CONFLICT'));
  assert.equal(item.sessions.read(origin).granted, true);
  assert.equal(item.sessions.read(origin).revision, revision);
  assert.equal(item.broker.isAuthorized(origin), true);
});

test('corrupt storage cannot forge a verified session, enable without a binding or grant an arbitrary origin', async () => {
  const item = fixture({ [LOGIN_PREFERENCES_KEY]: { schemaVersion: 1, origins: {
    [origin]: { schemaVersion: 1, revision: 4, granted: true, connectionWanted: true, playbackWanted: true, account: { uid: '123' }, authEpoch: 'forged' },
    'https://evil.test': { schemaVersion: 1, revision: 1, granted: true, connectionWanted: true, playbackWanted: true, expectedUid: '123' }
  } } });
  const result = await item.sessions.get(origin);
  assert.equal(result.playbackAllowed, false);
  assert.equal(result.preferences.playbackWanted, false);
  assert.notEqual(result.account?.authEpoch, 'forged');
  await assert.rejects(item.sessions.get('https://evil.test'), failureCode('UNAUTHORIZED'));
});

test('complete authorization atomically persists v2 and all capabilities only after trusted verification', async () => {
  const item = fixture(); await item.sessions.ready;
  assert.equal(item.navRequests, 0);
  const initial = await item.sessions.get(origin);
  assert.equal(initial.preferences.granted, false); assert.equal(item.navRequests, 0);
  const allowed = await item.sessions.authorize(origin, { revision: initial.preferences.revision });
  assert.equal(allowed.preferences.authorizationVersion, 2);
  assert.equal(allowed.preferences.granted, true); assert.equal(allowed.preferences.connectionWanted, true);
  assert.equal(allowed.preferences.playbackWanted, true); assert.equal(allowed.preferences.chatWanted, true);
  assert.equal(allowed.playbackAllowed, true); assert.equal(allowed.danmakuAllowed, true); assert.equal(allowed.chatAllowed, true);
  assert.equal(allowed.preferences.expectedUid, '123');
});

test('restoring a pre-v2 partial authorization never silently expands it to complete account access', async () => {
  const item = fixture({ bwatchMonitorLoginPreferences: { schemaVersion: 1, origins: { [origin]: {
    schemaVersion: 1, revision: 5, granted: true, connectionWanted: true, playbackWanted: true, chatWanted: true, expectedUid: '123'
  } } } });
  const legacy = await item.sessions.get(origin);
  assert.equal(legacy.preferences.authorizationVersion, undefined);
  assert.equal(legacy.playbackAllowed, false); assert.equal(legacy.chatAllowed, false); assert.equal(legacy.danmakuAllowed, false);
  await assert.rejects(item.sessions.requireChat(origin, legacy.account!.authEpoch), failureCode('UNAUTHORIZED'));
  await assert.rejects(item.sessions.requireDanmaku(origin, legacy.account!.authEpoch), failureCode('UNAUTHORIZED'));
  const upgraded = await item.sessions.authorize(origin, { revision: legacy.preferences.revision, uid: '123', authEpoch: legacy.account!.authEpoch });
  assert.equal(upgraded.playbackAllowed, true); assert.equal(upgraded.chatAllowed, true); assert.equal(upgraded.danmakuAllowed, true);
});

test('a failed or cancelled first complete authorization leaves no usable website permission', async () => {
  for (const mode of ['offline', 'logged-out', 'cancelled'] as const) {
    const item = fixture(); await item.sessions.ready;
    if (mode === 'offline') item.offline = true;
    if (mode === 'logged-out') item.uid = undefined;
    const controller = new AbortController(); if (mode === 'cancelled') controller.abort();
    await assert.rejects(item.sessions.authorize(origin, { revision: 0 }, controller.signal));
    assert.equal(item.sessions.read(origin).granted, false, mode);
    assert.equal(item.sessions.read(origin).authorizationVersion, undefined, mode);
    assert.equal(item.broker.isAuthorized(origin), false, mode);
  }
});

test('a complete confirmation cannot approve another UID or stale permission revision', async () => {
  const item = fixture(), first = await enable(item);
  item.uid = '456'; item.broker.invalidate();
  await assert.rejects(item.sessions.authorize(origin, { revision: first.preferences.revision, uid: '123' }), failureCode('ACCOUNT_CHANGED'));
  const changed = await item.sessions.get(origin, undefined, true);
  assert.equal(changed.playbackAllowed, false); assert.equal(changed.danmakuAllowed, false); assert.equal(changed.chatAllowed, false);
  await assert.rejects(item.sessions.authorize(origin, { revision: first.preferences.revision, uid: '456' }), failureCode('STATE_CONFLICT'));
});

test('logout removes complete account binding so even the same UID returning must reauthorize', async () => {
  const item = fixture(); await enable(item);
  item.uid = undefined; item.broker.invalidate();
  const out = await item.sessions.get(origin, undefined, true);
  assert.equal(out.preferences.expectedUid, undefined);
  item.uid = '123'; item.broker.invalidate();
  const back = await item.sessions.get(origin, undefined, true);
  assert.equal(back.preferences.expectedUid, undefined);
  assert.equal(back.playbackAllowed, false); assert.equal(back.danmakuAllowed, false); assert.equal(back.chatAllowed, false);
});

test('a delayed complete authorization cannot override a more recent explicit revocation', async () => {
  const item = fixture(); await item.sessions.ready;
  let resume!: () => void;
  item.delay = () => new Promise<void>(resolve => { resume = resolve; });
  const pending = item.sessions.authorize(origin, { revision: 0 });
  while (!resume) await new Promise(resolve => setTimeout(resolve, 1));
  await item.sessions.grant(origin, false); resume();
  await assert.rejects(pending);
  assert.equal(item.sessions.read(origin).granted, false);
  assert.equal((await item.sessions.get(origin)).playbackAllowed, false);
});

test('parallel complete authorizations use CAS so only one submitted choice is committed', async () => {
  const item = fixture(); await item.sessions.ready;
  const results = await Promise.allSettled([item.sessions.authorize(origin, { revision: 0 }), item.sessions.authorize(origin, { revision: 0 })]);
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(item.sessions.read(origin).revision, 1);
  assert.equal(item.sessions.read(origin).authorizationVersion, 2);
});

test('complete authorization storage failure never persists a later implicit retry as approval', async () => {
  const item = fixture(); await item.sessions.ready; item.failWrite = true;
  await assert.rejects(item.sessions.authorize(origin, { revision: 0 }), failureCode('UNAVAILABLE'));
  assert.equal(item.sessions.read(origin).granted, false);
  item.failWrite = false;
  const safe = await item.sessions.get(origin);
  assert.equal(safe.preferences.authorizationVersion, undefined);
  assert.equal(safe.playbackAllowed, false); assert.equal(safe.danmakuAllowed, false); assert.equal(safe.chatAllowed, false);
});

test('source-tab navigation during delayed account verification prevents popup authorization', async () => {
  const item = fixture(); await item.sessions.ready;
  let resume!: () => void, documentCurrent = true;
  item.delay = () => new Promise<void>(resolve => { resume = resolve; });
  const pending = item.sessions.authorize(origin, { revision: 0 }, undefined, async () => documentCurrent);
  while (!resume) await new Promise(resolve => setTimeout(resolve, 1));
  documentCurrent = false; resume();
  await assert.rejects(pending);
  assert.equal(item.sessions.read(origin).granted, false); assert.equal(item.broker.isAuthorized(origin), false);
});

test('source-tab navigation during the authorization disk write safely converges before queued requests continue', async () => {
  const item = fixture(); await item.sessions.ready;
  const write = item.storage.set;
  let release!: () => void, firstWrite = true, documentCurrent = true;
  item.storage.set = async values => {
    if (firstWrite) { firstWrite = false; await new Promise<void>(resolve => { release = resolve; }); }
    await write(values);
  };
  const pending = item.sessions.authorize(origin, { revision: 0 }, undefined, async () => documentCurrent);
  while (!release) await new Promise(resolve => setTimeout(resolve, 1));
  documentCurrent = false; release();
  await assert.rejects(pending);
  const safe = await item.sessions.get(origin);
  assert.equal(safe.preferences.granted, false); assert.equal(safe.playbackAllowed, false); assert.equal(safe.chatAllowed, false);
  assert.equal((await item.newInstance().sessions.get(origin)).preferences.granted, false);
});

test('business authentication refusals merge one NAV confirmation and preserve a still-valid same-UID authorization', async () => {
  const item = fixture(), session = await enable(item);
  item.playbackPayload = { code: -101 };
  item.delay = () => new Promise(resolve => setTimeout(resolve, 5));
  await Promise.all(['1', '2'].map(roomId => assert.rejects(item.sessions.resolve(origin,
    { roomId, qn: 250, authEpoch: session.account!.authEpoch }, new AbortController().signal), failureCode('UNAVAILABLE'))));
  assert.equal(item.navRequests, 2, 'one initial authorization plus one merged rejection confirmation');
  const current = await item.sessions.get(origin);
  assert.equal(current.chatAllowed, true); assert.equal(current.playbackAllowed, true); assert.equal(current.danmakuAllowed, true);
  assert.equal(item.navRequests, 2, 'quiet page synchronization reuses the completed verification');
});

test('a failed business verification keeps intent while NAV-confirmed logout and account switches clear it', async () => {
  const item = fixture(), session = await enable(item);
  item.playbackPayload = { code: -101 }; item.navError = new TypeError('offline');
  await assert.rejects(item.sessions.resolve(origin, { roomId: '1', qn: 250, authEpoch: session.account!.authEpoch }, new AbortController().signal), failureCode('UNAVAILABLE'));
  assert.equal((await item.sessions.get(origin)).chatAllowed, true);
  assert.equal(item.sessions.read(origin).playbackWanted, true);
  item.navError = undefined; item.uid = undefined;
  await assert.rejects(item.sessions.resolve(origin, { roomId: '2', qn: 250, authEpoch: session.account!.authEpoch }, new AbortController().signal), failureCode('UNAVAILABLE'));
  assert.equal(item.sessions.read(origin).playbackWanted, false); assert.equal(item.sessions.read(origin).chatWanted, false);
  assert.equal(item.sessions.read(origin).expectedUid, undefined);
  item.uid = '123';
  assert.equal((await item.sessions.get(origin, undefined, true)).chatAllowed, false);

  const switched = fixture(), first = await enable(switched);
  switched.uid = '456'; switched.playbackPayload = { code: -101 };
  await assert.rejects(switched.sessions.resolve(origin, { roomId: '1', qn: 250, authEpoch: first.account!.authEpoch }, new AbortController().signal), failureCode('UNAVAILABLE'));
  assert.equal(switched.sessions.read(origin).chatWanted, false);
  assert.equal((await switched.sessions.get(origin)).reason, 'account-changed');
});
