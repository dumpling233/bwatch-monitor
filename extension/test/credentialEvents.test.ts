import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CredentialCookieEvents } from '../lib/credentialEvents';

const cookie = (name = 'SESSDATA', value = 'fixture', overrides: Partial<chrome.cookies.Cookie> = {}): chrome.cookies.Cookie => ({
  name, value, domain: '.bilibili.com', path: '/', session: true, storeId: '0', secure: true,
  httpOnly: true, hostOnly: false, sameSite: 'lax', ...overrides
});
function harness() {
  let identity = 0, writes = 0;
  const events = new CredentialCookieEvents({ identityChanged: () => identity++, writesChanged: () => writes++ });
  const changed = (value: chrome.cookies.Cookie, removed = false, cause: chrome.cookies.CookieChangeInfo['cause'] = 'explicit') =>
    events.changed({ cookie: value, removed, cause });
  return { events, changed, get identity() { return identity; }, get writes() { return writes; } };
}

test('equal-value expiry renewals and Chrome overwrite pairs do not invalidate a verified account', () => {
  const item = harness(), initial = cookie(); item.events.observe([initial]);
  item.changed(initial, true, 'overwrite');
  item.changed({ ...initial, session: false, expirationDate: 2_000_000_000 });
  item.changed(initial);
  assert.equal(item.identity, 0); assert.equal(item.writes, 0);
  item.changed(initial, true, 'overwrite'); item.changed(cookie('SESSDATA', 'replacement'));
  assert.equal(item.identity, 1);
  item.changed(initial, true, 'explicit');
  assert.equal(item.identity, 1, 'a delayed old-value deletion cannot invalidate the replacement');
});

test('real identity changes invalidate only account work while CSRF rotation invalidates only writes', () => {
  const item = harness(); item.events.observe([cookie(), cookie('DedeUserID', '42'), cookie('bili_jct', 'old-csrf')]);
  item.changed(cookie('bili_jct', 'old-csrf'), true, 'overwrite'); item.changed(cookie('bili_jct', 'new-csrf'));
  assert.equal(item.writes, 1); assert.equal(item.identity, 0);
  item.changed(cookie('DedeUserID', '42'), true, 'overwrite'); item.changed(cookie('DedeUserID', '43'));
  assert.equal(item.identity, 1);
  item.changed(cookie('SESSDATA', 'fixture'), true, 'expired');
  assert.equal(item.identity, 2);
});

test('unrelated domains, API paths, partitioned cookies and other cookie stores do not trigger account checks', () => {
  const item = harness(); item.events.observe([cookie()]);
  for (const value of [
    cookie('buvid3'), cookie('unrelated'), cookie('SESSDATA', 'other', { domain: '.example.com' }),
    cookie('SESSDATA', 'other', { domain: 'live.bilibili.com', hostOnly: true }),
    cookie('SESSDATA', 'other', { domain: '.bilibili.com.evil.test' }),
    cookie('SESSDATA', 'other', { path: '/unrelated/' }), cookie('SESSDATA', 'other', { path: '/msg/sen' }),
    cookie('SESSDATA', 'other', { partitionKey: { topLevelSite: 'https://example.com' } }),
    cookie('SESSDATA', 'other', { storeId: '1' })
  ]) item.changed(value);
  assert.equal(item.identity, 0); assert.equal(item.writes, 0);
  item.changed(cookie('SESSDATA', 'api-local', { domain: 'api.live.bilibili.com', hostOnly: true, path: '/msg' }));
  assert.equal(item.identity, 1, 'a cookie affecting a fixed authenticated endpoint is relevant');
});

test('Firefox ignores other containers and first-party isolated cookies even before its first request', () => {
  let changes = 0;
  const events = new CredentialCookieEvents({ storeId: 'firefox-default', identityChanged: () => changes++, writesChanged: () => changes++ });
  events.changed({ cookie: cookie('SESSDATA', 'container', { storeId: 'firefox-container-1' }), removed: false, cause: 'explicit' });
  const isolated = { ...cookie('SESSDATA', 'isolated', { storeId: 'firefox-default' }), firstPartyDomain: 'bilibili.com' };
  events.changed({ cookie: isolated, removed: false, cause: 'explicit' });
  assert.equal(changes, 0);
  events.changed({ cookie: cookie('SESSDATA', 'ordinary', { storeId: 'firefox-default' }), removed: false, cause: 'explicit' });
  assert.equal(changes, 1);
});
