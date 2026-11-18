import type { MonitorRoomDescriptor } from '../../shared/types';
import { isPlaybackQuality, type PlaybackInfo } from '../../shared/playback';
import { parsePlaybackInfo } from '../../shared/playbackParser';
import { BrokerError } from './broker';
import type { LocalCookieTransport } from './cookieTransport';

const ROOT = 'https://api.live.bilibili.com';
const object = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
const id = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,19}$/.test(v);
const identifier = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? String(v) : id(v) ? v : undefined;
const text = (v: unknown, limit = 500) => typeof v === 'string' ? v.slice(0, limit) : '';
const abort = () => new DOMException('请求已取消', 'AbortError');
const failure = (message = 'B站房间信息暂不可用') => new BrokerError('UNAVAILABLE', message);
function image(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\]/.test(value)) return;
  try {
    const url = new URL(value.replace(/^\/\//, 'https://').replace(/^http:/, 'https:'));
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash &&
      ['hdslb.com', 'biliimg.com'].some(host => url.hostname === host || url.hostname.endsWith('.' + host))) return url.href;
  } catch { /* Ignore unsafe upstream images. */ }
}
function liveTime(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value * (value < 1e12 ? 1000 : 1);
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return null;
  const result = Date.parse(value.replace(' ', 'T') + '+08:00');
  return Number.isFinite(result) && result > 0 ? result : null;
}
interface Options { transport: Pick<LocalCookieTransport, 'run'>; fetch?: typeof fetch; now?: () => number }
interface Work { controller: AbortController; consumers: number; promise: Promise<unknown> }
/** Fixed public endpoints only. Account consent and Cookie reads never participate. */
export class LocalPublicRooms {
  private cache = new Map<string, { value: unknown; until: number }>();
  private tasks = new Map<string, Work>();
  private forced = new Map<string, number>();
  private blockedUntil = 0;
  constructor(private options: Options) {}
  private now() { return (this.options.now ?? Date.now)(); }
  private url(path: string, values: Record<string, string>) {
    const url = new URL(ROOT + path); for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value); return url;
  }
  private async request(url: URL, signal: AbortSignal): Promise<Record<string, any>> {
    if (this.blockedUntil > this.now()) throw new BrokerError('RATE_LIMITED', 'B站暂时限制请求，请稍后重试', Math.ceil((this.blockedUntil - this.now()) / 1000));
    return this.options.transport.run(url, 'anonymous', signal, async (_cookies, inner) => {
      const response = await (this.options.fetch ?? fetch)(url, { credentials: 'omit', redirect: 'error', signal: inner, headers: { accept: 'application/json' } });
      if ([403, 412, 429].includes(response.status)) {
        await response.body?.cancel().catch(() => {});
        const retry = Number(response.headers.get('retry-after'));
        const seconds = Number.isFinite(retry) && retry > 0 ? Math.min(86400, Math.max(30, retry)) : 30;
        this.blockedUntil = this.now() + seconds * 1000; throw new BrokerError('RATE_LIMITED', 'B站要求验证或暂时限制请求，请稍后重试', seconds);
      }
      if (!response.ok || !response.body || Number(response.headers.get('content-length')) > 2 * 1024 * 1024) {
        await response.body?.cancel().catch(() => {}); throw failure();
      }
      const reader = response.body.getReader(), decoder = new TextDecoder(); let bytes = 0, body = '';
      try {
        for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength;
          if (bytes > 2 * 1024 * 1024) { await reader.cancel(); throw failure('B站响应超出限制'); }
          body += decoder.decode(part.value, { stream: true });
        }
        body += decoder.decode();
      } finally { reader.releaseLock(); }
      let payload: Record<string, any>; try { payload = object(JSON.parse(body)); } catch { throw failure('B站响应格式异常'); }
      if ([-403, -412, -429, -352].includes(Number(payload.code))) {
        this.blockedUntil = this.now() + 30_000; throw new BrokerError('RATE_LIMITED', 'B站要求验证或暂时限制请求，请稍后重试', 30);
      }
      if (payload.code !== 0) throw failure(text(payload.message, 160) || 'B站暂未返回房间信息');
      return object(payload.data);
    });
  }
  private async shared<T>(key: string, force: unknown, signal: AbortSignal, load: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (signal.aborted) throw abort();
    if (force !== undefined && typeof force !== 'boolean') throw new BrokerError('INVALID_REQUEST', '刷新参数无效');
    const cached = this.cache.get(key);
    let work = this.tasks.get(key);
    if (work?.controller.signal.aborted) work = undefined;
    if (!work && !force && cached && cached.until > this.now()) return structuredClone(cached.value as T);
    if (!work) {
      if (this.tasks.size >= 32) throw new BrokerError('RATE_LIMITED', '本机房间请求繁忙', 5);
      const forceKey = key.startsWith('play:') ? key.split(':').slice(0, 2).join(':') : key;
      if (force && (this.forced.get(forceKey) ?? -Infinity) + 5000 > this.now()) throw new BrokerError('RATE_LIMITED', '刷新过于频繁，请稍后重试', 5);
      if (force) this.forced.set(forceKey, this.now());
      while (this.forced.size > 128) this.forced.delete(this.forced.keys().next().value!);
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 12_000);
      work = { controller, consumers: 0, promise: Promise.resolve(null) }; const current = work;
      current.promise = load(controller.signal).then(value => {
        if (controller.signal.aborted) throw abort();
        let until = this.now() + 30_000;
        if (key.startsWith('play:')) for (const source of (value as PlaybackInfo).sources) until = Math.min(until, (source.expiresAt ?? Infinity) - 5000);
        if (until > this.now()) { this.cache.delete(key); this.cache.set(key, { value, until }); }
        while (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value!);
        return value;
      }).finally(() => { clearTimeout(timer); if (this.tasks.get(key) === current) this.tasks.delete(key); });
      void current.promise.catch(() => {}); this.tasks.set(key, current);
    }
    const current = work; current.consumers++;
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const finish = () => { if (done) return false; done = true; signal.removeEventListener('abort', cancel);
        if (--current.consumers === 0 && this.tasks.get(key) === current) current.controller.abort(); return true; };
      const cancel = () => { if (finish()) reject(abort()); };
      signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) { cancel(); return; }
      current.promise.then(value => { if (finish()) resolve(structuredClone(value as T)); }, error => { if (finish()) reject(error instanceof BrokerError || error?.name === 'AbortError' ? error : failure()); });
    });
  }
  async room(input: { roomId?: unknown; force?: unknown }, signal: AbortSignal): Promise<MonitorRoomDescriptor> {
    if (Object.keys(input).some(key => !['roomId', 'force'].includes(key)) || !id(input.roomId)) throw new BrokerError('INVALID_REQUEST', '无效的直播间房间号');
    const requested = input.roomId;
    return this.shared('room:' + requested, input.force, signal, async inner => {
      const init = await this.request(this.url('/room/v1/Room/room_init', { id: requested }), inner);
      const roomId = identifier(init.room_id), uid = identifier(init.uid);
      if (!roomId || !uid) throw failure('直播间不存在或接口未返回房间');
      let info: Record<string, any>;
      try {
        const base = await this.request(this.url('/xlive/web-room/v1/index/getRoomBaseInfo', { req_biz: 'web_room_componet', room_ids: roomId }), inner);
        info = object(object(base.by_room_ids)[roomId]); if (!Object.keys(info).length) throw failure();
      } catch (error) {
        if (!(error instanceof BrokerError) || error.code !== 'UNAVAILABLE' || inner.aborted) throw error;
        const full = await this.request(this.url('/room/v1/Room/get_info', { room_id: roomId }), inner); info = Object.keys(object(full.room_info)).length ? object(full.room_info) : full;
      }
      if (identifier(info.room_id ?? info.roomid) !== roomId || identifier(info.uid) !== uid) throw failure('直播间归属信息不一致，请稍后重试');
      const status = info.live_status === 1 ? 'live' : [0, 2].includes(info.live_status) ? 'offline' : 'unknown';
      const at = this.now(), numericUid = Number(uid);
      const result: MonitorRoomDescriptor = { source: 'custom', input: requested, roomId, uid: Number.isSafeInteger(numericUid) ? numericUid : null,
        anchorName: text(info.uname, 100) || roomId, title: text(info.title), status, cover: image(info.cover ?? info.user_cover ?? info.keyframe),
        online: status === 'offline' ? 0 : null, onlineStale: status !== 'offline', fansCount: null, fansStale: true, guardCount: null, guardStale: true,
        liveStartTime: status === 'live' ? liveTime(info.live_time) : null, lastUpdatedAt: at, metadataFetchedAt: at, metadataStale: false };
      if (status === 'live') try {
        const online = await this.request(this.url('/xlive/general-interface/v1/rank/getOnlineGoldRank', { ruid: uid, roomId, page: '1', pageSize: '1' }), inner);
        const count = typeof online.onlineNum === 'number' ? online.onlineNum :
          typeof online.onlineNum === 'string' && /^(?:0|[1-9][0-9]{0,15})$/.test(online.onlineNum) ? Number(online.onlineNum) : NaN;
        if (!Number.isSafeInteger(count) || count < 0) throw failure('在线人数暂不可用');
        result.online = count; result.onlineStale = false; result.onlineLastSuccessAt = this.now();
      } catch (error) {
        if (inner.aborted) throw error;
        if (!(error instanceof BrokerError)) throw error;
        result.onlineError = error.message;
      }
      return result;
    });
  }
  async playback(input: { roomId?: unknown; qn?: unknown; force?: unknown }, signal: AbortSignal): Promise<PlaybackInfo> {
    if (Object.keys(input).some(key => !['roomId', 'qn', 'force'].includes(key)) || !id(input.roomId) || !isPlaybackQuality(input.qn))
      throw new BrokerError('INVALID_REQUEST', '无效的房间或清晰度参数');
    const roomId = input.roomId, qn = input.qn;
    return this.shared('play:' + roomId + ':' + qn, input.force, signal, async inner => {
      const data = await this.request(this.url('/xlive/web-room/v2/index/getRoomPlayInfo',
        { room_id: roomId, protocol: '0,1', format: '0,1,2', codec: '0', qn: String(qn), platform: 'web', ptype: '8' }), inner);
      const result = parsePlaybackInfo(data, roomId, qn, this.now());
      if (result.status === 'restricted') result.message = 'B站暂未提供匿名播放源，可登录账号后重试';
      return result;
    });
  }
}
