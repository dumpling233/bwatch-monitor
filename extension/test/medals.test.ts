import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BrokerError, LocalLoginBroker } from '../lib/broker';
import { LocalCookieTransport } from '../lib/cookieTransport';
import { LoginSessions } from '../lib/loginSessions';
import { LocalMedalService, MEDAL_CURRENT_API, MEDAL_PANEL_API, MEDAL_TAKE_OFF_API, MEDAL_WEAR_API, projectCurrentMedal, projectMedalItems, projectRoomMedalItems, type MedalDiagnostic } from '../lib/medals';
import type { LocalMedalSelection } from '../../shared/localMedals';

const origin = 'https://bwatch.icu';
const signal = () => new AbortController().signal;
const cookie = (name: string, value: string) => ({ name, value, domain: '.bilibili.com', path: '/', session: true,
  storeId: '0', secure: true, httpOnly: true, hostOnly: false, sameSite: 'lax' }) as chrome.cookies.Cookie;
const medal = (medalId = 101, targetUid = 777, name = '粉丝牌') => ({
  medal: { medal_id: medalId, target_id: targetUid, medal_name: name, level: 21, is_lighted: 1, medal_color: 3381759, wearing_status: 0 },
  room_info: { room_id: targetUid + 1000 }, anchor_info: { uid: targetUid, nick_name: '牌子主播' },
  uinfo_medal: { ruid: targetUid, name, level: 21, is_light: 1, guard_level: 3,
    v2_medal_color_start: '#33AAFF', v2_medal_color_end: '#2255CC', v2_medal_color_border: '#2277CC', v2_medal_color_text: 'rgba(20,30,40,0.9)', v2_medal_color_level: '#FFFFFF' }
});
const current = (targetUid = 777, name = '粉丝牌') => ({ code: 0, data: { curr_show: { ruid: targetUid, name, level: 21, is_light: 1,
  guard_level: 3, v2_medal_color_start: '#33AAFF', v2_medal_color_end: '#2255CC', v2_medal_color_border: '#2277CC' } } });

function harness() {
  let stored: Record<string, unknown> = {}, now = 1_800_000_000_000, cookieUid = '42', navCalls = 0, cookieReads = 0;
  let cookieFailure: Error | undefined, ruleFailure: Error | undefined, csrfAvailable = true;
  let service: LocalMedalService, wearing: unknown = current(888, '房间牌');
  let override: ((url: URL, init?: RequestInit) => Promise<Response> | Response | undefined) | undefined;
  const rules = new Map<number, chrome.declarativeNetRequest.Rule>();
  const network: Array<{ url: URL; init?: RequestInit; cookie: string }> = [], events: LocalMedalSelection[] = [], diagnostics: MedalDiagnostic[] = [];
  const transport = new LocalCookieTransport({ extensionId: 'testextension', now: () => now,
    getCookies: async () => { cookieReads++; if (cookieFailure) throw cookieFailure; return [cookie('SESSDATA', 'fixture-session'), cookie('DedeUserID', cookieUid), ...(csrfAvailable ? [cookie('bili_jct', 'fixture-csrf')] : [])]; },
    updateRules: async value => { if (value.addRules?.length && ruleFailure) throw ruleFailure;
      for (const id of value.removeRuleIds ?? []) rules.delete(id); for (const rule of value.addRules ?? []) rules.set(rule.id, rule); } });
  const broker = new LocalLoginBroker({ now: () => now, fetch: (async () => {
    navCalls++; return new Response(JSON.stringify({ code: 0, data: { mid: '42', isLogin: true, uname: 'fixture' } }));
  }) as typeof fetch });
  const sessions = new LoginSessions({ broker, storage: { get: async () => structuredClone(stored), set: async value => { stored = { ...stored, ...structuredClone(value) }; } },
    allowedOrigin: value => value === origin, now: () => now,
    onChange: (_origin, _revision, reason) => { if (['revoked', 'logged-out', 'account-changed', 'permission-removed'].includes(reason)) service?.invalidate(); } });
  service = new LocalMedalService({ transport, sessions, now: () => now, onChange: event => events.push(event), onDiagnostic: diagnostic => diagnostics.push(diagnostic), fetch: (async (input, init) => {
    const url = new URL(String(input)), active = [...rules.values()].filter(rule => rule.condition.regexFilter && new RegExp(rule.condition.regexFilter).test(url.href));
    assert.equal(active.length, 1);
    network.push({ url, init, cookie: active[0].action.requestHeaders?.find(header => header.header === 'Cookie')?.value ?? '' });
    const supplied = await override?.(url, init); if (supplied) return supplied;
    if (url.pathname.endsWith('/room_init')) return new Response(JSON.stringify({ code: 0, data: { uid: 888, room_id: 1001, short_id: 1 } }));
    if (url.href.startsWith(MEDAL_PANEL_API)) return new Response(JSON.stringify({ code: 0, data: { total_number: 1, list: [medal()], special_list: [], page_info: { current_page: 1, total_page: 1 } } }));
    if (url.href.startsWith(MEDAL_CURRENT_API)) return new Response(JSON.stringify(wearing));
    if (url.href === MEDAL_WEAR_API) { wearing = current(); return new Response(JSON.stringify({ code: 0 })); }
    if (url.href === MEDAL_TAKE_OFF_API) { wearing = { code: 0, data: { curr_show: null } }; return new Response(JSON.stringify({ code: 0 })); }
    throw new Error('unexpected endpoint');
  }) as typeof fetch });
  return { service, transport, sessions, network, rules, events, diagnostics,
    connect: async () => { await sessions.ready; return sessions.authorize(origin, { revision: sessions.read(origin).revision }); },
    get cookieReads() { return cookieReads; }, get navCalls() { return navCalls; }, get stored() { return stored; },
    set cookieUid(value: string) { cookieUid = value; }, set wearing(value: unknown) { wearing = value; },
    set cookieFailure(value: Error | undefined) { cookieFailure = value; }, set ruleFailure(value: Error | undefined) { ruleFailure = value; },
    set csrfAvailable(value: boolean) { csrfAvailable = value; },
    set override(value: typeof override) { override = value; }, set now(value: number) { now = value; } };
}

test('medal reads use the account-center directory while current display retains room context without persistence or automatic wear', async () => {
  const h = harness(), session = await h.connect(), stored = structuredClone(h.stored), authEpoch = session.account!.authEpoch;
  assert.equal(h.network.length, 0);
  const page = await h.service.page(origin, { roomId: '1001', page: 1, authEpoch }, signal());
  assert.equal(page.items.length, 1); assert.equal(page.wearing?.targetUid, '888'); assert.equal(page.wearing?.id, undefined);
  assert.equal(page.items[0].id, '101'); assert.equal(page.items[0].colorStart, '#33aaff'); assert.equal(page.hasMore, false);
  assert.equal(page.totalPages, 1);
  assert.equal(page.items[0].colorText, '#141e28'); assert.equal(page.items[0].colorLevel, '#ffffff');
  assert.equal(page.selectedMedalId, null); assert.equal(page.displayConfirmed, true);
  assert.equal(page.selectionPageComplete, true);
  assert.equal(h.network[0].url.href, 'https://api.live.bilibili.com/room/v1/Room/room_init?id=1001');
  assert.equal(h.network[0].cookie, '');
  assert.equal(h.network[1].url.href, `${MEDAL_PANEL_API}?page=1&page_size=10`);
  assert.equal(h.network[2].url.href, `${MEDAL_CURRENT_API}?uid=42&up_uid=888`);
  assert.ok(h.network.slice(1).every(value => /DedeUserID=42/.test(value.cookie)));
  assert.ok(h.network.every(value => value.init?.method === 'GET' && value.init.credentials === 'omit' && value.init.redirect === 'error'));
  assert.ok(h.network.every(value => value.init?.cache === 'no-store'));
  assert.equal(h.rules.size, 0); assert.equal(h.events.length, 0); assert.equal(h.navCalls, 1);
  assert.deepEqual(h.stored, stored); assert.equal(JSON.stringify(page).includes('fixture-'), false);
});

test('panel merges special entries, deduplicates IDs and current display never invents a writable medal ID', () => {
  const result = projectMedalItems({ data: { total_number: 2, list: [medal(), medal(102, 778, '其他牌')], special_list: [medal()] } });
  assert.deepEqual(result.items.map(row => row.id), ['101', '102']);
  assert.equal(projectCurrentMedal(current(), [])?.id, undefined);
  assert.equal(projectCurrentMedal(current(), result.items)?.id, '101');
  assert.equal(projectCurrentMedal({ data: { curr_show: { name: '', level: 0, ruid: '0' } } }, []) , null);
  assert.throws(() => projectCurrentMedal({ data: {} }, []), /当前佩戴/);
  const poisoned = medal(); poisoned.uinfo_medal.v2_medal_color_start = 'url(https://evil.test)';
  const safe = projectMedalItems({ data: { list: [poisoned] } });
  assert.equal(safe.items[0].colorStart, undefined);
  assert.throws(() => projectMedalItems({ data: { list: Array.from({ length: 11 }, () => medal()) } }), /粉丝勋章/);
});

test('room recommendations keep official special-then-normal order without a ten-medal UI cutoff or global proof', () => {
  const worn = medal(301, 999, '已佩戴'); worn.medal.wearing_status = 1;
  const ownRoom = medal(302, 888, '本房间');
  const normal = Array.from({ length: 10 }, (_, index) => medal(101 + index, 777 + index));
  const items = projectRoomMedalItems({ data: { special_list: [worn, ownRoom], list: normal,
    total_number: 0, page_info: { current_page: 'not-account-pagination', total_page: 0 } } });
  assert.equal(items.length, 12);
  assert.deepEqual(items.slice(0, 3).map(row => row.id), ['301', '302', '101']);
  assert.ok(items.every(row => !Object.hasOwn(row, 'wearing_status')));
  assert.deepEqual(projectRoomMedalItems({ data: { special_list: [ownRoom], list: [ownRoom, worn] } }).map(row => row.id), ['302', '301']);
  assert.deepEqual(projectRoomMedalItems({ data: { special_list: [], list: [] } }), []);
  assert.throws(() => projectRoomMedalItems({ data: { list: Array.from({ length: 11 }, () => medal()) } }), /粉丝勋章/);
});

test('room-panel RPC resolves trusted room context, returns only ordering data and makes the owned IDs usable by the existing SET', async () => {
  const h = harness(), session = await h.connect(), authEpoch = session.account!.authEpoch;
  const worn = medal(301, 999, '已佩戴'); worn.medal.wearing_status = 1;
  h.override = url => url.href.startsWith(MEDAL_PANEL_API) ? new Response(JSON.stringify({ code: 0, data: {
    special_list: [worn, medal(302, 888, '本房间')], list: [medal()], total_number: 1, page_info: { current_page: 1, total_page: 1 }
  } })) : undefined;
  const context = await h.service.roomContext(origin, { roomId: '1', authEpoch }, signal());
  assert.deepEqual(Object.keys(context).sort(), ['accountUid', 'authEpoch', 'roomId', 'targetUid', 'items', 'resolvedAt'].sort());
  assert.equal(context.accountUid, '42'); assert.equal(context.roomId, '1'); assert.equal(context.targetUid, '888');
  assert.deepEqual(context.items.map(item => item.id), ['301', '302', '101']);
  assert.equal(h.network.length, 2);
  assert.equal(h.network[0].url.href, 'https://api.live.bilibili.com/room/v1/Room/room_init?id=1');
  assert.equal(h.network[1].url.href, `${MEDAL_PANEL_API}?page=1&page_size=10&room_id=1001&target_id=888`);
  assert.match(h.network[1].cookie, /DedeUserID=42/);
  assert.equal(h.network[1].init?.method, 'GET'); assert.equal(h.network[1].init?.cache, 'no-store');
  assert.equal(h.events.length, 0); assert.equal(h.network.some(row => row.url.href.startsWith(MEDAL_CURRENT_API)), false);
  const result = await h.service.set(origin, { roomId: '1', authEpoch, medalId: '302' }, signal());
  assert.equal(result.status, 'applied'); assert.equal(result.selectedMedalId, '302');
  const post = h.network.find(row => row.init?.method === 'POST')!;
  assert.equal((post.init?.body as URLSearchParams).get('medal_id'), '302');
  assert.equal((post.init?.body as URLSearchParams).get('target_id'), '888');
  assert.equal(h.network.filter(row => row.init?.method === 'POST').length, 1);
});

test('each actual room-panel RPC reads fresh ordering while only the trusted room lookup is reused', async () => {
  const h = harness(), session = await h.connect(), authEpoch = session.account!.authEpoch;
  let panelCalls = 0;
  h.override = url => url.href.startsWith(MEDAL_PANEL_API) ? new Response(JSON.stringify({ code: 0, data: {
    special_list: [], list: [medal(++panelCalls === 1 ? 101 : 102)]
  } })) : undefined;
  const first = await h.service.roomContext(origin, { roomId: '1001', authEpoch }, signal());
  const next = await h.service.roomContext(origin, { roomId: '1001', authEpoch }, signal());
  assert.equal(first.items[0].id, '101'); assert.equal(next.items[0].id, '102');
  assert.equal(panelCalls, 2); assert.equal(h.network.filter(row => row.url.pathname.endsWith('/room_init')).length, 1);
  assert.equal(h.events.length, 0); assert.equal(h.network.some(row => row.init?.method === 'POST'), false);
});

test('room recommendation failure never clears a previously verified account directory or silently changes its selection', async () => {
  const h = harness(), session = await h.connect(), authEpoch = session.account!.authEpoch;
  const page = await h.service.page(origin, { roomId: '1001', authEpoch }, signal());
  assert.equal(page.selectedMedalId, null);
  h.override = url => url.href.startsWith(MEDAL_PANEL_API) && url.searchParams.has('room_id') ? new Response('{}', { status: 503 }) : undefined;
  await assert.rejects(h.service.roomContext(origin, { roomId: '1001', authEpoch }, signal()));
  assert.equal(h.events.length, 0);
  const result = await h.service.set(origin, { roomId: '1001', authEpoch, medalId: '101' }, signal());
  assert.equal(result.status, 'applied'); assert.equal(result.selectedMedalId, '101');
});

test('room-panel RPC rejects ungranted accounts, unexpected parameters, changed epochs and changed Cookie identity', async () => {
  const h = harness();
  await assert.rejects(h.service.roomContext(origin, { roomId: '1001', authEpoch: 'epoch' }, signal()), (e: unknown) => e instanceof BrokerError && e.code === 'UNAUTHORIZED');
  const session = await h.connect(), authEpoch = session.account!.authEpoch;
  for (const extra of [{ force: true }, { page: 2 }, { targetUid: '777' }])
    await assert.rejects(h.service.roomContext(origin, { roomId: '1001', authEpoch, ...extra }, signal()), (e: unknown) => e instanceof BrokerError && e.code === 'INVALID_REQUEST');
  assert.equal(h.network.length, 0);
  await assert.rejects(h.service.roomContext(origin, { roomId: '1001', authEpoch: 'stale' }, signal()), (e: unknown) => e instanceof BrokerError && e.code === 'ACCOUNT_CHANGED');
  h.cookieUid = '43';
  await assert.rejects(h.service.roomContext(origin, { roomId: '1001', authEpoch }, signal()), (e: unknown) => e instanceof BrokerError && e.code === 'ACCOUNT_CHANGED');
  assert.equal(h.network.filter(row => row.url.href.startsWith(MEDAL_PANEL_API)).length, 0);
});

test('wear requires a listed own medal and posts current room anchor target_id with internal CSRF, then reads real curr_show', async () => {
  const h = harness(), session = await h.connect(), authEpoch = session.account!.authEpoch;
  await assert.rejects(h.service.set(origin, { roomId: '1001', authEpoch, medalId: '101' }, signal()), /重新打开/);
  await h.service.page(origin, { roomId: '1001', authEpoch }, signal());
  const result = await h.service.set(origin, { roomId: '1001', authEpoch, medalId: '101', operationId: 'operation-1' }, signal());
  assert.equal(result.status, 'applied'); assert.equal(result.wearing?.targetUid, '777');
  assert.equal(result.selectedMedalId, '101'); assert.equal(result.displayConfirmed, true);
  const post = h.network.find(row => row.init?.method === 'POST')!;
  assert.equal(post.url.href, MEDAL_WEAR_API); const body = post.init!.body as URLSearchParams;
  assert.equal(body.get('medal_id'), '101'); assert.equal(body.get('target_id'), '888');
  assert.equal(body.get('csrf'), 'fixture-csrf'); assert.equal(body.get('csrf_token'), 'fixture-csrf');
  assert.ok(h.network.at(-1)?.url.href.startsWith(MEDAL_CURRENT_API));
  assert.equal(h.events.length, 1); assert.equal(h.events[0].roomId, '1001'); assert.equal(h.navCalls, 1);
  assert.equal(JSON.stringify(result).includes('fixture-'), false); assert.equal(h.rules.size, 0);
  await h.service.set(origin, { roomId: '1001', authEpoch, medalId: '101', operationId: 'operation-1' }, signal());
  assert.equal(h.network.filter(row => row.init?.method === 'POST').length, 1, 'same operation ID never replays a write');
  assert.equal(h.diagnostics.length, 1, 'the same operation ID does not repeat diagnostic reporting');
  await assert.rejects(h.service.set(origin, { roomId: '1001', authEpoch, medalId: null, operationId: 'operation-1' }, signal()), /请求已变更/);
});

test('take_off uses room target and real empty current display without a fake medal ID', async () => {
  const h = harness(), session = await h.connect(), authEpoch = session.account!.authEpoch;
  const result = await h.service.set(origin, { roomId: '1001', authEpoch, medalId: null }, signal());
  assert.equal(result.status, 'applied'); assert.equal(result.wearing, null);
  assert.equal(result.selectedMedalId, null); assert.equal(result.displayConfirmed, true);
  const post = h.network.find(row => row.init?.method === 'POST')!;
  assert.equal(post.url.href, MEDAL_TAKE_OFF_API); assert.equal((post.init?.body as URLSearchParams).get('target_id'), '888');
  assert.equal((post.init?.body as URLSearchParams).has('medal_id'), false);
});

test('a lost POST response remains unknown even when curr_show matches and is never automatically posted again', async () => {
  const h = harness(), session = await h.connect(), authEpoch = session.account!.authEpoch;
  await h.service.page(origin, { roomId: '1001', authEpoch }, signal());
  h.override = url => { if (url.href === MEDAL_WEAR_API) { h.wearing = current(); throw new TypeError('network response lost'); } return undefined; };
  const result = await h.service.set(origin, { roomId: '1001', authEpoch, medalId: '101' }, signal());
  assert.equal(result.status, 'unknown'); assert.equal(result.selectedMedalId, undefined);
  assert.equal(result.displayConfirmed, true); assert.equal(result.wearing?.targetUid, '777');
  assert.equal(h.events.length, 0);
  assert.deepEqual(h.diagnostics, [{ action: 'wear', write: 'unconfirmed', display: 'present', status: 'unknown' }]);
  assert.equal(h.network.filter(row => row.init?.method === 'POST').length, 1);
  h.override = url => { if (url.href === MEDAL_TAKE_OFF_API || url.href.startsWith(MEDAL_CURRENT_API)) throw new TypeError('network failed'); return undefined; };
  const unknown = await h.service.set(origin, { roomId: '1001', authEpoch, medalId: null }, signal());
  assert.equal(unknown.status, 'unknown'); assert.match(unknown.message!, /未确认/);
  assert.equal(h.network.filter(row => row.init?.method === 'POST').length, 2);
});

test('a malformed POST reply without a numeric business code remains unknown rather than an explicit rejection', async () => {
  for (const body of [{}, { code: '0' }, { code: '1500008' }, { code: null }, { code: 0.5 }]) {
    const h = harness(), session = await h.connect(), authEpoch = session.account!.authEpoch;
    await h.service.page(origin, { roomId: '1001', authEpoch }, signal());
    h.override = url => url.href === MEDAL_WEAR_API ? new Response(JSON.stringify(body)) : undefined;
    const result = await h.service.set(origin, { roomId: '1001', authEpoch, medalId: '101' }, signal());
    assert.equal(result.status, 'unknown'); assert.equal(result.selectedMedalId, undefined);
    assert.equal(result.displayConfirmed, true); assert.equal(h.events.length, 0);
    assert.equal(h.network.filter(row => row.init?.method === 'POST').length, 1);
    assert.deepEqual(h.diagnostics, [{ action: 'wear', write: 'unconfirmed', display: 'present', status: 'unknown' }]);
  }
});

test('explicit upstream refusal including 1500008 cannot be changed into applied merely because a medal appears current', async () => {
  const h = harness(), session = await h.connect(), authEpoch = session.account!.authEpoch;
  await h.service.page(origin, { roomId: '1001', authEpoch }, signal());
  h.override = url => {
    if (url.href === MEDAL_WEAR_API) return new Response(JSON.stringify({ code: 1500008, errorMsg: '当前房间暂不可切换', message: 'fallback' }));
  };
  h.wearing = current();
  const result = await h.service.set(origin, { roomId: '1001', authEpoch, medalId: '101' }, signal());
  assert.equal(result.status, 'rejected'); assert.match(result.message!, /暂不可切换/);
  assert.deepEqual(h.diagnostics, [{ action: 'wear', write: 'rejected', upstreamCode: 1500008, display: 'present', status: 'rejected' }]);
  assert.equal(h.events.length, 0); assert.equal(h.network.filter(row => row.init?.method === 'POST').length, 1);
  h.override = url => {
    if (url.href === MEDAL_WEAR_API) return new Response(JSON.stringify({ code: 1500008, message: '当前房间暂不可切换' }));
    if (url.href.startsWith(MEDAL_CURRENT_API)) throw new TypeError('current display unavailable');
  };
  const rejected = await h.service.set(origin, { roomId: '1001', authEpoch, medalId: '101' }, signal());
  assert.equal(rejected.status, 'rejected'); assert.match(rejected.message!, /暂不可切换/);
  assert.equal(rejected.displayConfirmed, false); assert.equal(rejected.selectedMedalId, undefined); assert.equal(h.events.length, 0);
  assert.deepEqual(h.diagnostics.at(-1), { action: 'wear', write: 'rejected', upstreamCode: 1500008, display: 'unavailable', status: 'rejected' });
});

test('write acknowledgement is authoritative while room display stays empty, different or temporarily unavailable', async () => {
  for (const display of ['empty', 'different', 'unavailable'] as const) {
    const h = harness(), session = await h.connect(), authEpoch = session.account!.authEpoch;
    await h.service.page(origin, { roomId: '1001', authEpoch }, signal());
    h.override = url => {
      if (url.href === MEDAL_WEAR_API) return new Response(JSON.stringify({ code: 0 }));
      if (url.href.startsWith(MEDAL_CURRENT_API)) {
        if (display === 'unavailable') throw new TypeError('display offline');
        return new Response(JSON.stringify(display === 'empty' ? { code: 0, data: { curr_show: null } } : current(888, '房间牌')));
      }
    };
    const result = await h.service.set(origin, { roomId: '1001', authEpoch, medalId: '101' }, signal());
    assert.equal(result.status, 'applied'); assert.equal(result.selectedMedalId, '101');
    assert.equal(result.displayConfirmed, display !== 'unavailable');
    assert.equal(result.wearing?.targetUid ?? null, display === 'different' ? '888' : null);
    assert.equal(h.events.length, 1); assert.equal(h.network.filter(row => row.init?.method === 'POST').length, 1);
    assert.deepEqual(h.diagnostics, [{ action: 'wear', write: 'acknowledged', upstreamCode: 0, display: display === 'different' ? 'present' : display, status: 'applied' }]);
  }
});

test('take-off acknowledgement does not require an empty room display and emits only safe local diagnostic fields', async () => {
  const h = harness(), session = await h.connect(), authEpoch = session.account!.authEpoch;
  h.override = url => url.href === MEDAL_TAKE_OFF_API ? new Response(JSON.stringify({ code: 0 })) : undefined;
  const result = await h.service.set(origin, { roomId: '1001', authEpoch, medalId: null }, signal());
  assert.equal(result.status, 'applied'); assert.equal(result.selectedMedalId, null);
  assert.equal(result.wearing?.targetUid, '888'); assert.equal(result.displayConfirmed, true);
  assert.deepEqual(h.diagnostics, [{ action: 'take_off', write: 'acknowledged', upstreamCode: 0, display: 'present', status: 'applied' }]);
  assert.equal(JSON.stringify(h.diagnostics).includes('fixture'), false);
  assert.ok(h.diagnostics.every(value => Object.keys(value).every(key => ['action', 'write', 'upstreamCode', 'display', 'status'].includes(key))));
});

test('paginated panel selection is independent from curr_show and a partial page cannot declare taken off', () => {
  const partial = projectMedalItems({ data: { total_number: 20, list: [medal()], special_list: [] } });
  assert.equal(partial.selectedMedalId, undefined); assert.equal(Object.hasOwn(partial, 'selectedMedalId'), false);
  assert.equal(partial.selectionPageComplete, true);
  assert.equal(projectMedalItems({ data: { total_number: 1, list: [medal()] } }, 2).selectedMedalId, undefined);
  const worn = medal(); worn.medal.wearing_status = 1;
  assert.equal(projectMedalItems({ data: { total_number: 20, list: [worn] } }, 2).selectedMedalId, '101');
  const missing = medal(); delete (missing.medal as Partial<typeof missing.medal>).wearing_status;
  assert.equal(projectMedalItems({ data: { total_number: 1, list: [missing] } }).selectedMedalId, undefined);
  assert.equal(projectMedalItems({ data: { total_number: 1, list: [missing] } }).selectionPageComplete, false);
  assert.equal(projectMedalItems({ data: { total_number: 1, list: [medal()] } }).selectedMedalId, undefined, 'a legacy nonempty page alone is not a full-account selection proof');
  assert.equal(projectMedalItems({ data: { total_number: 1, list: [medal()], page_info: { current_page: 1, total_page: 1 } } }).selectedMedalId, null);
  const conflicting = projectMedalItems({ data: { total_number: 1, list: [medal()], special_list: [worn] } });
  assert.equal(conflicting.selectionPageComplete, false); assert.equal(conflicting.selectedMedalId, undefined);
  const second = medal(102); second.medal.wearing_status = 1;
  const multiple = projectMedalItems({ data: { total_number: 2, list: [worn, second] } });
  assert.equal(multiple.selectionPageComplete, false); assert.equal(multiple.selectedMedalId, undefined);
  const duplicate = projectMedalItems({ data: { total_number: 1, list: [worn], special_list: [worn] } });
  assert.equal(duplicate.selectionPageComplete, true); assert.equal(duplicate.selectedMedalId, '101');
});

test('official page_info includes short special pages and owns pagination independently of the displayed medal count', () => {
  const list = Array.from({ length: 9 }, (_, index) => medal(101 + index, 777 + index));
  // The account center may group special medals separately. total_number is a
  // display count, never a substitute for the official page_info page count.
  const first = projectMedalItems({ data: { total_number: 10, list, special_list: [medal(201, 877)], page_info: { current_page: 1, total_page: 3 } } });
  assert.equal(first.items.length, 10); assert.equal(first.selectionPageComplete, true);
  assert.equal(first.total, 10); assert.equal(first.totalPages, 3); assert.equal(first.hasMore, true);
  assert.equal(Object.hasOwn(first, 'selectedMedalId'), false);
  const last = projectMedalItems({ data: { total_number: 10, list: [medal(301)], page_info: { current_page: 3, total_page: 3 } } }, 3);
  assert.equal(last.totalPages, 3); assert.equal(last.hasMore, false); assert.equal(last.selectedMedalId, undefined);
  const onePage = projectMedalItems({ data: { total_number: 30, list: [medal()], page_info: { current_page: 1, total_page: 1 } } });
  assert.equal(onePage.hasMore, false); assert.equal(onePage.selectedMedalId, null);
});

test('legacy pagination accepts a short ordinary list and safely reads one last empty page instead of silently truncating', () => {
  for (const total of [1, 10, 100, undefined]) {
    const first = projectMedalItems({ data: { total_number: total, list: [medal()], special_list: [medal(201)] } });
    assert.equal(first.totalPages, undefined); assert.equal(first.hasMore, true);
    assert.equal(first.selectedMedalId, undefined);
  }
  const emptyEnd = projectMedalItems({ data: { total_number: 20, list: [], special_list: [medal(201)] } }, 3);
  assert.equal(emptyEnd.hasMore, false); assert.equal(emptyEnd.selectedMedalId, undefined);
  const specialOnly = projectMedalItems({ data: { total_number: 1, list: [], special_list: [medal(201)] } });
  assert.equal(specialOnly.hasMore, false); assert.equal(specialOnly.selectedMedalId, undefined, 'a special-only legacy first page is not proof of the entire account selection');
  assert.equal(projectMedalItems({ data: { total_number: 0, list: [] } }).selectedMedalId, null);
});

test('empty official directories normalize only the first empty page and reject inconsistent page identities', () => {
  for (const current of [0, 1]) {
    const result = projectMedalItems({ data: { total_number: 0, list: [], special_list: [], page_info: { current_page: current, total_page: 0 } } });
    assert.equal(result.totalPages, 0); assert.equal(result.hasMore, false); assert.equal(result.selectedMedalId, null);
  }
  for (const [requested, pageInfo, list, total] of [
    [2, { current_page: 1, total_page: 3 }, [medal()], 10],
    [2, { current_page: 2, total_page: 1 }, [], 10],
    [1, { current_page: 0, total_page: 1 }, [], 0],
    [1, { current_page: 1, total_page: 0 }, [medal()], 1],
    [1, { current_page: 1, total_page: 0 }, [], 1],
    [2, { current_page: 0, total_page: 0 }, [], 0],
    [1, { current_page: 1, total_page: '2' }, [], 0],
    [1, { current_page: 1, total_page: 10001 }, [], 0],
    [1, {}, [], 0]
  ] as const) assert.throws(() => projectMedalItems({ data: { total_number: total, list, page_info: pageInfo } }, requested), /页码发生变化/);
});

test('directory service retains official short-page pagination and never accepts a response for another page', async () => {
  const h = harness(), session = await h.connect(), authEpoch = session.account!.authEpoch;
  h.override = url => url.href.startsWith(MEDAL_PANEL_API) ? new Response(JSON.stringify({ code: 0, data: {
    total_number: 10, list: Array.from({ length: 9 }, (_, index) => medal(101 + index)), special_list: [medal(201)],
    page_info: { current_page: 1, total_page: 3 }
  } })) : undefined;
  const page = await h.service.page(origin, { roomId: '1001', authEpoch }, signal());
  assert.equal(page.totalPages, 3); assert.equal(page.hasMore, true); assert.equal(page.selectedMedalId, undefined);
  assert.equal(h.network.find(row => row.url.href.startsWith(MEDAL_PANEL_API))?.url.search, '?page=1&page_size=10');
  assert.equal(h.network.find(row => row.url.href.startsWith(MEDAL_CURRENT_API))?.url.search, '?uid=42&up_uid=888');
  const before = h.network.length;
  await assert.rejects(h.service.page(origin, { roomId: '1001', authEpoch, page: 2 }, signal()), /页码发生变化/);
  assert.equal(h.network.length, before + 1, 'mismatched page is rejected without extra display reads, alternative APIs or retries');
});

test('a display read failure preserves a valid directory but account and risk failures still propagate', async () => {
  const h = harness(), session = await h.connect(), authEpoch = session.account!.authEpoch;
  h.override = url => { if (url.href.startsWith(MEDAL_CURRENT_API)) throw new TypeError('display offline'); return undefined; };
  const page = await h.service.page(origin, { roomId: '1001', authEpoch }, signal());
  assert.equal(page.items.length, 1); assert.equal(page.displayConfirmed, false); assert.equal(page.wearing, null);
  h.override = url => url.href.startsWith(MEDAL_CURRENT_API) ? new Response('{}', { status: 429 }) : undefined;
  await assert.rejects(h.service.page(origin, { roomId: '1001', authEpoch }, signal()), (failure: unknown) => failure instanceof BrokerError && failure.code === 'RATE_LIMITED');
  const auth = harness(), authSession = await auth.connect();
  auth.override = url => url.href.startsWith(MEDAL_CURRENT_API) ? new Response(JSON.stringify({ code: -101 })) : undefined;
  await assert.rejects(auth.service.page(origin, { roomId: '1001', authEpoch: authSession.account!.authEpoch }, signal()), /重新确认账号/);
});

test('room and transport preparation failures before POST return a safe rejection without locking unknown or issuing a display read', async () => {
  for (const failure of ['room', 'cookies', 'rules', 'csrf'] as const) {
    const h = harness(), session = await h.connect(), authEpoch = session.account!.authEpoch;
    await h.service.page(origin, { roomId: '1001', authEpoch }, signal());
    const priorCurrentReads = h.network.filter(row => row.url.href.startsWith(MEDAL_CURRENT_API)).length;
    if (failure === 'room') {
      h.now = 1_800_000_600_001;
      h.override = url => { if (url.pathname.endsWith('/room_init')) throw new TypeError('room offline'); return undefined; };
    } else if (failure === 'cookies') h.cookieFailure = new Error('cookie transport unavailable');
    else if (failure === 'rules') h.ruleFailure = new Error('transport rule installation unavailable');
    else h.csrfAvailable = false;
    const result = await h.service.set(origin, { roomId: '1001', authEpoch, medalId: '101' }, signal());
    assert.equal(result.status, 'rejected'); assert.equal(result.displayConfirmed, false);
    assert.equal(result.selectedMedalId, undefined); assert.equal(Object.hasOwn(result, 'selectedMedalId'), false);
    assert.match(result.message!, /稍后重试/); assert.equal(h.events.length, 0);
    assert.equal(h.network.filter(row => row.init?.method === 'POST').length, 0);
    assert.equal(h.network.filter(row => row.url.href.startsWith(MEDAL_CURRENT_API)).length, priorCurrentReads);
    assert.deepEqual(h.diagnostics, [{ action: 'wear', write: 'not-dispatched', display: 'unavailable', status: 'rejected' }]);
  }
});

test('session preparation unavailable before business work is safely rejected only for an already verified current account', async () => {
  const h = harness(), session = await h.connect(), authEpoch = session.account!.authEpoch;
  h.sessions.requireChat = async () => { throw new BrokerError('UNAVAILABLE', 'session preparation offline'); };
  const result = await h.service.set(origin, { roomId: '1001', authEpoch, medalId: null }, signal());
  assert.equal(result.status, 'rejected'); assert.equal(result.displayConfirmed, false); assert.equal(result.selectedMedalId, undefined);
  assert.equal(h.network.length, 0); assert.equal(h.events.length, 0);
  assert.deepEqual(h.diagnostics, [{ action: 'take_off', write: 'not-dispatched', display: 'unavailable', status: 'rejected' }]);
  await assert.rejects(h.service.set(origin, { roomId: '1001', authEpoch: 'stale', medalId: null }, signal()), (failure: unknown) => failure instanceof BrokerError && failure.code === 'ACCOUNT_CHANGED');
  assert.equal(h.diagnostics.length, 1);
  const unauthenticated = harness();
  unauthenticated.sessions.requireChat = async () => { throw new BrokerError('UNAVAILABLE', 'session preparation offline'); };
  await assert.rejects(unauthenticated.service.set(origin, { roomId: '1001', authEpoch, medalId: null }, signal()), (failure: unknown) => failure instanceof BrokerError && failure.code === 'UNAUTHORIZED');
  assert.equal(unauthenticated.diagnostics.length, 0);
  const limited = harness(), limitedSession = await limited.connect();
  limited.sessions.requireChat = async () => { throw new BrokerError('RATE_LIMITED', 'wait', 30); };
  await assert.rejects(limited.service.set(origin, { roomId: '1001', authEpoch: limitedSession.account!.authEpoch, medalId: null }, signal()), (failure: unknown) => failure instanceof BrokerError && failure.code === 'RATE_LIMITED');
  assert.equal(limited.diagnostics.length, 0);
});

test('authorization, epoch, Cookie identity and catalog invalidation stop stale writes before dispatch', async () => {
  const h = harness();
  await assert.rejects(h.service.page(origin, { roomId: '1001', authEpoch: 'epoch' }, signal()), (e: unknown) => e instanceof BrokerError && e.code === 'UNAUTHORIZED');
  const session = await h.connect(), authEpoch = session.account!.authEpoch;
  await assert.rejects(h.service.page(origin, { roomId: '1001', authEpoch: 'stale' }, signal()), (e: unknown) => e instanceof BrokerError && e.code === 'ACCOUNT_CHANGED');
  await h.service.page(origin, { roomId: '1001', authEpoch }, signal());
  h.cookieUid = '43';
  await assert.rejects(h.service.set(origin, { roomId: '1001', authEpoch, medalId: '101' }, signal()), (e: unknown) => e instanceof BrokerError && e.code === 'ACCOUNT_CHANGED');
  assert.equal(h.network.filter(row => row.init?.method === 'POST').length, 0);
  h.cookieUid = '42'; h.service.invalidate();
  await assert.rejects(h.service.set(origin, { roomId: '1001', authEpoch, medalId: '101' }, signal()), /重新打开/);
  await h.sessions.grant(origin, false);
  await assert.rejects(h.service.set(origin, { roomId: '1001', authEpoch, medalId: null }, signal()));
});

test('transport restricts medal endpoints to authenticated exact queries and the correct HTTP method', async () => {
  const h = harness();
  for (const [url, mode, method] of [
    [`${MEDAL_PANEL_API}?page=1&page_size=10`, 'anonymous', 'GET'],
    [`${MEDAL_PANEL_API}?page=1&page_size=100`, 'authenticated', 'GET'],
    [`${MEDAL_PANEL_API}?page=1&page_size=10&room_id=1001&target_id=888`, 'anonymous', 'GET'],
    [`${MEDAL_PANEL_API}?page=2&page_size=10&room_id=1001&target_id=888`, 'authenticated', 'GET'],
    [`${MEDAL_PANEL_API}?page=1&page_size=10&room_id=1001`, 'authenticated', 'GET'],
    [`${MEDAL_PANEL_API}?page=1&page_size=10&room_id=1001&target_id=888&url=https://evil.test`, 'authenticated', 'GET'],
    [`${MEDAL_PANEL_API}?page=1&page_size=10&page=2`, 'authenticated', 'GET'],
    [`${MEDAL_CURRENT_API}?uid=42&up_uid=888&url=https://evil.test`, 'authenticated', 'GET'],
    [MEDAL_WEAR_API, 'authenticated', 'GET'], [MEDAL_WEAR_API, 'anonymous', 'POST'],
    [`${MEDAL_TAKE_OFF_API}?target_id=888`, 'authenticated', 'POST']
  ] as const) await assert.rejects(h.transport.run(new URL(url), mode, signal(), async () => {}, { method }));
  assert.equal(h.cookieReads, 0); assert.equal(h.rules.size, 0);
});

test('rate limits are respected across reads and no retry or alternative endpoint is attempted', async () => {
  const h = harness(), session = await h.connect(), authEpoch = session.account!.authEpoch;
  h.override = url => url.href.startsWith(MEDAL_PANEL_API) ? new Response('{}', { status: 429, headers: { 'retry-after': '90' } }) : undefined;
  await assert.rejects(h.service.page(origin, { roomId: '1001', authEpoch }, signal()), (e: unknown) => e instanceof BrokerError && e.retryAfter === 90);
  const count = h.network.length;
  await assert.rejects(h.service.page(origin, { roomId: '1001', authEpoch }, signal()), (e: unknown) => e instanceof BrokerError && e.code === 'RATE_LIMITED');
  assert.equal(h.network.length, count); assert.equal(h.rules.size, 0);
});
