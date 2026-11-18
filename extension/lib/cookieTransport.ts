import { isPlaybackQuality } from '../../shared/playback';
import { unpartitionedCookie } from './browserCompatibility';
import { AUDIO_USER_AGENT, isAudioApiUrl } from './audioApi';

const NAV = 'https://api.bilibili.com/x/web-interface/nav';
const PLAY = 'https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo';
const SESSION_NAMES = new Set(['SESSDATA', 'DedeUserID', 'DedeUserID__ckMd5']);
const RULE_IDS = [1, 101, 102];
const LOCAL_RULE_IDS = Array.from({ length: 32 }, (_, index) => 1000 + index);
const EXTRA_APIS = new Map([
  ['/x/frontend/finger/spi', 'api.bilibili.com'],
  ['/x/relation/followings', 'api.bilibili.com'],
  ['/live_user/v1/Master/info', 'api.live.bilibili.com'],
  ['/room/v1/Room/room_init', 'api.live.bilibili.com'], ['/room/v1/Room/get_info', 'api.live.bilibili.com'],
  ['/room/v1/Room/get_status_info_by_uids', 'api.live.bilibili.com'],
  ['/xlive/web-room/v1/index/getRoomBaseInfo', 'api.live.bilibili.com'],
  ['/xlive/general-interface/v1/rank/getOnlineGoldRank', 'api.live.bilibili.com'],
  ['/xlive/web-room/v1/index/getDanmuInfo', 'api.live.bilibili.com'],
  ['/xlive/web-room/v1/index/getInfoByUser', 'api.live.bilibili.com'],
  ['/xlive/app-ucenter/v1/fansMedal/panel', 'api.live.bilibili.com'],
  ['/xlive/app-ucenter/v1/fansMedal/user_medal_info', 'api.live.bilibili.com'],
  ['/xlive/app-ucenter/v1/fansMedal/wear', 'api.live.bilibili.com'],
  ['/xlive/app-ucenter/v1/fansMedal/take_off', 'api.live.bilibili.com'],
  ['/xlive/web-ucenter/v2/emoticon/GetEmoticons', 'api.live.bilibili.com'], ['/msg/send', 'api.live.bilibili.com']
]);
function localApi(url: URL): boolean {
  if (EXTRA_APIS.get(url.pathname) !== url.hostname) return false;
  const query = url.searchParams, keys = [...query.keys()], room = (name: string) => /^[1-9][0-9]{0,19}$/.test(query.get(name) ?? '');
  const exact = (names: string[]) => keys.length === names.length && keys.every(name => names.includes(name)) && new Set(keys).size === keys.length;
  if (url.pathname.endsWith('/spi') || url.pathname === '/msg/send' || url.pathname === '/room/v1/Room/get_status_info_by_uids' || ['/xlive/app-ucenter/v1/fansMedal/wear', '/xlive/app-ucenter/v1/fansMedal/take_off'].includes(url.pathname)) return exact([]);
  if (url.pathname === '/xlive/app-ucenter/v1/fansMedal/panel') return query.get('page_size') === '10' &&
    (exact(['page', 'page_size']) && /^[1-9][0-9]{0,3}$/.test(query.get('page') ?? '') && Number(query.get('page')) <= 1000 ||
      exact(['page', 'page_size', 'room_id', 'target_id']) && query.get('page') === '1' && room('room_id') && room('target_id'));
  if (url.pathname === '/xlive/app-ucenter/v1/fansMedal/user_medal_info') return exact(['uid', 'up_uid']) && room('uid') && room('up_uid');
  if (url.pathname === '/live_user/v1/Master/info') return exact(['uid']) && room('uid');
  if (url.pathname === '/x/relation/followings') return exact(['vmid', 'pn', 'ps', 'order']) && room('vmid') &&
    /^[1-9][0-9]{0,3}$/.test(query.get('pn') ?? '') && Number(query.get('pn')) <= 2000 && query.get('ps') === '50' && query.get('order') === 'desc';
  if (url.pathname.endsWith('/room_init')) return exact(['id']) && room('id');
  if (url.pathname.endsWith('/getRoomBaseInfo')) return exact(['req_biz', 'room_ids']) && query.get('req_biz') === 'web_room_componet' && room('room_ids');
  if (url.pathname.endsWith('/getOnlineGoldRank')) return exact(['ruid', 'roomId', 'page', 'pageSize']) && room('ruid') && room('roomId') && query.get('page') === '1' && query.get('pageSize') === '1';
  if (url.pathname.endsWith('/get_info') || url.pathname.endsWith('/getInfoByUser')) return exact(['room_id']) && room('room_id');
  if (url.pathname.endsWith('/GetEmoticons')) return exact(['platform', 'room_id']) && query.get('platform') === 'pc' && room('room_id');
  const signed = /^[0-9]{1,12}$/.test(query.get('wts') ?? '') && /^[a-f0-9]{32}$/.test(query.get('w_rid') ?? '');
  if (url.pathname.endsWith('/getDanmuInfo')) return exact(['id', 'type', 'wts', 'w_rid']) && room('id') && query.get('type') === '0' && signed;
  return false;
}
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const targets = [
  { id: 101, url: NAV, validationExpression: `^${escapeRegex(NAV)}$`, ruleExpression: `^${escapeRegex(NAV)}$` },
  { id: 102, url: PLAY,
    validationExpression: `^${escapeRegex(PLAY)}\\?room_id=[1-9][0-9]{0,19}&protocol=0%2C1&format=0%2C1%2C2&codec=0&qn=[1-9][0-9]{0,5}&platform=web&ptype=8$`,
    // Chrome RE2 rejects the complete parameter expression at its 2KB limit.
    // Validate parameters above before installing this exact API-path rule.
    ruleExpression: `^${escapeRegex(PLAY)}\\?[^#]*$` }
];

interface TransportOptions {
  extensionId: string;
  getCookies: (url: string) => Promise<chrome.cookies.Cookie[]>;
  updateRules: (options: chrome.declarativeNetRequest.UpdateRuleOptions) => Promise<void>;
  observeCookies?: (cookies: chrome.cookies.Cookie[]) => void;
  now?: () => number;
}

/** Session rules stay in the browser; raw cookie values never enter RPC/storage. */
export class LocalCookieTransport {
  private generation = 0;
  private clearedGeneration = -1;
  private serial: Promise<void> = Promise.resolve();
  private latestReset: Promise<void> = Promise.resolve();
  private readonly prepared = new Map<number, { promise: Promise<void>; until: number }>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly used = new Set<number>();
  private readonly active = new Set<AbortController>();
  private readonly writes = new Set<AbortController>();
  private writeGeneration = 0;
  private poisoned = false;
  private requests = 0;
  private readonly slots: Array<() => void> = [];
  constructor(private readonly options: TransportOptions) {}

  get writeEpoch(): number { return this.writeGeneration; }
  /** CSRF rotation invalidates pending writes without revoking the verified account or interrupting reads. */
  invalidateWrites(): void {
    this.writeGeneration++;
    for (const controller of this.writes) controller.abort();
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const result = this.serial.then(task);
    this.serial = result.catch(() => {});
    return result;
  }
  private current(generation: number): void {
    if (generation !== this.generation) throw new DOMException('会话已变化', 'AbortError');
  }
  private async clear(generation: number): Promise<void> {
    this.current(generation);
    await this.options.updateRules({ removeRuleIds: [...RULE_IDS, ...LOCAL_RULE_IDS] });
    this.current(generation);
    this.clearedGeneration = generation;
    this.poisoned = false;
  }
  /** Invalidate synchronously; serialize clearing before any new cookie install. */
  invalidate(): Promise<void> {
    this.invalidateWrites();
    const generation = ++this.generation;
    for (const controller of this.active) controller.abort();
    this.prepared.clear();
    const pending = this.enqueue(() => this.clear(generation));
    this.latestReset = pending;
    return pending;
  }
  /** Startup/revoke must follow a newer cookie reset instead of failing forever. */
  async reset(): Promise<void> {
    void this.invalidate().catch(() => {});
    for (;;) {
      const pending = this.latestReset;
      try { await pending; } catch (failure) {
        if (pending === this.latestReset) { this.poisoned = true; throw failure; }
      }
      if (pending === this.latestReset) return;
    }
  }
  /** One identity per exact URL/method until headers return; omit never relies on ambient cookies. */
  async run<T>(url: URL, mode: 'anonymous' | 'authenticated', signal: AbortSignal,
    operation: (cookies: Readonly<Record<string, string>>, signal: AbortSignal) => Promise<T>,
    options: { method?: 'GET' | 'POST'; buvid?: string } = {}): Promise<T> {
    if (this.poisoned) await this.reset();
    const method = options.method ?? 'GET';
    const audio = isAudioApiUrl(url);
    const readStatus = url.pathname === '/room/v1/Room/get_status_info_by_uids';
    const medalApi = url.pathname.startsWith('/xlive/app-ucenter/v1/fansMedal/');
    const medalWrite = medalApi && ['/xlive/app-ucenter/v1/fansMedal/wear', '/xlive/app-ucenter/v1/fansMedal/take_off'].includes(url.pathname);
    const publicFollowingRoom = ['/xlive/web-room/v1/index/getRoomBaseInfo', '/xlive/general-interface/v1/rank/getOnlineGoldRank'].includes(url.pathname);
    const allowed = targets.some(value => new RegExp(value.validationExpression).test(url.href)) || localApi(url) || audio;
    if (!allowed || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash ||
      url.href.length > 1800 || (method === 'POST') !== (url.pathname === '/msg/send' || readStatus || medalWrite) || audio && mode !== 'anonymous' || readStatus && mode !== 'anonymous' || publicFollowingRoom && mode !== 'anonymous' || medalApi && mode !== 'authenticated' ||
      url.pathname === '/x/relation/followings' && mode !== 'authenticated') throw new Error('不支持的本机接口');
    const generation = this.generation, controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) controller.abort();
    this.active.add(controller);
    if (method === 'POST' && !readStatus) this.writes.add(controller);
    const key = `${method}:${url.href}`, previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const lock = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.catch(() => {}).then(() => lock);
    this.locks.set(key, tail);
    let ruleId: number | undefined;
    let ownsSlot = false;
    try {
      // The caller's total timeout also covers waiting for a same-URL identity lease.
      await Promise.race([previous.catch(() => {}), new Promise<never>((_, reject) => {
        if (controller.signal.aborted) reject(new DOMException('请求已取消', 'AbortError'));
        else controller.signal.addEventListener('abort', () => reject(new DOMException('请求已取消', 'AbortError')), { once: true });
      })]);
      this.current(generation);
      if (controller.signal.aborted) throw new DOMException('请求已取消', 'AbortError');
      if (this.requests >= 4) await new Promise<void>((resolve, reject) => {
        const start = () => { controller.signal.removeEventListener('abort', aborted); this.requests++; ownsSlot = true; resolve(); };
        const aborted = () => { const index = this.slots.indexOf(start); if (index >= 0) this.slots.splice(index, 1);
          reject(new DOMException('请求已取消', 'AbortError')); };
        if (this.slots.length >= 64) { reject(new Error('本机请求繁忙')); return; }
        controller.signal.addEventListener('abort', aborted, { once: true });
        if (controller.signal.aborted) aborted(); else this.slots.push(start);
      }); else { this.requests++; ownsSlot = true; }
      this.current(generation);
      const selected: Record<string, string> = {};
      if (mode === 'authenticated') {
        const now = (this.options.now ?? Date.now)() / 1000;
        const cookies = await this.options.getCookies(url.href);
        this.current(generation);
        this.options.observeCookies?.(cookies);
        for (const cookie of cookies) {
          if (![...SESSION_NAMES, 'bili_jct', 'buvid3'].includes(cookie.name) || !unpartitionedCookie(cookie) ||
            (!cookie.session && cookie.expirationDate !== undefined && cookie.expirationDate <= now)) continue;
          if (cookie.value.length > 4096 || /[;\u0000-\u001f\u007f]/.test(cookie.value) || selected[cookie.name] !== undefined)
            throw new Error('本机会话格式暂不可用');
          selected[cookie.name] = cookie.value;
        }
      }
      if (options.buvid && !selected.buvid3) {
        if (!/^[a-zA-Z0-9._-]{1,200}$/.test(options.buvid)) throw new Error('设备标识格式无效');
        selected.buvid3 = options.buvid;
      }
      const cookieHeader = Object.entries(selected).map(([name, value]) => `${name}=${value}`).join('; ');
      if (cookieHeader.length > 8192) throw new Error('本机会话超出限制');
      await this.enqueue(async () => {
        this.current(generation);
        if (controller.signal.aborted) throw new DOMException('请求已取消', 'AbortError');
        ruleId = LOCAL_RULE_IDS.find(id => !this.used.has(id));
        if (ruleId === undefined) throw new Error('本机请求繁忙');
        this.used.add(ruleId);
        await this.options.updateRules({ removeRuleIds: [ruleId], addRules: [{ id: ruleId, priority: 10,
          action: { type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType, requestHeaders: [
            { header: 'Cookie', operation: (cookieHeader ? 'set' : 'remove') as chrome.declarativeNetRequest.HeaderOperation,
              ...(cookieHeader ? { value: cookieHeader } : {}) },
            ...(audio ? [
              { header: 'User-Agent', operation: 'set' as chrome.declarativeNetRequest.HeaderOperation, value: AUDIO_USER_AGENT },
              { header: 'Origin', operation: 'remove' as chrome.declarativeNetRequest.HeaderOperation },
              { header: 'Referer', operation: 'remove' as chrome.declarativeNetRequest.HeaderOperation }
            ] : [
              { header: 'Origin', operation: 'set' as chrome.declarativeNetRequest.HeaderOperation, value: 'https://live.bilibili.com' },
              { header: 'Referer', operation: 'set' as chrome.declarativeNetRequest.HeaderOperation, value: 'https://live.bilibili.com/' }
            ])
          ] }, condition: { initiatorDomains: [this.options.extensionId], requestDomains: [url.hostname],
            requestMethods: [method.toLowerCase() as chrome.declarativeNetRequest.RequestMethod],
            resourceTypes: ['xmlhttprequest' as chrome.declarativeNetRequest.ResourceType],
            regexFilter: `^${escapeRegex(url.href)}$`, isUrlFilterCaseSensitive: true } }] });
        this.current(generation);
      });
      if (controller.signal.aborted) throw new DOMException('请求已取消', 'AbortError');
      return await operation(Object.freeze(selected), controller.signal);
    } finally {
      try {
        if (ruleId !== undefined) {
          const id = ruleId;
          try { await this.enqueue(async () => { await this.options.updateRules({ removeRuleIds: [id] }); this.used.delete(id); }); }
          catch (error) { this.poisoned = true; void this.invalidate().catch(() => {}); throw error; }
        }
      } finally {
        release();
        if (this.locks.get(key) === tail) this.locks.delete(key);
        this.active.delete(controller);
        this.writes.delete(controller);
        signal.removeEventListener('abort', abort);
        if (ownsSlot) { this.requests--; this.slots.shift()?.(); }
      }
    }
  }
  async prepare(url: URL, signal: AbortSignal): Promise<void> {
    const target = targets.find(value => new RegExp(value.validationExpression).test(url.href));
    if (!target || (target.id === 102 && !isPlaybackQuality(Number(url.searchParams.get('qn'))))) throw new Error('不支持的本机认证接口');
    if (signal.aborted) throw new DOMException('请求已取消', 'AbortError');
    const generation = this.generation;
    const nowMs = () => (this.options.now ?? Date.now)();
    let entry = this.prepared.get(target.id);
    if (entry && entry.until <= nowMs()) { this.prepared.delete(target.id); entry = undefined; }
    if (!entry) {
      const created = { promise: Promise.resolve(), until: Infinity };
      created.promise = (async () => {
        const cookies = await this.options.getCookies(target.url);
        this.current(generation);
        const now = nowMs() / 1000;
        const selected = cookies.filter(cookie => SESSION_NAMES.has(cookie.name) && unpartitionedCookie(cookie) &&
          (cookie.session || cookie.expirationDate === undefined || cookie.expirationDate > now));
        if (selected.length > 16 || selected.some(cookie => cookie.value.length > 4096 || /[;\u0000-\u001f\u007f]/.test(cookie.value)))
          throw new Error('本机会话格式暂不可用');
        // Preserve exact cookie bytes. Do not decode, trim or serialize values.
        const cookieHeader = selected.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
        if (cookieHeader.length > 8192) throw new Error('本机会话超出限制');
        created.until = Math.min(nowMs() + 60_000, ...selected.map(cookie =>
          !cookie.session && cookie.expirationDate !== undefined ? cookie.expirationDate * 1000 : Infinity));
        await this.enqueue(async () => {
          this.current(generation);
          if (this.clearedGeneration !== generation) await this.clear(generation);
          this.current(generation);
          await this.options.updateRules({ removeRuleIds: [target.id], addRules: [{
            id: target.id, priority: 1,
            action: { type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
              requestHeaders: [
                { header: 'Referer', operation: 'set' as chrome.declarativeNetRequest.HeaderOperation, value: 'https://live.bilibili.com/' },
                { header: 'Origin', operation: 'set' as chrome.declarativeNetRequest.HeaderOperation, value: 'https://live.bilibili.com' },
                ...(cookieHeader ? [{ header: 'Cookie', operation: 'set' as chrome.declarativeNetRequest.HeaderOperation, value: cookieHeader }] : [])
              ] },
            condition: { initiatorDomains: [this.options.extensionId], requestDomains: [new URL(target.url).hostname],
              requestMethods: ['get' as chrome.declarativeNetRequest.RequestMethod],
              resourceTypes: ['xmlhttprequest' as chrome.declarativeNetRequest.ResourceType],
              regexFilter: target.ruleExpression, isUrlFilterCaseSensitive: true }
          }] });
          this.current(generation);
        });
      })();
      this.prepared.set(target.id, created);
      entry = created;
      void created.promise.catch(() => { if (this.prepared.get(target.id) === created) this.prepared.delete(target.id); });
    }
    await entry.promise;
    this.current(generation);
    if (signal.aborted) throw new DOMException('请求已取消', 'AbortError');
    if (entry.until <= nowMs()) {
      if (this.prepared.get(target.id) === entry) this.prepared.delete(target.id);
      await this.prepare(url, signal);
    }
  }
}
