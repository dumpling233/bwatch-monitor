import type { LocalAccount, LocalLoginError } from '../../shared/localLogin';
import { isPlaybackQuality, type PlaybackInfo } from '../../shared/playback';
import { parsePlaybackInfo } from '../../shared/playbackParser';

export class BrokerError extends Error {
  constructor(public readonly code: LocalLoginError['code'], message: string, public readonly retryAfter?: number) {
    super(message);
  }
}
/** A business endpoint rejection requests verification; it is not evidence of logout by itself. */
export class AccountVerificationRequired extends BrokerError {
  constructor() { super('UNAVAILABLE', 'B站暂未接受账号请求，正在重新确认账号'); }
}
const error = (code: LocalLoginError['code'], message: string, retryAfter?: number) => new BrokerError(code, message, retryAfter);
const cancelled = () => new DOMException('请求已取消', 'AbortError');
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
type Task = { controller: AbortController; promise: Promise<PlaybackInfo>; waiters: number };
interface Options {
  fetch?: typeof fetch;
  beforeRequest?: (url: URL, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  onChange?: (authEpoch: string) => void;
}

/** Cookie transport is browser-internal; this class has no Cookie export or arbitrary URL method. */
export class LocalLoginBroker {
  authEpoch = crypto.randomUUID();
  accountVerifiedAt = 0;
  private readonly requestFetch: typeof fetch;
  private readonly now: () => number;
  private readonly origins = new Set<string>();
  private readonly controllers = new Set<AbortController>();
  private readonly cache = new Map<string, { info: PlaybackInfo; until: number }>();
  private readonly tasks = new Map<string, Task>();
  private readonly forced = new Map<string, number>();
  private queue: Array<() => void> = [];
  private active = 0;
  private blockedUntil = 0;
  private accountCache?: { account: LocalAccount };
  private accountTask?: Promise<LocalAccount>;
  constructor(private readonly options: Options = {}) {
    this.requestFetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? Date.now;
  }
  isAuthorized(origin: string): boolean { return this.origins.has(origin); }
  authorize(origin: string, allowed: boolean, invalidate = true): void {
    if (this.origins.has(origin) === allowed) return;
    if (allowed) this.origins.add(origin); else this.origins.delete(origin);
    if (invalidate) this.invalidate();
  }
  invalidate(): void {
    this.authEpoch = crypto.randomUUID();
    this.accountCache = undefined;
    this.accountVerifiedAt = 0;
    this.accountTask = undefined;
    this.cache.clear();
    this.forced.clear();
    for (const controller of this.controllers) controller.abort();
    this.options.onChange?.(this.authEpoch);
  }
  private authorized(origin: string): void {
    if (!this.isAuthorized(origin)) throw error('UNAUTHORIZED', '请点击浏览器工具栏中的 BWatch 扩展并授权当前页面');
  }
  private current(epoch: string): void {
    if (epoch !== this.authEpoch) throw error('ACCOUNT_CHANGED', 'B站账号或授权已变化，请重新检查登录状态');
  }
  private async schedule<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    if (signal.aborted) throw cancelled();
    await new Promise<void>((resolve, reject) => {
      let started = false;
      const abort = () => {
        if (started) return;
        this.queue = this.queue.filter(value => value !== start);
        reject(cancelled());
      };
      const start = () => {
        started = true;
        signal.removeEventListener('abort', abort);
        this.active++;
        resolve();
      };
      signal.addEventListener('abort', abort, { once: true });
      if (this.active < 4) start(); else this.queue.push(start);
    });
    try {
      if (signal.aborted) throw cancelled();
      return await task();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
  private async request(url: URL, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (this.blockedUntil > this.now()) throw error('RATE_LIMITED', 'B站暂时限制请求，请稍后重试', Math.ceil((this.blockedUntil - this.now()) / 1000));
    try {
      await this.options.beforeRequest?.(url, signal);
      if (signal.aborted) throw cancelled();
      const response = await this.requestFetch(url, { credentials: 'include', redirect: 'error', signal,
        headers: { accept: 'application/json' } });
      let payload: Record<string, unknown> = {};
      if (response.ok) {
        const body = await response.text();
        if (body.length > 2 * 1024 * 1024) throw error('UNAVAILABLE', 'B站响应超出限制');
        payload = record(JSON.parse(body));
      } else await response.body?.cancel().catch(() => {});
      if ([403, 412, 429].includes(response.status) || [-403, -412, -429, -352].includes(Number(payload.code))) {
        const retry = response.headers.get('retry-after');
        const parsed = retry && /^\d+$/.test(retry) ? Number(retry) : retry ? (Date.parse(retry) - this.now()) / 1000 : 30;
        const seconds = Math.min(86400, Math.max(30, Number.isFinite(parsed) ? parsed : 30));
        this.blockedUntil = Math.max(this.blockedUntil, this.now() + seconds * 1000);
        throw error('RATE_LIMITED', 'B站要求验证或限制请求，请在 B站完成验证后稍后重试', seconds);
      }
      if (!response.ok) throw error('UNAVAILABLE', 'B站接口暂时不可用');
      return payload;
    } catch (failure) {
      if (failure instanceof BrokerError) throw failure;
      if (signal.aborted) throw cancelled();
      throw error('UNAVAILABLE', '无法连接 B站，请检查网络后重试');
    }
  }
  private wait<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(cancelled());
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(cancelled());
      signal.addEventListener('abort', abort, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }
  async account(origin: string, signal?: AbortSignal, refresh = false): Promise<LocalAccount> {
    if (!this.isAuthorized(origin)) return { state: 'unauthorized', authEpoch: this.authEpoch };
    // A verified identity belongs to the current credential generation, not a
    // periodic TTL. Cookie events, explicit checks and actual failures renew it.
    if (!refresh && this.accountCache) return structuredClone(this.accountCache.account);
    if (!this.accountTask) {
      const epoch = this.authEpoch, controller = new AbortController();
      this.controllers.add(controller);
      const timeout = setTimeout(() => controller.abort(), 12000);
      const task = this.schedule(controller.signal, async () => {
        const response = await this.request(new URL('https://api.bilibili.com/x/web-interface/nav'), controller.signal);
        this.current(epoch);
        const data = record(response.data);
        let account: LocalAccount;
        if (response.code === -101 || response.code === 0 && data.isLogin === false) account = { state: 'logged-out', authEpoch: epoch };
        else {
          const uid = typeof data.mid === 'number' && Number.isSafeInteger(data.mid) ? String(data.mid) : typeof data.mid === 'string' ? data.mid : '';
          if (response.code !== 0 || data.isLogin !== true || !/^[1-9][0-9]{0,19}$/.test(uid)) throw error('UNAVAILABLE', 'B站登录状态暂不可用');
          account = { state: 'logged-in', uid, name: typeof data.uname === 'string' ? data.uname.slice(0, 100) : uid, authEpoch: epoch };
        }
        const previous = this.accountCache?.account;
        if (previous && (previous.state !== account.state || previous.uid !== account.uid)) {
          this.invalidate();
          account.authEpoch = this.authEpoch;
        }
        this.accountVerifiedAt = this.now();
        this.accountCache = { account };
        return structuredClone(account);
      }).finally(() => {
        clearTimeout(timeout);
        this.controllers.delete(controller);
        if (this.accountTask === task) this.accountTask = undefined;
      });
      this.accountTask = task;
    }
    const result = await this.wait(this.accountTask, signal);
    this.authorized(origin);
    return result;
  }
  async resolve(origin: string, input: { roomId?: string; qn?: number; force?: boolean; authEpoch?: string }, signal: AbortSignal): Promise<PlaybackInfo> {
    this.authorized(origin);
    if (typeof input.roomId !== 'string' || !/^[1-9][0-9]{0,19}$/.test(input.roomId) ||
      !isPlaybackQuality(input.qn) ||
      (input.force !== undefined && typeof input.force !== 'boolean') ||
      typeof input.authEpoch !== 'string' || !/^[\w.-]{1,128}$/.test(input.authEpoch)) throw error('INVALID_REQUEST', '无效的房间或清晰度参数');
    this.current(input.authEpoch);
    const account = await this.account(origin, signal);
    this.current(input.authEpoch);
    if (account.state !== 'logged-in') throw error('LOGGED_OUT', '请先在同一浏览器登录 B站');
    const epoch = this.authEpoch, room = input.roomId!, qn = input.qn!, key = `${epoch}:${room}:${qn}`;
    const cached = this.cache.get(key);
    let task = this.tasks.get(key);
    if (!task && !input.force && cached && cached.until > this.now()) return structuredClone(cached.info);
    if (!task) {
      if (this.tasks.size >= 64) throw error('UNAVAILABLE', '本机播放源请求繁忙，请稍后重试');
      if (input.force) {
        for (const [id, until] of this.forced) if (until <= this.now()) this.forced.delete(id);
        if ((this.forced.get(room) ?? 0) > this.now()) throw error('RATE_LIMITED', '刷新过于频繁，请稍后重试', 5);
        if (this.forced.size >= 128) throw error('UNAVAILABLE', '本机播放源请求繁忙，请稍后重试');
        this.forced.set(room, this.now() + 5000);
      }
      const controller = new AbortController();
      this.controllers.add(controller);
      const timeout = setTimeout(() => controller.abort(), 12000);
      const entry: Task = { controller, waiters: 0, promise: Promise.resolve(null as unknown as PlaybackInfo) };
      entry.promise = this.schedule(controller.signal, async () => {
        this.current(epoch);
        const url = new URL('https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo');
        for (const [name, value] of Object.entries({ room_id: room, protocol: '0,1', format: '0,1,2', codec: '0', qn: String(qn), platform: 'web', ptype: '8' })) url.searchParams.set(name, value);
        const response = await this.request(url, controller.signal);
        this.current(epoch);
        if (response.code === -101) throw new AccountVerificationRequired();
        if (response.code !== 0) throw error('UNAVAILABLE', 'B站播放接口暂时不可用');
        const result = parsePlaybackInfo(response.data, room, qn, this.now());
        if (result.status === 'restricted') result.message = '当前账号暂未取得可用播放源，可前往 B站观看';
        const until = Math.min(this.now() + 30_000, ...result.sources.map(value => (value.expiresAt ?? Infinity) - 5000));
        if (until > this.now()) {
          this.cache.set(key, { info: result, until });
          while (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value!);
        }
        return result;
      }).finally(() => {
        clearTimeout(timeout);
        this.controllers.delete(controller);
        if (this.tasks.get(key) === entry) this.tasks.delete(key);
      });
      this.tasks.set(key, entry);
      task = entry;
    }
    task.waiters++;
    try {
      const result = await this.wait(task.promise, signal);
      this.authorized(origin);
      this.current(epoch);
      return structuredClone(result);
    } finally {
      task.waiters--;
      if (!task.waiters && this.tasks.get(key) === task) task.controller.abort();
    }
  }
}
