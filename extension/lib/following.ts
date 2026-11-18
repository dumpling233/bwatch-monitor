import type { LocalFollowingRoom, LocalFollowingRoomInfo, LocalFollowingRoomsPage, LocalFollowingRoomStatus, LocalFollowingStatusBatch } from '../../shared/localFollowing';
import { AccountVerificationRequired, BrokerError } from './broker';
import { LocalCookieTransport } from './cookieTransport';
import { LoginSessions } from './loginSessions';

export const FOLLOWING_PAGE_SIZE = 100;
export const FOLLOWING_RELATIONS_API = 'https://api.bilibili.com/x/relation/followings';
export const FOLLOWING_STATUS_API = 'https://api.live.bilibili.com/room/v1/Room/get_status_info_by_uids';
export const FOLLOWING_ROOM_INIT_API = 'https://api.live.bilibili.com/room/v1/Room/room_init';
export const FOLLOWING_ROOM_BASE_API = 'https://api.live.bilibili.com/xlive/web-room/v1/index/getRoomBaseInfo';
export const FOLLOWING_ROOM_INFO_API = 'https://api.live.bilibili.com/room/v1/Room/get_info';
export const FOLLOWING_ONLINE_API = 'https://api.live.bilibili.com/xlive/general-interface/v1/rank/getOnlineGoldRank';
type FollowingPageSize = 9 | 50 | 100;
const pageSize = (value: unknown): value is FollowingPageSize => value === 9 || value === 50 || value === 100;
const MAX_RESPONSE_BYTES = 512 * 1024;
type Json = Record<string, unknown>;
const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const identifier = (value: unknown): string | undefined => {
  const result = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  return typeof result === 'string' && /^[1-9][0-9]{0,19}$/.test(result) ? result : undefined;
};
const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000 ? value : null;
const text = (value: unknown, limit: number): string => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, limit) : '';
const image = (value: unknown): string => {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\]/.test(value)) return '';
  try {
    const url = new URL(value.replace(/^\/\//, 'https://'));
    if (url.protocol === 'http:' && !url.port) url.protocol = 'https:';
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash &&
      ['hdslb.com', 'biliimg.com'].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`)) ? url.href : '';
  } catch { return ''; }
};
const unavailable = (message = '暂时无法获取B站关注，请稍后重试') => new BrokerError('UNAVAILABLE', message);
const aborted = () => new DOMException('请求已取消', 'AbortError');
type RoomMetadata = Pick<LocalFollowingRoomInfo, 'roomId' | 'uid' | 'anchorName' | 'title' | 'cover' | 'status' | 'liveStartTime' | 'metadataFetchedAt'>;
interface CachedRoom { value: RoomMetadata; until: number; bytes: number }
interface PendingRoom { promise: Promise<LocalFollowingRoomInfo>; controller: AbortController; consumers: number }
const ROOM_CACHE_MAX_AGE = 10 * 60_000;
const roomCover = (row: Json): string => image(row.cover) || image(row.user_cover) || image(row.keyframe);
function liveStart(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 32_503_680_000) return value * 1000;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return null;
  const time = Date.parse(value.replace(' ', 'T') + '+08:00');
  return Number.isFinite(time) && time > 0 ? time : null;
}

/** Only the verified user's fixed following directory; no arbitrary destination or account. */
export class LocalFollowingService {
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly pending = new Set<AbortController>();
  private readonly roomCache = new Map<string, CachedRoom>();
  private readonly roomPending = new Map<string, PendingRoom>();
  private roomCacheBytes = 0;
  private blockedUntil = 0;
  constructor(private readonly options: { transport: LocalCookieTransport; sessions: LoginSessions; fetch?: typeof fetch; now?: () => number }) {
    this.fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.now = options.now ?? Date.now;
  }
  invalidate(): void {
    for (const controller of this.pending) controller.abort();
    for (const entry of this.roomPending.values()) entry.controller.abort();
    this.roomPending.clear(); this.roomCache.clear(); this.roomCacheBytes = 0;
  }

  private async body(response: Response, signal: AbortSignal): Promise<Json> {
    if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
      await response.body?.cancel().catch(() => {}); throw unavailable('B站关注列表响应过大，请稍后重试');
    }
    const reader = response.body?.getReader();
    if (!reader) throw unavailable();
    const decoder = new TextDecoder();
    let bytes = 0, body = '';
    try {
      for (;;) {
        if (signal.aborted) throw aborted();
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) throw unavailable('B站关注列表响应过大，请稍后重试');
        body += decoder.decode(chunk.value, { stream: true });
      }
      body += decoder.decode();
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    try { return object(JSON.parse(body)); } catch { throw unavailable('B站关注列表暂时无法读取'); }
  }

  async page(origin: string, input: { page?: unknown; authEpoch?: unknown }, signal: AbortSignal): Promise<LocalFollowingRoomsPage> {
    const page = input.page === undefined ? 1 : input.page;
    if (!Object.keys(input).every(key => key === 'page' || key === 'authEpoch') || typeof page !== 'number' || !Number.isSafeInteger(page) || page < 1 || page > 1000 ||
      typeof input.authEpoch !== 'string' || !/^[\w.-]{1,128}$/.test(input.authEpoch))
      throw new BrokerError('INVALID_REQUEST', '关注列表页码无效');
    const authEpoch = input.authEpoch;
    return this.withSession(origin, authEpoch, signal,
      (accountUid, operationSignal) => this.relations(origin, authEpoch, accountUid, page, operationSignal));
  }

  private async relations(origin: string, authEpoch: string, accountUid: string, page: number, signal: AbortSignal): Promise<LocalFollowingRoomsPage> {
    const names = new Map<string, string>();
    let accountTotal: number | null = null, scannedAccounts = 0, hasMore = false;
    // Logical pages have fixed 100-account offsets even after an MV3 restart.
    // Two 50-row relation reads feed one public status request, not two POSTs.
    for (let part = 0; part < 2; part++) {
      const sourcePage = (page - 1) * 2 + part + 1, url = new URL(FOLLOWING_RELATIONS_API);
      for (const [key, value] of Object.entries({ vmid: accountUid, pn: String(sourcePage), ps: '50', order: 'desc' })) url.searchParams.set(key, value);
      const data = object((await this.load(origin, authEpoch, accountUid, signal, url, 'authenticated')).data);
      if (!Array.isArray(data.list) || data.list.length > 50) throw unavailable('B站关注列表格式暂不支持');
      for (const value of data.list) {
        const row = object(value), uid = identifier(row.mid);
        if (!uid) throw unavailable('B站关注账号格式暂不支持');
        if (!names.has(uid)) names.set(uid, text(row.uname, 100));
      }
      const rawLength = data.list.length, total = count(data.total), pageEnd = (sourcePage - 1) * 50 + rawLength;
      const inconsistentTotal = total !== null && total < pageEnd;
      accountTotal = inconsistentTotal ? null : total;
      scannedAccounts += rawLength;
      hasMore = rawLength === 50 && (total === null || inconsistentTotal || sourcePage * 50 < total);
      if (!hasMore) break;
    }
    const scannedUids = [...names.keys()], unresolvedUids: string[] = [], rooms: LocalFollowingRoom[] = [];
    if (scannedUids.length) {
      const payload = await this.load(origin, authEpoch, accountUid, signal, new URL(FOLLOWING_STATUS_API), 'anonymous', JSON.stringify({ uids: scannedUids }));
      const result = projectFollowingStatus(payload, { accountUid, authEpoch, uids: scannedUids, resolvedAt: this.now() });
      const byUid = new Map(result.rooms.map(room => [room.uid, room]));
      const noRoom = new Set(result.noRoomUids ?? []);
      for (const uid of scannedUids) {
        const status = byUid.get(uid);
        if (status) rooms.push({ ...status, anchorName: status.anchorName || names.get(uid) || uid, title: status.title ?? '', online: null, lastLiveTime: null });
        else if (!noRoom.has(uid)) unresolvedUids.push(uid);
      }
    }
    return { accountUid, authEpoch, page, pageSize: FOLLOWING_PAGE_SIZE, total: null, liveCount: null, hasMore, rooms, resolvedAt: this.now(),
      directorySource: 'relations', accountTotal, scannedAccounts, scannedUids, unresolvedUids };
  }

  async status(origin: string, input: { uids?: unknown; authEpoch?: unknown }, signal: AbortSignal): Promise<LocalFollowingStatusBatch> {
    if (!Object.keys(input).every(key => key === 'uids' || key === 'authEpoch') || !Array.isArray(input.uids) || input.uids.length < 1 || input.uids.length > 100 ||
      new Set(input.uids).size !== input.uids.length || input.uids.some(uid => typeof uid !== 'string' || !identifier(uid)) ||
      typeof input.authEpoch !== 'string' || !/^[\w.-]{1,128}$/.test(input.authEpoch))
      throw new BrokerError('INVALID_REQUEST', '关注直播状态请求无效');
    const uids = [...input.uids] as string[];
    const { payload, accountUid } = await this.request(origin, input.authEpoch, signal, new URL(FOLLOWING_STATUS_API), 'anonymous',
      JSON.stringify({ uids: [...new Set(uids)] }));
    return projectFollowingStatus(payload, { accountUid, authEpoch: input.authEpoch, uids, resolvedAt: this.now() });
  }

  /** Public metadata/counts require the same complete account grant, but never cookies or NAV retries. */
  async roomInfo(origin: string, input: { roomId?: unknown; uid?: unknown; authEpoch?: unknown }, signal: AbortSignal): Promise<LocalFollowingRoomInfo> {
    if (!Object.keys(input).every(key => ['roomId', 'uid', 'authEpoch'].includes(key)) ||
      typeof input.roomId !== 'string' || !identifier(input.roomId) || typeof input.uid !== 'string' || !identifier(input.uid) ||
      typeof input.authEpoch !== 'string' || !/^[\w.-]{1,128}$/.test(input.authEpoch))
      throw new BrokerError('INVALID_REQUEST', '关注房间信息请求无效');
    if (signal.aborted) throw aborted();
    const { roomId, uid, authEpoch } = input;
    const session = await this.options.sessions.requireChat(origin, authEpoch, signal), accountUid = session.account!.uid!;
    if (signal.aborted) throw aborted();
    // The public cache is still isolated by the authorization that requested it.
    const key = `${origin}\n${authEpoch}\n${roomId}:${uid}`;
    let entry = this.roomPending.get(key);
    if (!entry || entry.controller.signal.aborted) {
      if (this.roomPending.size >= 8) throw unavailable('关注房间正在加载，请稍后再试');
      const controller = new AbortController();
      entry = { controller, consumers: 0, promise: Promise.resolve(null as never) };
      const created = entry;
      entry.promise = this.withSession(origin, authEpoch, controller.signal,
        (currentUid, operationSignal) => this.loadRoom(key, origin, authEpoch, currentUid, roomId, uid, operationSignal))
        .finally(() => { if (this.roomPending.get(key) === created) this.roomPending.delete(key); });
      this.roomPending.set(key, entry);
    }
    const current = entry;
    current.consumers++;
    let cancel!: () => void;
    try {
      const result = await Promise.race([current.promise, new Promise<never>((_, reject) => {
        cancel = () => reject(aborted());
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
      })]);
      this.options.sessions.assertChatCurrent(origin, authEpoch, accountUid);
      if (signal.aborted) throw aborted();
      return result;
    } finally {
      signal.removeEventListener('abort', cancel);
      if (--current.consumers === 0) current.controller.abort();
    }
  }

  private cachedRoom(key: string): CachedRoom | undefined {
    const now = this.now();
    for (const [id, entry] of this.roomCache) if (now < entry.value.metadataFetchedAt || now - entry.value.metadataFetchedAt > ROOM_CACHE_MAX_AGE) {
      this.roomCache.delete(id); this.roomCacheBytes -= entry.bytes;
    }
    const value = this.roomCache.get(key);
    if (value) { this.roomCache.delete(key); this.roomCache.set(key, value); }
    return value;
  }
  private cacheRoom(key: string, value: RoomMetadata): void {
    const previous = this.roomCache.get(key);
    if (previous) { this.roomCache.delete(key); this.roomCacheBytes -= previous.bytes; }
    const bytes = new TextEncoder().encode(key + JSON.stringify(value)).byteLength;
    this.roomCache.set(key, { value, bytes, until: value.metadataFetchedAt + (value.status === 'live' ? 5 * 60_000 : 60_000) });
    this.roomCacheBytes += bytes;
    while (this.roomCache.size > 128 || this.roomCacheBytes > 1024 * 1024) {
      const oldest = this.roomCache.entries().next().value!;
      this.roomCache.delete(oldest[0]); this.roomCacheBytes -= oldest[1].bytes;
    }
  }

  private async loadRoom(key: string, origin: string, authEpoch: string, accountUid: string, requestedRoomId: string, uid: string, signal: AbortSignal): Promise<LocalFollowingRoomInfo> {
    const cached = this.cachedRoom(key);
    let metadata = cached?.value, metadataStale = false, metadataError: string | undefined;
    const request = (url: URL) => this.load(origin, authEpoch, accountUid, signal, url, 'anonymous');
    if (!cached || cached.until <= this.now()) {
      try {
        const initUrl = new URL(FOLLOWING_ROOM_INIT_API); initUrl.searchParams.set('id', requestedRoomId);
        const init = object((await request(initUrl)).data), canonical = identifier(init.room_id), owner = identifier(init.uid);
        if (!canonical || owner !== uid || (canonical !== requestedRoomId && identifier(init.short_id) !== requestedRoomId))
          throw new BrokerError('STATE_CONFLICT', '关注房间归属已变化，请刷新关注列表');
        let row: Json;
        try {
          const baseUrl = new URL(FOLLOWING_ROOM_BASE_API);
          baseUrl.searchParams.set('req_biz', 'web_room_componet'); baseUrl.searchParams.set('room_ids', canonical);
          const base = object((await request(baseUrl)).data);
          row = object(object(base.by_room_ids)[canonical]);
          if (!Object.keys(row).length) throw unavailable('B站暂未返回该房间信息');
        } catch (failure) {
          if (signal.aborted || !(failure instanceof BrokerError) || failure.code !== 'UNAVAILABLE') throw failure;
          const infoUrl = new URL(FOLLOWING_ROOM_INFO_API); infoUrl.searchParams.set('room_id', canonical);
          const info = object((await request(infoUrl)).data);
          row = Object.keys(object(info.room_info)).length ? object(info.room_info) : info;
        }
        const rowRoomId = identifier(row.room_id ?? row.roomid), rowUid = identifier(row.uid);
        if (rowRoomId !== canonical || rowUid !== uid)
          throw new BrokerError('STATE_CONFLICT', '关注房间归属已变化，请刷新关注列表');
        const status = row.live_status === 1 ? 'live' : row.live_status === 0 || row.live_status === 2 ? 'offline' : 'unknown';
        const cover = roomCover(row);
        metadata = { roomId: canonical, uid, anchorName: text(row.uname, 100), title: text(row.title, 500),
          ...(cover ? { cover } : {}), status, liveStartTime: status === 'live' ? liveStart(row.live_time) : null, metadataFetchedAt: this.now() };
        this.options.sessions.assertChatCurrent(origin, authEpoch, accountUid);
        if (signal.aborted) throw aborted();
        this.cacheRoom(key, metadata);
      } catch (failure) {
        if (signal.aborted || !metadata || !(failure instanceof BrokerError) || !['UNAVAILABLE', 'RATE_LIMITED'].includes(failure.code)) throw failure;
        metadataStale = true; metadataError = failure.message;
      }
    }
    if (!metadata) throw unavailable('B站暂未返回该房间信息');
    let online: number | null = null, onlineLastSuccessAt: number | undefined, onlineError: string | undefined;
    let onlineStale = metadata.status === 'live' || metadata.status === 'unknown';
    if (metadata.status === 'live') {
      try {
        const onlineUrl = new URL(FOLLOWING_ONLINE_API);
        for (const [name, value] of Object.entries({ ruid: uid, roomId: metadata.roomId, page: '1', pageSize: '1' })) onlineUrl.searchParams.set(name, value);
        const value = object((await request(onlineUrl)).data).onlineNum;
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw unavailable('在线人数暂不可用');
        online = value; onlineStale = false; onlineLastSuccessAt = this.now();
      } catch (failure) {
        if (signal.aborted || !(failure instanceof BrokerError) || !['UNAVAILABLE', 'RATE_LIMITED'].includes(failure.code)) throw failure;
        onlineError = failure.message;
      }
    }
    const retryAfterMs = this.blockedUntil > this.now() ? this.blockedUntil - this.now() : undefined;
    return { ...metadata, accountUid, authEpoch, online, onlineStale, metadataStale, resolvedAt: this.now(),
      ...(metadataError ? { metadataError } : {}), ...(onlineLastSuccessAt !== undefined ? { onlineLastSuccessAt } : {}),
      ...(onlineError ? { onlineError } : {}), ...(retryAfterMs ? { retryAfterMs } : {}) };
  }

  private async request(origin: string, authEpoch: string, signal: AbortSignal, url: URL, mode: 'anonymous' | 'authenticated', body?: string): Promise<{ payload: Json; accountUid: string }> {
    return this.withSession(origin, authEpoch, signal, async (accountUid, requestSignal) => ({
      payload: await this.load(origin, authEpoch, accountUid, requestSignal, url, mode, body), accountUid
    }));
  }

  private async load(origin: string, authEpoch: string, accountUid: string, signal: AbortSignal, url: URL, mode: 'anonymous' | 'authenticated', body?: string): Promise<Json> {
    if (signal.aborted) throw aborted();
    this.options.sessions.assertChatCurrent(origin, authEpoch, accountUid);
    if (this.blockedUntil > this.now()) throw new BrokerError('RATE_LIMITED', 'B站暂时限制关注列表请求，请稍后重试', Math.ceil((this.blockedUntil - this.now()) / 1000));
    const method = body === undefined ? 'GET' : 'POST';
    try {
      const payload = await this.options.transport.run(url, mode, signal, async (cookies, requestSignal) => {
      this.options.sessions.assertChatCurrent(origin, authEpoch, accountUid);
      if (mode === 'authenticated' && (!cookies.SESSDATA || cookies.DedeUserID !== accountUid)) throw new BrokerError('ACCOUNT_CHANGED', 'B站账号已变化，请重新连接账号');
      const response = await this.fetch(url, { method, credentials: 'omit', redirect: 'error', signal: requestSignal,
        headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body }) });
      if ([403, 412, 429].includes(response.status)) { await response.body?.cancel().catch(() => {}); this.rateLimited(response); }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw unavailable();
      }
      const value = await this.body(response, requestSignal);
      if ([-403, -412, -429, -352].includes(Number(value.code))) this.rateLimited(response);
      if (value.code === -101 && mode === 'authenticated') throw new AccountVerificationRequired();
      if (value.code !== 0) throw unavailable();
      return value;
      }, { method });
      this.options.sessions.assertChatCurrent(origin, authEpoch, accountUid);
      if (signal.aborted) throw aborted();
      return payload;
    } catch (failure) {
      if (signal.aborted) throw aborted();
      if (failure instanceof BrokerError || failure instanceof AccountVerificationRequired) throw failure;
      throw unavailable();
    }
  }

  /** The 12-second budget covers the entire multi-step operation, including transport waits. */
  private async withSession<T>(origin: string, authEpoch: string, signal: AbortSignal, work: (accountUid: string, signal: AbortSignal) => Promise<T>): Promise<T> {
    if (signal.aborted) throw aborted();
    if (this.pending.size >= 8) throw unavailable('关注列表正在加载，请稍后再试');
    const controller = new AbortController(), cancel = () => controller.abort();
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) controller.abort();
    const timeout = setTimeout(cancel, 12_000);
    this.pending.add(controller);
    let accountUid: string | undefined;
    try {
      const session = await this.options.sessions.requireChat(origin, authEpoch, controller.signal);
      accountUid = session.account!.uid!;
      const result = await work(accountUid, controller.signal);
      this.options.sessions.assertChatCurrent(origin, authEpoch, accountUid);
      if (controller.signal.aborted) throw aborted();
      return result;
    } catch (failure) {
      if (failure instanceof AccountVerificationRequired) {
        if (controller.signal.aborted) throw aborted();
        await this.options.sessions.verifyAccountRejection(origin, authEpoch);
        throw failure;
      }
      if (signal.aborted) throw aborted();
      if (failure instanceof BrokerError) throw failure;
      throw unavailable();
    } finally {
      clearTimeout(timeout); signal.removeEventListener('abort', cancel); this.pending.delete(controller);
    }
  }

  private rateLimited(response: Response): never {
    const retry = response.headers.get('retry-after');
    const parsed = retry && /^\d+$/.test(retry) ? Number(retry) : retry ? (Date.parse(retry) - this.now()) / 1000 : 30;
    const seconds = Math.min(86400, Math.max(30, Number.isFinite(parsed) ? Math.ceil(parsed) : 30));
    this.blockedUntil = Math.max(this.blockedUntil, this.now() + seconds * 1000);
    throw new BrokerError('RATE_LIMITED', 'B站暂时限制关注列表请求，请稍后重试', seconds);
  }
}

export function projectFollowingPage(payload: unknown, context: { page: number; pageSize?: FollowingPageSize; accountUid: string; authEpoch: string; resolvedAt: number }): LocalFollowingRoomsPage {
  const size = context.pageSize ?? FOLLOWING_PAGE_SIZE;
  if (!pageSize(size)) throw unavailable('B站关注列表页长暂不支持');
  const data = object(object(payload).data);
  if (!Array.isArray(data.list) || data.list.length > size) throw unavailable('B站关注列表格式暂不支持');
  const seen = new Set<string>(), rooms: LocalFollowingRoom[] = [];
  for (const value of data.list) {
    const row = object(value), roomId = identifier(row.roomid), uid = identifier(row.uid);
    if (!roomId || !uid || seen.has(roomId)) continue;
    seen.add(roomId);
    const recordTime = typeof row.record_live_time === 'number' && Number.isSafeInteger(row.record_live_time) && row.record_live_time > 0 && row.record_live_time <= 32_503_680_000
      ? row.record_live_time * 1000 : null;
    rooms.push({ roomId, uid, anchorName: text(row.uname, 100) || uid, title: text(row.title, 500),
      cover: image(row.room_cover), status: row.live_status === 1 ? 'live' : row.live_status === 0 ? 'offline' : 'unknown',
      online: null, liveStartTime: null, lastLiveTime: recordTime });
  }
  const upstreamTotal = count(data.count), upstreamLiveCount = count(data.live_count), totalPage = count(data.totalPage);
  // Unknown count semantics must not make a useful room page unreadable to strict clients.
  const inconsistentCounts = upstreamTotal !== null && upstreamLiveCount !== null && upstreamLiveCount > upstreamTotal;
  const pageLiveCount = rooms.reduce((sum, room) => sum + Number(room.status === 'live'), 0);
  const total = inconsistentCounts || (upstreamTotal !== null && upstreamTotal < rooms.length) ? null : upstreamTotal;
  const liveCount = inconsistentCounts || (upstreamLiveCount !== null && upstreamLiveCount < pageLiveCount) ? null : upstreamLiveCount;
  const pageEnd = (context.page - 1) * size + data.list.length;
  const inconsistentPagination = (totalPage !== null && totalPage < context.page) ||
    (upstreamTotal !== null && upstreamTotal < pageEnd) ||
    (totalPage !== null && upstreamTotal !== null && upstreamTotal > totalPage * size);
  // Contradictory counters cannot truncate the list; a full fixed-size page may have a successor.
  const hasMore = data.list.length > 0 && (inconsistentPagination ? data.list.length === size :
    totalPage !== null ? context.page < totalPage : upstreamTotal !== null ? context.page * size < upstreamTotal : data.list.length === size);
  return { ...context, pageSize: size, total, liveCount, hasMore, rooms };
}

export function projectFollowingStatus(payload: unknown, context: { accountUid: string; authEpoch: string; uids: string[]; resolvedAt: number }): LocalFollowingStatusBatch {
  const raw = object(payload).data;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw unavailable('B站直播状态格式暂不支持');
  const data = object(raw), requested = new Set(context.uids), seenRooms = new Set<string>(), ambiguousRooms = new Set<string>(), rooms: LocalFollowingRoomStatus[] = [], noRoomUids: string[] = [];
  for (const uid of requested) {
    if (!Object.prototype.hasOwnProperty.call(data, uid)) continue;
    const row = object(data[uid]), rowUid = identifier(row.uid), roomId = identifier(row.room_id);
    if (rowUid === uid && (row.room_id === 0 || row.room_id === '0')) { noRoomUids.push(uid); continue; }
    // Both the keyed UID and explicit owner must agree. Missing or ambiguous ownership remains unknown.
    if (!roomId || rowUid !== uid) continue;
    if (seenRooms.has(roomId)) { ambiguousRooms.add(roomId); continue; }
    seenRooms.add(roomId);
    const status = row.live_status === 1 ? 'live' : row.live_status === 0 || row.live_status === 2 ? 'offline' : 'unknown';
    const liveTime = typeof row.live_time === 'number' && Number.isSafeInteger(row.live_time) && row.live_time > 0 && row.live_time <= 32_503_680_000
      ? row.live_time * 1000 : null;
    const anchorName = text(row.uname, 100), title = text(row.title, 500),
      // Prefer the owner's room artwork over the live keyframe; face is an avatar and
      // must never be promoted to a room cover.
      cover = image(row.cover_from_user) || image(row.room_cover) || image(row.keyframe);
    rooms.push({ uid, roomId, status, online: null, liveStartTime: status === 'live' ? liveTime : null,
      ...(anchorName ? { anchorName } : {}), ...(title ? { title } : {}), ...(cover ? { cover } : {}) });
  }
  return { ...context, uids: [...context.uids], rooms: rooms.filter(room => !ambiguousRooms.has(room.roomId)), noRoomUids };
}
