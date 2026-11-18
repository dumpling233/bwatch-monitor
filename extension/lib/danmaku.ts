import type { LocalChatContext, LocalDanmakuBootstrap, LocalDanmakuSendResult, LocalPublicProfile } from '../../shared/localDanmaku';
import { AccountVerificationRequired, BrokerError, LocalLoginBroker } from './broker';
import { LocalCookieTransport } from './cookieTransport';
import { LoginSessions } from './loginSessions';
import { signWbi, wbiKey } from './wbi';
import { projectEmoticons } from './emoticons';
import { EmoticonCatalog } from './emoticonCatalog';
import { PublicAvatarCache } from './publicAvatarCache';

type Json = Record<string, unknown>;
type Storage = { get(keys: string[]): Promise<Record<string, unknown>>; set(values: Record<string, unknown>): Promise<void> };
type Ledger = LocalDanmakuSendResult & { origin: string; roomId: string; accountUid: string; at: number };
class UpstreamRejection extends Error {}
const LEDGER_KEY = 'bwatchMonitorDanmakuSendLedger';
const NAV = 'https://api.bilibili.com/x/web-interface/nav';
const SPI = 'https://api.bilibili.com/x/frontend/finger/spi';
const ROOT = 'https://api.live.bilibili.com';
const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const id = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
const text = (value: unknown, max = 200): string => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max) : '';
const failure = (message: string) => new BrokerError('UNAVAILABLE', message);
const image = (value: unknown): string => {
  if (typeof value !== 'string' || value.length > 2048) return '';
  try { const url = new URL(value.replace(/^\/\//, 'https://'));
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      (url.hostname === 'hdslb.com' || url.hostname.endsWith('.hdslb.com')) ? url.href : '';
  } catch { return ''; }
};

/** Small HTTP only. The page owns WSS; no credential-bearing object crosses the bridge. */
export class LocalDanmakuService {
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly contexts = new Map<string, { context: LocalChatContext; until: number }>();
  private readonly bootstraps = new Map<string, { value: LocalDanmakuBootstrap; until: number }>();
  private readonly missingProfiles = new Map<string, { value: LocalPublicProfile; until: number }>();
  private readonly avatars: PublicAvatarCache;
  private readonly work = new Map<string, Promise<unknown>>();
  private readonly ledger = new Map<string, Ledger>();
  private ledgerSerial: Promise<unknown> = Promise.resolve();
  private device?: { value: string; until: number };
  private signing?: { value: string; until: number };
  private active = 0;
  private queue: Array<() => void> = [];
  private blockedUntil = 0;
  private profileBlockedUntil = 0;
  private profileGeneration = 0;
  private readonly nextSend = new Map<string, number>();
  private readonly bootstrapRefresh = new Map<string, number>();
  private profileWindow = { at: 0, count: 0 };
  private profileActive = 0;
  private contextGeneration = 0;
  private readonly catalog: EmoticonCatalog;
  readonly ready: Promise<void>;
  constructor(private readonly options: { transport: LocalCookieTransport; sessions: LoginSessions; broker: LocalLoginBroker;
    storage: Storage; catalogStorage?: Storage; fetch?: typeof fetch; now?: () => number }) {
    this.fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.now = options.now ?? Date.now;
    this.catalog = new EmoticonCatalog(options.catalogStorage, this.now);
    this.avatars = new PublicAvatarCache(options.catalogStorage, this.now);
    this.ready = this.restoreLedger();
  }
  invalidate(): void {
    this.contexts.clear(); this.bootstraps.clear(); this.missingProfiles.clear(); this.profileGeneration++; this.avatars.clear();
    this.contextGeneration++; this.catalog.clear();
  }
  private async restoreLedger(): Promise<void> {
    const stored = await this.options.storage.get([LEDGER_KEY]);
    const rows = stored[LEDGER_KEY];
    if (!Array.isArray(rows)) return;
    for (const row of rows.slice(-64)) {
      const value = object(row);
      if (typeof value.origin !== 'string' || !id(value.roomId) || !id(value.accountUid) ||
        typeof value.operationId !== 'string' || !/^[\w:-]{8,100}$/.test(value.operationId) ||
        typeof value.at !== 'number' || value.at < this.now() - 600_000 || value.at > this.now() ||
        !['dispatching', 'submitted', 'rejected', 'unknown'].includes(String(value.status))) continue;
      this.ledger.set(`${value.origin}:${value.operationId}`, { origin: value.origin, roomId: value.roomId, accountUid: value.accountUid,
        operationId: value.operationId, at: value.at, status: value.status === 'dispatching' ? 'unknown' : value.status as Ledger['status'],
        ...(value.status === 'dispatching' ? { message: '发送结果未确认，请先检查直播间，避免重复发送' } : {}) });
    }
  }
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const result = this.ledgerSerial.then(task, task); this.ledgerSerial = result.catch(() => {}); return result;
  }
  private persist(): Promise<void> {
    // Upstream error text can echo submitted text; persist status only, never its message.
    return this.options.storage.set({ [LEDGER_KEY]: [...this.ledger.values()].map(({ message: _message, ...row }) => row) });
  }
  private async bounded<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    if (this.active >= 4) await new Promise<void>((resolve, reject) => {
      const start = () => { signal.removeEventListener('abort', abort); this.active++; resolve(); };
      const abort = () => { this.queue = this.queue.filter(item => item !== start); reject(new DOMException('请求已取消', 'AbortError')); };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort(); else this.queue.push(start);
    }); else this.active++;
    try { if (signal.aborted) throw new DOMException('请求已取消', 'AbortError'); return await task(); }
    finally { this.active--; this.queue.shift()?.(); }
  }
  private async request(url: URL, mode: 'anonymous' | 'authenticated', signal: AbortSignal,
    options: { allowAnonymousNav?: boolean; profile?: boolean; buvid?: string; onDevice?(value: string): void;
      send?: { roomId: string; accountUid: string; message: string; dmType: number; beforePost(): void } } = {}): Promise<Json> {
    const blockedUntil = Math.max(this.blockedUntil, options.profile ? this.profileBlockedUntil : 0);
    if (blockedUntil > this.now()) throw new BrokerError('RATE_LIMITED', 'B站暂时限制请求，请稍后重试', Math.ceil((blockedUntil - this.now()) / 1000));
    return this.bounded(signal, () => this.options.transport.run(url, mode, signal, async (cookies, requestSignal) => {
      if (cookies.buvid3) options.onDevice?.(cookies.buvid3);
      let body: URLSearchParams | undefined;
      if (options.send) {
        if (!cookies.SESSDATA || !cookies.bili_jct) throw new BrokerError('INVALID_REQUEST', '本机发送凭据暂不可用，请稍后再试或检查 B站登录');
        if (cookies.DedeUserID !== options.send.accountUid) throw new BrokerError('ACCOUNT_CHANGED', 'B站账号已变化，此次发送已停止');
        options.send.beforePost();
        body = new URLSearchParams({ roomid: options.send.roomId, msg: options.send.message,
          dm_type: String(options.send.dmType), rnd: String(Math.floor(this.now() / 1000)), fontsize: '25',
          color: '16777215', mode: '1', bubble: '0', csrf: cookies.bili_jct, csrf_token: cookies.bili_jct });
      }
      // URL parameters are generated locally; no webpage can choose a destination or CSRF.
      const response = await this.fetch(url, { method: body ? 'POST' : 'GET', credentials: 'omit', redirect: 'error',
        signal: requestSignal, headers: { accept: 'application/json' }, ...(body ? { body } : {}) });
      if (Number(response.headers.get('content-length')) > 2 * 1024 * 1024) {
        await response.body?.cancel(); throw failure('B站响应超出限制');
      }
      const value = await response.text();
      if (value.length > 2 * 1024 * 1024) throw failure('B站响应超出限制');
      let payload: Json; try { payload = object(JSON.parse(value)); } catch { throw failure('B站响应格式异常'); }
      const code = Number(payload.code);
      if ([403, 412, 429].includes(response.status) || [-403, -412, -429, -352].includes(code)) {
        const retry = Number(response.headers.get('retry-after'));
        const seconds = Number.isFinite(retry) && retry > 0 ? Math.min(86400, Math.max(30, retry)) : 30;
        if (options.profile) this.profileBlockedUntil = this.now() + seconds * 1000;
        else { this.blockedUntil = this.now() + seconds * 1000; this.signing = undefined; }
        throw new BrokerError('RATE_LIMITED', 'B站要求验证或暂时限制请求，请在 B站完成验证', seconds);
      }
      if (!response.ok) throw failure('B站接口暂不可用');
      if (code === -101 && options.allowAnonymousNav) return payload;
      if (code === -101) throw new AccountVerificationRequired();
      if (code === -111) throw new UpstreamRejection('B站发送验证未通过，请稍后重试；账号授权仍保留');
      if (code !== 0) throw new UpstreamRejection(text(payload.message ?? payload.msg) || 'B站未接受请求');
      return payload;
    }, { method: options.send ? 'POST' : 'GET', buvid: options.buvid }));
  }
  private async shared<T>(key: string, signal: AbortSignal, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (signal.aborted) throw new DOMException('请求已取消', 'AbortError');
    let work = this.work.get(key) as Promise<T> | undefined;
    if (!work) {
      if (this.work.size >= 32) throw failure('本机弹幕请求繁忙，请稍后重试');
      work = task(AbortSignal.timeout(12_000)).finally(() => { if (this.work.get(key) === work) this.work.delete(key); });
      this.work.set(key, work);
    }
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(new DOMException('请求已取消', 'AbortError'));
      signal.addEventListener('abort', abort, { once: true });
      work!.then(value => resolve(structuredClone(value)), reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }
  private async identity(signal: AbortSignal): Promise<string> {
    if (this.device && this.device.until > this.now()) return this.device.value;
    return this.shared('device', signal, async inner => {
      const response = await this.request(new URL(SPI), 'anonymous', inner);
      const value = object(response.data).b_3;
      if (typeof value !== 'string' || !/^[\w.-]{1,200}$/.test(value)) throw failure('B站设备标识暂不可用');
      this.device = { value, until: this.now() + 600_000 }; return value;
    });
  }
  private async signingKey(signal: AbortSignal): Promise<string> {
    if (this.signing && this.signing.until > this.now()) return this.signing.value;
    return this.shared('wbi', signal, async inner => {
      const response = await this.request(new URL(NAV), 'anonymous', inner, { allowAnonymousNav: true });
      const images = object(object(response.data).wbi_img);
      const value = wbiKey(images.img_url, images.sub_url);
      this.signing = { value, until: this.now() + 600_000 }; return value;
    });
  }
  private async realRoom(roomId: unknown, mode: 'anonymous' | 'authenticated', signal: AbortSignal): Promise<string> {
    if (!id(roomId)) throw new BrokerError('INVALID_REQUEST', '无效的直播间');
    const url = new URL(`${ROOT}/room/v1/Room/room_init`); url.searchParams.set('id', roomId);
    const response = await this.request(url, mode, signal), resolved = object(response.data).room_id;
    const result = typeof resolved === 'number' && Number.isSafeInteger(resolved) ? String(resolved) : resolved;
    if (!id(result)) throw failure('直播间信息暂不可用'); return result;
  }
  async resolve(origin: string, input: { roomId?: string; mode?: string; authEpoch?: string; force?: boolean }, signal: AbortSignal): Promise<LocalDanmakuBootstrap> {
    if (!id(input.roomId) || !['anonymous', 'authenticated'].includes(input.mode ?? '') ||
      (input.force !== undefined && typeof input.force !== 'boolean')) throw new BrokerError('INVALID_REQUEST', '无效的弹幕参数');
    const mode = input.mode as 'anonymous' | 'authenticated';
    const session = mode === 'authenticated' ? await this.options.sessions.requireDanmaku(origin, input.authEpoch, signal) : undefined;
    const epoch = this.options.broker.authEpoch, accountUid = session?.account?.uid;
    const key = `${mode}:${epoch}:${accountUid ?? '0'}:${input.roomId}`;
    const cached = this.bootstraps.get(key);
    if (!input.force && cached && cached.until > this.now()) return structuredClone(cached.value);
    if (input.force && !this.work.has(key)) {
      for (const [room, until] of this.bootstrapRefresh) if (until <= this.now()) this.bootstrapRefresh.delete(room);
      const until = this.bootstrapRefresh.get(input.roomId) ?? 0;
      if (until > this.now()) throw new BrokerError('RATE_LIMITED', '弹幕重新连接过于频繁，请稍后重试', Math.ceil((until - this.now()) / 1000));
      if (this.bootstrapRefresh.size >= 128) throw failure('弹幕初始化请求繁忙');
      this.bootstrapRefresh.set(input.roomId, this.now() + 5000);
    }
    let value: LocalDanmakuBootstrap;
    try { value = await this.shared(key, signal, async inner => {
      const roomId = await this.realRoom(input.roomId, mode, inner);
      const [buvid, signing] = await Promise.all([this.identity(inner), this.signingKey(inner)]);
      if (mode === 'authenticated') this.options.sessions.assertDanmakuCurrent(origin, epoch, accountUid!);
      const url = new URL(`${ROOT}/xlive/web-room/v1/index/getDanmuInfo`); url.search = signWbi({ id: roomId, type: 0 }, signing, this.now()).toString();
      let usedBuvid = buvid;
      const response = await this.request(url, mode, inner, { buvid, onDevice: value => { usedBuvid = value; } }), data = object(response.data);
      const token = data.token;
      if (typeof token !== 'string' || !token || token.length > 4096 || /[\u0000-\u001f\u007f]/.test(token)) throw failure('弹幕认证暂不可用');
      const hosts: LocalDanmakuBootstrap['hosts'] = [];
      for (const value of (Array.isArray(data.host_list) ? data.host_list : []).slice(0, 16)) {
        const item = object(value), host = item.host, port = item.wss_port;
        if (typeof host !== 'string' || !/^[a-z0-9.-]{1,253}$/i.test(host) ||
          !(host === 'chat.bilibili.com' || host.endsWith('.chat.bilibili.com')) ||
          typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) continue;
        const endpoint = `wss://${host}${port === 443 ? '' : `:${port}`}/sub`;
        if (!hosts.some(item => item.url === endpoint)) hosts.push({ host, wssPort: port, url: endpoint });
        if (hosts.length === 8) break;
      }
      if (!hosts.length) throw failure('弹幕线路暂不可用');
      if (mode === 'authenticated') this.options.sessions.assertDanmakuCurrent(origin, epoch, accountUid!);
      const result: LocalDanmakuBootstrap = { requestedRoomId: input.roomId!, roomId, hosts, token, buvid: usedBuvid,
        resolvedAt: this.now(), mode, uid: accountUid ?? '0', authEpoch: epoch, ...(accountUid ? { accountUid } : {}) };
      this.bootstraps.set(key, { value: result, until: this.now() + 15_000 });
      while (this.bootstraps.size > 32) this.bootstraps.delete(this.bootstraps.keys().next().value!);
      return result;
    }); } catch (error) { if (error instanceof AccountVerificationRequired && mode === 'authenticated') await this.options.sessions.verifyAccountRejection(origin, epoch); throw error; }
    if (mode === 'authenticated') this.options.sessions.assertDanmakuCurrent(origin, epoch, accountUid!);
    return value;
  }
  async context(origin: string, input: { roomId?: string; authEpoch?: string; force?: boolean }, signal: AbortSignal, force = false): Promise<LocalChatContext> {
    if (!id(input.roomId) || (input.force !== undefined && typeof input.force !== 'boolean')) throw new BrokerError('INVALID_REQUEST', '无效的直播间或表情更新参数');
    force = force || input.force === true;
    const session = await this.options.sessions.requireChat(origin, input.authEpoch, signal);
    const accountUid = session.account!.uid!, epoch = session.account!.authEpoch;
    const generation = this.contextGeneration;
    await this.catalog.ready;
    this.options.sessions.assertChatCurrent(origin, epoch, accountUid);
    if (signal.aborted || generation !== this.contextGeneration) throw new DOMException('请求已取消', 'AbortError');
    const cacheKey = `${origin}:${epoch}:${input.roomId}`, cached = this.contexts.get(cacheKey);
    if (!force && cached && cached.until > this.now()) return structuredClone(cached.context);
    const display = this.catalog.peek(accountUid, input.roomId);
    const remember = (context: LocalChatContext, ttl: number) => {
      this.contexts.delete(cacheKey); this.contexts.set(cacheKey, { context, until: this.now() + ttl });
      while (this.contexts.size > 16 || [...this.contexts.values()].reduce((size, value) => size + JSON.stringify(value.context).length * 2, 0) > 2 * 1024 * 1024)
        this.contexts.delete(this.contexts.keys().next().value!);
    };
    const displayContext = (failedRefresh = false, activeSignal = signal): LocalChatContext => {
      this.options.sessions.assertChatCurrent(origin, epoch, accountUid);
      if (activeSignal.aborted || generation !== this.contextGeneration || !display) throw new DOMException('请求已取消', 'AbortError');
      this.catalog.touch(accountUid, display.roomId);
      const context: LocalChatContext = { roomId: display.roomId, accountUid, authEpoch: epoch, ...display.directory,
        emoticonsAvailable: true, emoticonsCached: true, emoticonPermissionsVerified: false };
      if (failedRefresh) remember(context, 60_000);
      return context;
    };
    if (!force && display?.fresh) return displayContext();
    let result: LocalChatContext;
    try { result = await this.shared(`${cacheKey}:context:${generation}:${force ? 'fresh' : 'display'}`, signal, async inner => {
      const roomId = await this.realRoom(input.roomId, 'authenticated', inner);
      const url = new URL(`${ROOT}/xlive/web-ucenter/v2/emoticon/GetEmoticons`);
      url.search = new URLSearchParams({ platform: 'pc', room_id: roomId }).toString();
      let packages: unknown[] = [], directoryAvailable = false;
      try {
        if (inner.aborted || generation !== this.contextGeneration) throw new DOMException('请求已取消', 'AbortError');
        const buvid = await this.identity(inner);
        this.options.sessions.assertChatCurrent(origin, epoch, accountUid);
        const response = await this.request(url, 'authenticated', inner, { buvid });
        const value = object(response.data).data;
        if (Array.isArray(value)) { packages = value; directoryAvailable = true; }
      } catch (error) {
        if (inner.aborted || error instanceof AccountVerificationRequired || (error instanceof BrokerError && ['LOGGED_OUT', 'RATE_LIMITED'].includes(error.code))) throw error;
        // An optional directory outage removes image-send permission, not ordinary text capability.
      }
      const context: LocalChatContext = { roomId, accountUid, authEpoch: epoch, ...projectEmoticons(packages),
        emoticonsAvailable: directoryAvailable, emoticonPermissionsVerified: directoryAvailable, emoticonsCached: false };
      // requireChat already verifies the account. No confirmed getInfoByUser
      // fields are consumed, so do not spend another request on a preflight;
      // actual send permission is decided by the official POST response.
      this.options.sessions.assertChatCurrent(origin, epoch, accountUid);
      if (inner.aborted || generation !== this.contextGeneration) throw new DOMException('请求已取消', 'AbortError');
      // Display snapshots never grant send permission. A forced read must return
      // its real result, including failure, instead of an old unlocked snapshot.
      if (directoryAvailable) {
        remember(context, 30_000);
        await this.catalog.set(accountUid, roomId, input.roomId!, context);
      }
      else this.contexts.delete(cacheKey);
      return !force && !directoryAvailable && display ? displayContext(true, inner) : context;
    }); } catch (error) {
      if (error instanceof AccountVerificationRequired) await this.options.sessions.verifyAccountRejection(origin, epoch);
      if (!force && display && !signal.aborted && generation === this.contextGeneration && !(error instanceof AccountVerificationRequired) &&
        !(error instanceof DOMException && error.name === 'AbortError') &&
        !(error instanceof BrokerError && ['ACCOUNT_CHANGED', 'LOGGED_OUT', 'UNAUTHORIZED', 'STATE_CONFLICT'].includes(error.code))) return displayContext(true);
      throw error;
    }
    this.options.sessions.assertChatCurrent(origin, epoch, accountUid);
    if (signal.aborted || generation !== this.contextGeneration) throw new DOMException('请求已取消', 'AbortError');
    return result;
  }
  async profile(uid: unknown, signal: AbortSignal): Promise<LocalPublicProfile> {
    if (!id(uid)) throw new BrokerError('INVALID_REQUEST', '无效的用户');
    if (signal.aborted) throw new DOMException('请求已取消', 'AbortError');
    const initialGeneration = this.profileGeneration;
    await this.avatars.ready;
    if (signal.aborted || initialGeneration !== this.profileGeneration) throw new DOMException('会话已变化', 'AbortError');
    const avatar = this.avatars.get(uid);
    if (avatar) return avatar;
    const cached = this.missingProfiles.get(uid);
    if (cached && cached.until > this.now()) {
      this.missingProfiles.delete(uid); this.missingProfiles.set(uid, cached);
      return structuredClone(cached.value);
    }
    this.missingProfiles.delete(uid);
    const generation = this.profileGeneration;
    return this.shared(`profile:${generation}:${uid}`, signal, async inner => {
      const blockedUntil = Math.max(this.blockedUntil, this.profileBlockedUntil);
      if (blockedUntil > this.now()) throw new BrokerError('RATE_LIMITED', 'B站暂时限制请求，请稍后重试', Math.ceil((blockedUntil - this.now()) / 1000));
      if (this.profileActive >= 2) throw new BrokerError('RATE_LIMITED', '用户资料请求繁忙，请稍后重试', 1);
      this.profileActive++;
      try {
      if (this.profileWindow.at <= this.now() - 60_000) this.profileWindow = { at: this.now(), count: 0 };
      if (this.profileWindow.count >= 20) throw new BrokerError('RATE_LIMITED', '用户资料请求过于频繁，请稍后重试', Math.max(1, Math.ceil((this.profileWindow.at + 60_000 - this.now()) / 1000)));
      this.profileWindow.count++;
      // The public live user card works for viewers without an opened live room.
      // Avoid the space profile's WBI/fingerprint requirements for a small avatar.
      const url = new URL(`${ROOT}/live_user/v1/Master/info`); url.searchParams.set('uid', uid);
      const data = object(object((await this.request(url, 'anonymous', inner, { profile: true })).data).info);
      const resolvedUid = typeof data.uid === 'number' && Number.isSafeInteger(data.uid) ? String(data.uid) : data.uid;
      if (resolvedUid !== uid || typeof data.uname !== 'string' || typeof data.face !== 'string') throw failure('用户头像资料暂不可用');
      if (generation !== this.profileGeneration) throw new DOMException('会话已变化', 'AbortError');
      const result: LocalPublicProfile = { uid, name: text(data.uname, 100), face: image(data.face) };
      // This endpoint's master_level is a streamer level, not a user level or room role.
      if (result.face) result.avatarFetchedAt = this.avatars.set(uid, result.face);
      else {
        this.missingProfiles.set(uid, { value: { uid, face: '' }, until: this.now() + 600_000 });
        while (this.missingProfiles.size > 512) this.missingProfiles.delete(this.missingProfiles.keys().next().value!);
      }
      return result;
      } finally { this.profileActive--; }
    });
  }
  private projection(row: Ledger): LocalDanmakuSendResult { return { operationId: row.operationId, status: row.status, ...(row.message ? { message: row.message } : {}) }; }
  async result(origin: string, operationId: unknown): Promise<LocalDanmakuSendResult> {
    await this.ready;
    if (typeof operationId !== 'string' || !/^[\w:-]{8,100}$/.test(operationId)) throw new BrokerError('INVALID_REQUEST', '无效的发送编号');
    const unknown = (): LocalDanmakuSendResult => ({ operationId, status: 'unknown', message: '无法确认此次发送结果，请先查看直播间' });
    const key = `${origin}:${operationId}`, row = this.ledger.get(key), initial = this.options.sessions.read(origin);
    const current = () => {
      const state = this.options.sessions.read(origin);
      return row && this.ledger.get(key) === row && row.at >= this.now() - 600_000 && state.revision === initial.revision &&
        state.authorizationVersion === 2 && state.granted && state.connectionWanted && state.playbackWanted && state.chatWanted && row.accountUid === state.expectedUid;
    };
    if (!current() || !row) return unknown();
    // A lost page response can race an already-dispatched bounded POST. Join
    // only that existing task; a restarted worker has no task and must preserve
    // its restored unknown result. Never poll, retry or create upstream work.
    const pending = this.work.get(`send:${key}`);
    if (pending) await pending.catch(() => {});
    if (!current()) return unknown();
    return this.projection(row);
  }
  async send(origin: string, input: { roomId?: string; authEpoch?: string; operationId?: string; text?: string; emoticonUnique?: string }, signal: AbortSignal): Promise<LocalDanmakuSendResult> {
    await this.ready;
    const writeEpoch = this.options.transport.writeEpoch;
    if (!id(input.roomId) || typeof input.operationId !== 'string' || !/^[\w:-]{8,100}$/.test(input.operationId) ||
      (input.text !== undefined && typeof input.text !== 'string') || (input.emoticonUnique !== undefined && typeof input.emoticonUnique !== 'string') ||
      (typeof input.text === 'string') === (typeof input.emoticonUnique === 'string') ||
      (input.text !== undefined && (!input.text.trim() || input.text.length > 1000 || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(input.text))) ||
      (input.emoticonUnique !== undefined && (!input.emoticonUnique || input.emoticonUnique.length > 200)))
      throw new BrokerError('INVALID_REQUEST', '弹幕内容或发送编号无效');
    const session = await this.options.sessions.requireChat(origin, input.authEpoch, signal), accountUid = session.account!.uid!;
    const ledgerKey = `${origin}:${input.operationId}`;
    const previous = this.ledger.get(ledgerKey);
    if (previous) {
      if (previous.roomId !== input.roomId || previous.accountUid !== accountUid) throw new BrokerError('STATE_CONFLICT', '发送编号已用于其他房间或账号');
      return this.projection(previous);
    }
    const cachedContext = this.contexts.get(`${origin}:${session.account!.authEpoch}:${input.roomId}`);
    const context: LocalChatContext = input.emoticonUnique !== undefined ? await this.context(origin, input, signal, true)
      : cachedContext && cachedContext.until > this.now() ? cachedContext.context
      : { roomId: await this.realRoom(input.roomId, 'authenticated', signal), accountUid, authEpoch: session.account!.authEpoch, emoticons: [] };
    let message = input.text!, dmType = 0;
    if (input.emoticonUnique !== undefined) {
      const emote = context.emoticons.find(item => item.unique === input.emoticonUnique);
      if (context.emoticonPermissionsVerified !== true || !emote || emote.kind !== 'image' || !emote.permitted) throw new BrokerError('INVALID_REQUEST',
        emote?.unlockHint || (context.emoticonsAvailable === false ? '表情目录暂不可用，未发送该表情' : '当前账号在此直播间未解锁该表情'));
      message = emote.unique; dmType = 1;
    } else if (context.maxLength !== undefined && Array.from(message).length > context.maxLength) throw new BrokerError('INVALID_REQUEST', `当前直播间最多可发送 ${context.maxLength} 个字`);
    const key = `${accountUid}:${context.roomId}`;
    const reservation = await this.serial(async () => {
      const duplicate = this.ledger.get(ledgerKey); if (duplicate) return { row: duplicate, created: false };
      for (const [room, until] of this.nextSend) if (until <= this.now()) this.nextSend.delete(room);
      if (this.nextSend.size >= 128) throw failure('发送请求繁忙，请稍后重试');
      if ((this.nextSend.get(key) ?? 0) > this.now()) throw new BrokerError('RATE_LIMITED', '发送过于频繁，请稍后重试', Math.ceil((this.nextSend.get(key)! - this.now()) / 1000));
      for (const [key, value] of this.ledger) if (value.at < this.now() - 600_000) this.ledger.delete(key);
      while (this.ledger.size >= 64) {
        const expired = [...this.ledger].find(([, value]) => value.status !== 'dispatching');
        if (!expired) throw failure('发送请求繁忙，请稍后重试'); this.ledger.delete(expired[0]);
      }
      const row: Ledger = { origin, roomId: input.roomId!, accountUid, operationId: input.operationId!, status: 'dispatching', at: this.now() };
      this.ledger.set(ledgerKey, row);
      try { await this.persist(); } catch { this.ledger.delete(ledgerKey); throw failure('无法记录此次发送，请稍后重试'); }
      this.nextSend.set(key, this.now() + Math.max(1000, (context.cooldownSeconds ?? 1) * 1000));
      return { row, created: true };
    });
    const row = reservation.row;
    if (!reservation.created) return this.projection(row);
    let dispatched = false;
    const work = (async () => {
      try {
        const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
        const url = new URL(`${ROOT}/msg/send`);
        const payload = await this.request(url, 'authenticated', requestSignal, { buvid: await this.identity(requestSignal), send: { roomId: context.roomId, accountUid, message, dmType,
          beforePost: () => { this.options.sessions.assertChatCurrent(origin, input.authEpoch, accountUid);
            if (requestSignal.aborted || writeEpoch !== this.options.transport.writeEpoch) throw new DOMException('发送凭据已变化，请重新提交', 'AbortError');
            dispatched = true; } } });
        for (const section of [payload, object(payload.data)]) for (const name of ['message', 'msg'])
          if (![undefined, null, '', 0, '0'].includes(section[name] as never)) throw new UpstreamRejection(section[name] === 'f' ? 'B站未接受此次发送，请稍后重试' : text(section[name]) || '发送未成功');
        row.status = 'submitted';
      } catch (error) {
        if (error instanceof AccountVerificationRequired) await this.options.sessions.verifyAccountRejection(origin, input.authEpoch!).catch(() => {});
        row.status = dispatched && !(error instanceof UpstreamRejection) && !(error instanceof AccountVerificationRequired)
          && (!(error instanceof BrokerError) || error.code === 'UNAVAILABLE') ? 'unknown' : 'rejected';
        row.message = row.status === 'unknown' ? '发送结果未确认，请先查看直播间，避免重复发送' : error instanceof BrokerError || error instanceof UpstreamRejection ? error.message : '发送已取消';
      }
      await this.serial(async () => { await this.persist(); }).catch(() => {});
      return this.projection(row);
    })().finally(() => this.work.delete(`send:${ledgerKey}`));
    this.work.set(`send:${ledgerKey}`, work);
    return work;
  }
}
