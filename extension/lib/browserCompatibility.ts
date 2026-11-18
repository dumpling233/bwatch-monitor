import type { Browser } from 'wxt/browser';
import { LOCAL_LOGIN_EXTENSION_NAME } from '../../shared/extensionBrand';
import { SITE_ORIGIN } from '../../shared/site';

/** The initial Firefox target intentionally uses one ordinary, unpartitioned cookie store. */
export const FIREFOX_DEFAULT_STORE = 'firefox-default';

export const isFirefoxRuntime = (runtimeUrl: string): boolean => new URL(runtimeUrl).protocol === 'moz-extension:';

export function localCookieQuery(url: string, firefox: boolean) {
  return firefox ? { url, storeId: FIREFOX_DEFAULT_STORE, firstPartyDomain: '' } : { url };
}

export function unpartitionedCookie(cookie: { partitionKey?: unknown; firstPartyDomain?: unknown }): boolean {
  return cookie.partitionKey == null && (cookie.firstPartyDomain === undefined || cookie.firstPartyDomain === '');
}

export function supportedPageContext(tab: { incognito?: boolean; cookieStoreId?: string }, firefox: boolean): string | undefined {
  if (tab.incognito) return `请在普通浏览窗口使用 ${LOCAL_LOGIN_EXTENSION_NAME} 浏览器扩展，隐私窗口不支持账号授权。`;
  if (firefox && tab.cookieStoreId !== FIREFOX_DEFAULT_STORE)
    return '请在 Firefox 普通窗口的默认标签页打开 monitor，并在默认标签页登录 B站；容器标签页暂不支持账号授权。';
  return undefined;
}

export function requiredBrowserPermissions(firefox: boolean, local: boolean) {
  const permissions: Browser.runtime.ManifestPermission[] = ['cookies', 'declarativeNetRequestWithHostAccess'];
  return {
    permissions,
    origins: ['https://*.bilibili.com/*', `${SITE_ORIGIN}/*`,
      ...(firefox ? ['wss://*.chat.bilibili.com/*'] : []),
      ...(local ? ['http://127.0.0.1/*', 'http://localhost/*'] : [])]
  };
}

export const AUDIO_CDN_ORIGINS = ['https://*.bilivideo.com/*', 'https://*.bilivideo.cn/*'];
/** Audio needs browser site access, not Cookie access or B站 account consent. */
export function audioBrowserPermissions(local: boolean) {
  const permissions: Browser.runtime.ManifestPermission[] = ['declarativeNetRequestWithHostAccess'];
  return { permissions, origins: ['https://api.live.bilibili.com/*', `${SITE_ORIGIN}/*`, ...AUDIO_CDN_ORIGINS,
    ...(local ? ['http://127.0.0.1/*', 'http://localhost/*'] : [])] };
}
export function audioPermissionRequest(firefox: boolean, local: boolean) {
  const required = audioBrowserPermissions(local);
  return firefox ? { origins: required.origins } : required;
}
export function audioOnlyPermissionRemoval(change: { permissions?: readonly string[]; origins?: readonly string[] }): boolean {
  return !change.permissions?.length && !!change.origins?.length && change.origins.every(origin =>
    /^https:\/\/(?:\*\.)?(?:[a-zA-Z0-9-]+\.)*bilivideo\.(?:com|cn)\/\*$/.test(origin));
}

/** Firefox only permits requesting optional permissions; MV3 host grants are requestable separately. */
export function authorizationPermissionRequest(firefox: boolean, local: boolean) {
  const required = requiredBrowserPermissions(firefox, local);
  const origins = [...required.origins, ...AUDIO_CDN_ORIGINS];
  return firefox ? { origins } : { ...required, origins };
}

/** Firefox DNR matches the underlying HTTPS upgrade channel, unlike its webRequest URL projection. */
export function danmakuWebsocketRegex(firefox: boolean): string {
  return `^${firefox ? '(wss|https)' : 'wss'}://([a-zA-Z0-9-]+[.])*chat[.]bilibili[.]com(:[0-9]+)?/sub([?][^#]*)?$`;
}
