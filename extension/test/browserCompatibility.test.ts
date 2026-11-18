import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUDIO_CDN_ORIGINS, audioBrowserPermissions, audioOnlyPermissionRemoval, audioPermissionRequest, authorizationPermissionRequest, danmakuWebsocketRegex, FIREFOX_DEFAULT_STORE, isFirefoxRuntime, localCookieQuery, requiredBrowserPermissions, supportedPageContext, unpartitionedCookie } from '../lib/browserCompatibility';

test('Firefox cookie reads select only the ordinary default store and unisolated first party', () => {
  const url = 'https://api.bilibili.com/x/web-interface/nav';
  assert.deepEqual(localCookieQuery(url, true), { url, storeId: FIREFOX_DEFAULT_STORE, firstPartyDomain: '' });
  assert.deepEqual(localCookieQuery(url, false), { url });
  assert.equal(unpartitionedCookie({}), true);
  assert.equal(unpartitionedCookie({ partitionKey: null, firstPartyDomain: '' }), true);
  assert.equal(unpartitionedCookie({ partitionKey: { topLevelSite: 'https://bwatch.icu' } }), false);
  assert.equal(unpartitionedCookie({ firstPartyDomain: 'bilibili.com' }), false);
});

test('container/private tabs cannot authorize an account from a different cookie store', () => {
  assert.equal(supportedPageContext({ cookieStoreId: FIREFOX_DEFAULT_STORE }, true), undefined);
  assert.match(supportedPageContext({ cookieStoreId: 'firefox-container-1' }, true)!, /容器标签页/);
  assert.match(supportedPageContext({}, true)!, /默认标签页/);
  assert.match(supportedPageContext({ incognito: true, cookieStoreId: 'firefox-private' }, true)!, /隐私窗口/);
  assert.equal(supportedPageContext({}, false), undefined);
  assert.equal(isFirefoxRuntime('moz-extension://installation-uuid/'), true);
  assert.equal(isFirefoxRuntime('chrome-extension://abcdefghijkl/'), false);
});

test('Firefox DNR host permissions explicitly cover WSS and local builds keep their exact sources', () => {
  assert.equal(requiredBrowserPermissions(true, false).origins.includes('wss://*.chat.bilibili.com/*'), true);
  assert.equal(requiredBrowserPermissions(false, false).origins.some(origin => origin.startsWith('wss:')), false);
  assert.equal(requiredBrowserPermissions(true, false).origins.some(origin => origin.startsWith('http:')), false);
  assert.equal(requiredBrowserPermissions(true, true).origins.includes('http://127.0.0.1/*'), true);
});

test('Firefox authorization requests only MV3 host grants, never required API permissions', () => {
  const requested = authorizationPermissionRequest(true, true);
  assert.equal('permissions' in requested, false, 'required cookies/DNR permissions cannot be requested as optional Firefox permissions');
  assert.deepEqual(requested.origins, [...requiredBrowserPermissions(true, true).origins, ...AUDIO_CDN_ORIGINS]);
  assert.deepEqual(authorizationPermissionRequest(false, false), { ...requiredBrowserPermissions(false, false),
    origins: [...requiredBrowserPermissions(false, false).origins, ...AUDIO_CDN_ORIGINS] });
});

test('anonymous audio host repair excludes Cookie and account authorization requirements', () => {
  const permissions = audioBrowserPermissions(false);
  assert.deepEqual(permissions.permissions, ['declarativeNetRequestWithHostAccess']);
  assert.equal(permissions.origins.includes('https://api.live.bilibili.com/*'), true);
  assert.equal(permissions.origins.some(origin => origin.startsWith('wss:')), false);
  assert.equal(permissions.origins.some(origin => origin.startsWith('http:')), false);
  assert.equal(audioBrowserPermissions(true).origins.includes('http://localhost/*'), true);
  assert.deepEqual(audioPermissionRequest(true, false), { origins: permissions.origins });
  assert.deepEqual(audioPermissionRequest(false, false), permissions);
  for (const origin of AUDIO_CDN_ORIGINS) assert.equal(requiredBrowserPermissions(true, false).origins.includes(origin), false,
    'missing audio CDN access must not invalidate existing account authorization');
});

test('removing only an audio CDN grant does not revoke unrelated account permission', () => {
  assert.equal(audioOnlyPermissionRemoval({ origins: AUDIO_CDN_ORIGINS }), true);
  assert.equal(audioOnlyPermissionRemoval({ origins: ['https://audio.bilivideo.com/*'] }), true);
  for (const removal of [{}, { origins: [] }, { origins: ['https://*.bilibili.com/*'] },
    { origins: ['<all_urls>'] }, { origins: ['https://bilivideo.com.evil.example/*'] },
    { origins: AUDIO_CDN_ORIGINS, permissions: ['declarativeNetRequestWithHostAccess'] }])
    assert.equal(audioOnlyPermissionRemoval(removal), false);
});

test('Firefox WebSocket Cookie isolation matches its HTTPS upgrade channel without broadening hosts or paths', () => {
  const firefox = new RegExp(danmakuWebsocketRegex(true)), chrome = new RegExp(danmakuWebsocketRegex(false));
  for (const address of ['wss://chat.bilibili.com/sub', 'wss://test.chat.bilibili.com:443/sub?fixture=1']) {
    assert.equal(firefox.test(address), true);
    assert.equal(chrome.test(address), true);
    assert.equal(firefox.test(address.replace('wss:', 'https:')), true);
    assert.equal(chrome.test(address.replace('wss:', 'https:')), false);
  }
  for (const address of ['ws://test.chat.bilibili.com/sub', 'http://test.chat.bilibili.com/sub',
    'https://test.chat.bilibili.com.evil.test/sub', 'https://evilchat.bilibili.com/sub',
    'https://test.chat.bilibili.com/other', 'https://test.chat.bilibili.com/sub/other',
    'https://user@test.chat.bilibili.com/sub', 'https://test.chat.bilibili.com/sub#fragment'])
    assert.equal(firefox.test(address), false, address);
});
