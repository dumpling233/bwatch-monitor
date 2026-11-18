import { unpartitionedCookie } from './browserCompatibility';

const IDENTITY_NAMES = new Set(['SESSDATA', 'DedeUserID', 'DedeUserID__ckMd5']);
const API_ENDPOINTS = [
  ['api.bilibili.com', '/x/web-interface/nav'],
  ['api.live.bilibili.com', '/xlive/web-room/v2/index/getRoomPlayInfo'],
  ['api.live.bilibili.com', '/room/v1/Room/room_init'],
  ['api.live.bilibili.com', '/xlive/web-room/v1/index/getDanmuInfo'],
  ['api.live.bilibili.com', '/xlive/web-ucenter/v2/emoticon/GetEmoticons'],
  ['api.live.bilibili.com', '/xlive/app-ucenter/v1/fansMedal/panel'],
  ['api.live.bilibili.com', '/xlive/app-ucenter/v1/fansMedal/user_medal_info'],
  ['api.live.bilibili.com', '/xlive/app-ucenter/v1/fansMedal/wear'],
  ['api.live.bilibili.com', '/xlive/app-ucenter/v1/fansMedal/take_off'],
  ['api.live.bilibili.com', '/msg/send']
];

function relevant(cookie: chrome.cookies.Cookie): boolean {
  if (!unpartitionedCookie(cookie) || ![...IDENTITY_NAMES, 'bili_jct'].includes(cookie.name)) return false;
  const domain = cookie.domain.replace(/^\./, '').toLowerCase();
  return API_ENDPOINTS.some(([host, path]) =>
    (host === domain || !cookie.hostOnly && host.endsWith(`.${domain}`)) &&
    (path === cookie.path || path.startsWith(cookie.path) && (cookie.path.endsWith('/') || path[cookie.path.length] === '/')));
}
const key = (cookie: chrome.cookies.Cookie) => `${cookie.storeId}:${cookie.domain.toLowerCase()}:${cookie.path}:${cookie.name}`;

/** Observe only browser-local values; equal-value expiry refreshes are not account changes. */
export class CredentialCookieEvents {
  private readonly values = new Map<string, string>();
  private readonly stores = new Set<string>();
  constructor(private readonly options: { identityChanged(): void; writesChanged(): void; storeId?: string }) {}

  /** Seed from an already-authorized request, never read cookies to poll account state. */
  observe(cookies: chrome.cookies.Cookie[]): void {
    for (const cookie of cookies) {
      if (this.options.storeId !== undefined && cookie.storeId !== this.options.storeId) continue;
      this.stores.add(cookie.storeId);
      if (relevant(cookie) && !this.values.has(key(cookie))) this.remember(cookie);
    }
  }

  private remember(cookie: chrome.cookies.Cookie): void {
    this.values.set(key(cookie), cookie.value);
    while (this.values.size > 64) this.values.delete(this.values.keys().next().value!);
  }

  changed({ cookie, removed, cause }: chrome.cookies.CookieChangeInfo): void {
    if (this.options.storeId !== undefined && cookie.storeId !== this.options.storeId ||
      !relevant(cookie) || this.stores.size && !this.stores.has(cookie.storeId)) return;
    // Chrome emits an old-value removal followed by an addition for overwrite.
    // React to the final value; aborting the first event can cancel NAV's own
    // response merely because it renewed an unchanged cookie.
    if (removed && cause === 'overwrite') return;
    const previous = this.values.get(key(cookie));
    if (!removed && previous === cookie.value) return;
    if (removed && previous !== undefined && previous !== cookie.value) return;
    if (removed) this.values.delete(key(cookie)); else this.remember(cookie);
    if (cookie.name === 'bili_jct') this.options.writesChanged();
    else this.options.identityChanged();
  }
}
