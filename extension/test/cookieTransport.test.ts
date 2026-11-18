import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LocalCookieTransport } from '../lib/cookieTransport';

const nav = new URL('https://api.bilibili.com/x/web-interface/nav');
const play = new URL('https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?room_id=1&protocol=0%2C1&format=0%2C1%2C2&codec=0&qn=250&platform=web&ptype=8');
const signal = () => new AbortController().signal;
const cookie = (name: string, value: string, sameSite: 'lax' | 'no_restriction' = 'lax') => ({
  name, value, domain: '.bilibili.com', path: '/', hostOnly: false, httpOnly: true, secure: true,
  session: true, storeId: '0', sameSite
}) as chrome.cookies.Cookie;

function harness(getCookies: (url: string) => Promise<chrome.cookies.Cookie[]>) {
  const rules = new Map<number, chrome.declarativeNetRequest.Rule>();
  const updates: chrome.declarativeNetRequest.UpdateRuleOptions[] = [];
  const transport = new LocalCookieTransport({ extensionId: 'testextension', getCookies,
    updateRules: async options => {
      updates.push(options);
      for (const id of options.removeRuleIds ?? []) rules.delete(id);
      for (const rule of options.addRules ?? []) rules.set(rule.id, structuredClone(rule));
    } });
  return { transport, rules, updates };
}

test('Lax and None cookies use a minimal exact-byte browser-only header with exact API rules', async () => {
  const urls: string[] = [];
  const { transport, rules } = harness(async url => {
    urls.push(url);
    return [cookie('SESSDATA', 'fixture%2Craw%2B'), cookie('DedeUserID', '42', 'no_restriction'),
      cookie('DedeUserID__ckMd5', 'fixture-hash'), cookie('bili_jct', 'not-needed-for-GET'), cookie('unrelated', 'never-copy'),
      { ...cookie('SESSDATA', 'partitioned-never-copy'), partitionKey: { topLevelSite: 'https://other.test' } }];
  });
  await transport.invalidate();
  await Promise.all([transport.prepare(nav, signal()), transport.prepare(play, signal())]);
  assert.deepEqual(urls.sort(), [nav.href, `${play.origin}${play.pathname}`].sort());
  assert.equal(rules.size, 2);
  for (const rule of rules.values()) {
    assert.deepEqual(rule.condition.initiatorDomains, ['testextension']);
    assert.deepEqual(rule.condition.requestMethods, ['get']);
    assert.deepEqual(rule.condition.resourceTypes, ['xmlhttprequest']);
    assert.equal(rule.action.requestHeaders?.find(value => value.header === 'Cookie')?.value,
      'SESSDATA=fixture%2Craw%2B; DedeUserID=42; DedeUserID__ckMd5=fixture-hash');
    const expression = new RegExp(rule.condition.regexFilter!);
    const valid = rule.id === 101 ? nav.href : play.href;
    assert.equal(expression.test(valid), true);
    const invalidQuery = rule.id === 101 ? [`${valid}&extra=1`] : [];
    for (const url of [...invalidQuery, valid.replace(rule.id === 101 ? '/nav' : '/getRoomPlayInfo', '/evil'), valid.replace('bilibili.com', 'bilibili.com.evil.test'),
      valid.replace('https:', 'http:')]) assert.equal(expression.test(url), false);
  }
  await transport.prepare(nav, signal());
  assert.equal(urls.length, 2, 'same generation shares its prepared cookie rule');
  await transport.invalidate();
  assert.equal(rules.size, 0, 'revoke/change clears all session material');
});

test('arbitrary URLs and header-injection values never install a cookie rule', async () => {
  let reads = 0;
  const { transport, rules } = harness(async () => { reads++; return [cookie('SESSDATA', 'fixture; injected=1')]; });
  await assert.rejects(transport.prepare(new URL(`${nav.href}?url=evil`), signal()));
  await assert.rejects(transport.prepare(new URL(`${play.href}&extra=1`), signal()));
  for (const qn of ['0', '-1', '250.5', '100001', '0250', 'Infinity']) {
    await assert.rejects(transport.prepare(new URL(play.href.replace('qn=250', `qn=${qn}`)), signal()));
  }
  assert.equal(reads, 0, 'full parameter validation happens before reading cookies');
  await assert.rejects(transport.prepare(nav, signal()));
  assert.equal(rules.size, 0);
  const badControl = harness(async () => [cookie('SESSDATA', 'fixture\r\nX-Test: 1')]);
  await assert.rejects(badControl.transport.prepare(play, signal()));
  assert.equal(badControl.rules.size, 0);
});

test('Firefox unpartitioned cookies accept null partition keys but never copy first-party isolated credentials', async () => {
  const ordinary = { ...cookie('SESSDATA', 'ordinary'), partitionKey: null } as unknown as chrome.cookies.Cookie;
  const isolated = { ...cookie('DedeUserID', 'isolated-user'), firstPartyDomain: 'bilibili.com' };
  const { transport } = harness(async () => [ordinary, isolated]);
  await transport.run(nav, 'authenticated', signal(), async values => {
    assert.equal(values.SESSDATA, 'ordinary');
    assert.equal(values.DedeUserID, undefined);
  });
});

test('dynamic bounded quality IDs pass the same exact API and parameter whitelist', async () => {
  let reads = 0;
  const { transport, rules } = harness(async () => { reads++; return [cookie('SESSDATA', 'fixture')]; });
  await transport.prepare(new URL(play.href.replace('qn=250', 'qn=32000')), signal());
  await transport.prepare(new URL(play.href.replace('qn=250', 'qn=100000')), signal());
  assert.equal(reads, 1);
  assert.equal(rules.size, 1);
  assert.deepEqual(rules.get(102)?.condition.initiatorDomains, ['testextension']);
});

test('a late cookie read from an old generation cannot reinstall old session rules', async () => {
  let release!: (cookies: chrome.cookies.Cookie[]) => void;
  let reads = 0;
  const { transport, rules, updates } = harness(async () => ++reads === 1
    ? new Promise(resolve => { release = resolve; }) : [cookie('SESSDATA', 'new-fixture')]);
  const old = transport.prepare(nav, signal());
  const rejected = assert.rejects(old, { name: 'AbortError' });
  await transport.invalidate();
  await transport.prepare(nav, signal());
  release([cookie('SESSDATA', 'old-fixture')]);
  await rejected;
  assert.equal(JSON.stringify(updates).includes('old-fixture'), false);
  assert.equal(rules.get(101)?.action.requestHeaders?.find(value => value.header === 'Cookie')?.value, 'SESSDATA=new-fixture');
});

test('rule writes serialize with invalidation so a late write is cleared before new requests', async () => {
  const rules = new Map<number, chrome.declarativeNetRequest.Rule>();
  let release!: () => void, entered!: () => void, reads = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const transport = new LocalCookieTransport({ extensionId: 'testextension',
    getCookies: async () => [cookie('SESSDATA', ++reads === 1 ? 'old-fixture' : 'new-fixture')],
    updateRules: async options => {
      if (options.addRules?.[0].action.requestHeaders?.some(value => value.value === 'SESSDATA=old-fixture')) { entered(); await gate; }
      for (const id of options.removeRuleIds ?? []) rules.delete(id);
      for (const rule of options.addRules ?? []) rules.set(rule.id, rule);
    } });
  const old = transport.prepare(nav, signal());
  const rejected = assert.rejects(old, { name: 'AbortError' });
  await started;
  const invalidation = transport.invalidate();
  const current = transport.prepare(nav, signal());
  release();
  await Promise.all([rejected, invalidation, current]);
  assert.equal(rules.get(101)?.action.requestHeaders?.find(value => value.header === 'Cookie')?.value, 'SESSDATA=new-fixture');
});

test('expired cookies are omitted and an aborted caller never starts preparation', async () => {
  let reads = 0;
  const { transport, rules } = harness(async () => { reads++; return [{ ...cookie('SESSDATA', 'expired'), session: false, expirationDate: 1 }]; });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(transport.prepare(nav, controller.signal), { name: 'AbortError' });
  assert.equal(reads, 0);
  await transport.prepare(nav, signal());
  assert.equal(rules.get(101)?.action.requestHeaders?.some(value => value.header === 'Cookie'), false);
});

test('prepared rules cannot outlive cookie expiration even without a browser cookie event', async () => {
  let now = 1000, reads = 0;
  const rules = new Map<number, chrome.declarativeNetRequest.Rule>();
  const transport = new LocalCookieTransport({ extensionId: 'testextension', now: () => now,
    getCookies: async () => { reads++; return [{ ...cookie('SESSDATA', 'short-lived-fixture'), session: false, expirationDate: 2 }]; },
    updateRules: async options => {
      for (const id of options.removeRuleIds ?? []) rules.delete(id);
      for (const rule of options.addRules ?? []) rules.set(rule.id, rule);
    } });
  await transport.prepare(nav, signal());
  assert.equal(rules.get(101)?.action.requestHeaders?.find(value => value.header === 'Cookie')?.value, 'SESSDATA=short-lived-fixture');
  now = 2001;
  await transport.prepare(nav, signal());
  assert.equal(reads, 2);
  assert.equal(rules.get(101)?.action.requestHeaders?.some(value => value.header === 'Cookie'), false);
});

test('startup reset follows a cookie invalidation that races its rule removal', async () => {
  let release!: () => void, entered!: () => void, removals = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const transport = new LocalCookieTransport({ extensionId: 'testextension', getCookies: async () => [],
    updateRules: async () => { if (++removals === 1) { entered(); await gate; } } });
  const startup = transport.reset();
  await started;
  const cookieChange = transport.invalidate();
  release();
  await Promise.all([startup, cookieChange]);
  assert.equal(removals, 2);
});

test('unavailable startup rule cleanup blocks all HTTP work and can recover after permissions return', async () => {
  let available = false, fetched = 0, installed = 0, cleanups = 0;
  const transport = new LocalCookieTransport({ extensionId: 'testextension', getCookies: async () => [],
    updateRules: async options => {
      if (!options.addRules && (options.removeRuleIds?.length ?? 0) > 1) {
        cleanups++;
        if (!available) throw new Error('browser permission unavailable');
      }
      installed += options.addRules?.length ?? 0;
    } });
  await assert.rejects(transport.reset(), /permission unavailable/);
  await assert.rejects(transport.run(nav, 'anonymous', signal(), async () => { fetched++; }), /permission unavailable/);
  assert.equal(fetched, 0);
  assert.equal(installed, 0, 'a failed startup cleanup cannot be bypassed by installing a new identity rule');
  available = true;
  await transport.run(nav, 'anonymous', signal(), async () => { fetched++; });
  assert.equal(fetched, 1);
  assert.equal(installed, 1);
  assert.equal(cleanups, 3);
});

test('same exact URL serializes anonymous and authenticated leases and removes credentials before switching', async () => {
  const { transport, rules } = harness(async () => [cookie('SESSDATA', 'fixture'), cookie('bili_jct', 'csrf')]);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const authenticated = transport.run(nav, 'authenticated', signal(), async values => {
    assert.equal(values.SESSDATA, 'fixture'); assert.equal(values.bili_jct, 'csrf'); entered(); await gate;
  });
  await started;
  let anonEntered = false;
  const anonymous = transport.run(nav, 'anonymous', signal(), async values => {
    anonEntered = true; assert.deepEqual(values, {});
    assert.equal(rules.size, 1);
    assert.equal([...rules.values()][0].action.requestHeaders?.find(header => header.header === 'Cookie')?.operation, 'remove');
  });
  await new Promise(resolve => setTimeout(resolve, 2)); assert.equal(anonEntered, false);
  release(); await Promise.all([authenticated, anonymous]); assert.equal(rules.size, 0);
});

test('different exact URLs can proceed concurrently and do not match another request', async () => {
  const { transport, rules } = harness(async () => [cookie('SESSDATA', 'fixture')]);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const first = transport.run(nav, 'authenticated', signal(), async () => { entered(); await gate; });
  await started;
  const room = new URL('https://api.live.bilibili.com/room/v1/Room/room_init?id=1');
  await transport.run(room, 'anonymous', signal(), async () => {
    assert.equal(rules.size, 2);
    assert.equal([...rules.values()].filter(rule => new RegExp(rule.condition.regexFilter!).test(room.href)).length, 1);
  });
  release(); await first; assert.equal(rules.size, 0);
});

test('fixed local endpoints reject unknown or duplicate parameters before reading cookies', async () => {
  let reads = 0;
  const { transport, rules } = harness(async () => { reads++; return []; });
  for (const value of ['https://api.live.bilibili.com/room/v1/Room/room_init?id=1&url=https://evil.test',
    'https://api.live.bilibili.com/live_user/v1/Master/info?uid=1&url=https://evil.test',
    'https://api.live.bilibili.com/live_user/v1/Master/info?uid=1&uid=2',
    'https://api.live.bilibili.com/live_user/v1/Master/info?uid=0',
    'https://api.bilibili.com/x/space/wbi/acc/info?mid=1&wts=1&w_rid=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'https://api.live.bilibili.com/room/v1/Room/room_init?id=1&id=2', 'https://api.live.bilibili.com/msg/send?room_id=1'])
    await assert.rejects(transport.run(new URL(value), 'authenticated', signal(), async () => {}));
  assert.equal(reads, 0); assert.equal(rules.size, 0);
});

test('public avatar endpoint uses its exact anonymous identity lease', async () => {
  const { transport, rules } = harness(async () => { throw new Error('public avatar must not read account cookies'); });
  const url = new URL('https://api.live.bilibili.com/live_user/v1/Master/info?uid=7');
  await transport.run(url, 'anonymous', signal(), async values => {
    assert.deepEqual(values, {});
    const rule = [...rules.values()][0];
    assert.equal(new RegExp(rule.condition.regexFilter!).test(url.href), true);
    assert.equal(new RegExp(rule.condition.regexFilter!).test(`${url.href}0`), false);
    assert.equal(rule.action.requestHeaders?.find(header => header.header === 'Cookie')?.operation, 'remove');
  });
  assert.equal(rules.size, 0);
});

test('invalidation aborts an in-flight local lease and prevents stale cookies from reappearing', async () => {
  const { transport, rules } = harness(async () => [cookie('SESSDATA', 'fixture')]);
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = transport.run(nav, 'authenticated', signal(), async (_values, requestSignal) => {
    entered(); await new Promise<void>((_, reject) => requestSignal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
  });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await started; await transport.invalidate(); await rejected; assert.equal(rules.size, 0);
});

test('CSRF rotation cancels pending writes without interrupting authenticated reads or their identity rules', async () => {
  const { transport, rules } = harness(async () => [cookie('SESSDATA', 'fixture'), cookie('bili_jct', 'csrf')]);
  let readEntered!: () => void, postEntered!: () => void, finishRead!: () => void;
  let readSignal!: AbortSignal;
  const readStarted = new Promise<void>(resolve => { readEntered = resolve; });
  const postStarted = new Promise<void>(resolve => { postEntered = resolve; });
  const readGate = new Promise<void>(resolve => { finishRead = resolve; });
  const read = transport.run(nav, 'authenticated', signal(), async (_values, requestSignal) => {
    readSignal = requestSignal; readEntered(); await readGate;
  });
  const post = transport.run(new URL('https://api.live.bilibili.com/msg/send'), 'authenticated', signal(), async (_values, requestSignal) => {
    postEntered(); await new Promise<void>((_, reject) => requestSignal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
  }, { method: 'POST' });
  const rejected = assert.rejects(post, { name: 'AbortError' });
  await Promise.all([readStarted, postStarted]);
  const epoch = transport.writeEpoch; transport.invalidateWrites();
  assert.equal(transport.writeEpoch, epoch + 1); assert.equal(readSignal.aborted, false);
  await rejected; assert.equal(rules.size, 1, 'the ongoing GET rule remains installed');
  finishRead(); await read; assert.equal(rules.size, 0);
});
