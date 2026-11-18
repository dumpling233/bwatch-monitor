import type { LocalFanMedal, LocalMedalPage, LocalMedalRoomContext, LocalMedalSelection, LocalWearingMedal } from '../../shared/localMedals';
import { AccountVerificationRequired, BrokerError } from './broker';
import { LocalCookieTransport } from './cookieTransport';
import { LoginSessions } from './loginSessions';

const ROOT = 'https://api.live.bilibili.com';
export const MEDAL_PANEL_API = `${ROOT}/xlive/app-ucenter/v1/fansMedal/panel`;
export const MEDAL_CURRENT_API = `${ROOT}/xlive/app-ucenter/v1/fansMedal/user_medal_info`;
export const MEDAL_WEAR_API = `${ROOT}/xlive/app-ucenter/v1/fansMedal/wear`;
export const MEDAL_TAKE_OFF_API = `${ROOT}/xlive/app-ucenter/v1/fansMedal/take_off`;
const ROOM_INIT_API = `${ROOT}/room/v1/Room/room_init`;
export const MEDAL_PAGE_SIZE = 10;
const MAX_BYTES = 512 * 1024;
type Json = Record<string, unknown>;
const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const identifier = (value: unknown): string | undefined => {
  const result = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  return typeof result === 'string' && /^[1-9][0-9]{0,19}$/.test(result) ? result : undefined;
};
const text = (value: unknown, limit = 100): string => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, limit) : '';
const integer = (value: unknown, max: number): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : undefined;
const aborted = () => new DOMException('请求已取消', 'AbortError');
const unavailable = (message = '暂时无法读取粉丝勋章，请稍后重试') => new BrokerError('UNAVAILABLE', message);
class MedalRejection extends Error {
  constructor(message: string, readonly upstreamCode?: number) { super(message); }
}
export interface MedalDiagnostic {
  action: 'wear' | 'take_off';
  write: 'acknowledged' | 'rejected' | 'unconfirmed' | 'not-dispatched';
  upstreamCode?: number;
  display: 'present' | 'empty' | 'unavailable';
  status: LocalMedalSelection['status'];
}
const color = (value: unknown): string | undefined => {
  if (typeof value === 'string' && /^#[a-fA-F0-9]{6}$/.test(value)) return value.toLowerCase();
  // Official v2 fields may be rgb/rgba CSS strings. Export an opaque numeric
  // color only; arbitrary CSS, variables and URL expressions never cross RPC.
  if (typeof value === 'string') {
    const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(0|1|0?\.\d+))?\s*\)$/.exec(value);
    if (rgb && rgb.slice(1, 4).every(part => Number(part) <= 255)) return `#${rgb.slice(1, 4).map(part => Number(part).toString(16).padStart(2, '0')).join('')}`;
  }
  const numeric = typeof value === 'string' && /^\d{1,8}$/.test(value) ? Number(value) : value;
  return typeof numeric === 'number' && Number.isSafeInteger(numeric) && numeric >= 0 && numeric <= 0xffffff ? `#${numeric.toString(16).padStart(6, '0')}` : undefined;
};
function appearance(value: Json, fallback: Json = {}): Omit<LocalFanMedal, 'id' | 'targetUid' | 'roomId' | 'anchorName'> | null {
  const name = text(value.name ?? value.medal_name ?? fallback.medal_name, 40), level = integer(value.level ?? fallback.level, 1000);
  if (!name || !level) return null;
  const guardLevel = integer(value.guard_level ?? fallback.guard_level, 3);
  return { name, level, lighted: [true, 1].includes((value.is_light ?? value.is_lighted ?? fallback.is_lighted) as never),
    ...(color(value.medal_color ?? fallback.medal_color) ? { color: color(value.medal_color ?? fallback.medal_color) } : {}),
    ...(color(value.v2_medal_color_start ?? value.medal_color_start ?? fallback.medal_color_start) ? { colorStart: color(value.v2_medal_color_start ?? value.medal_color_start ?? fallback.medal_color_start) } : {}),
    ...(color(value.v2_medal_color_end ?? value.medal_color_end ?? fallback.medal_color_end) ? { colorEnd: color(value.v2_medal_color_end ?? value.medal_color_end ?? fallback.medal_color_end) } : {}),
    ...(color(value.v2_medal_color_border ?? value.medal_color_border ?? fallback.medal_color_border) ? { colorBorder: color(value.v2_medal_color_border ?? value.medal_color_border ?? fallback.medal_color_border) } : {}),
    ...(color(value.v2_medal_color_text) ? { colorText: color(value.v2_medal_color_text) } : {}),
    ...(color(value.v2_medal_color_level) ? { colorLevel: color(value.v2_medal_color_level) } : {}),
    ...(guardLevel === undefined ? {} : { guardLevel }) };
}

/** Only directory entries carry a verified upstream medal_id suitable for a user-selected write. */
export function projectMedalItems(payload: unknown, page = 1): { items: LocalFanMedal[]; total: number | null; hasMore: boolean; totalPages?: number; selectedMedalId?: string | null; selectionPageComplete: boolean } {
  const data = object(object(payload).data);
  if (!Array.isArray(data.list) || data.list.length > MEDAL_PAGE_SIZE || data.special_list !== undefined && (!Array.isArray(data.special_list) || data.special_list.length > 100)) throw unavailable();
  const items: LocalFanMedal[] = [], seen = new Set<string>(), wearingIds = new Set<string>(), declarations = new Map<string, string>();
  let completeSelection = true;
  for (const value of [...(Array.isArray(data.special_list) ? data.special_list : []), ...data.list]) {
    const row = object(value), medal = object(row.medal), display = object(row.uinfo_medal), anchor = object(row.anchor_info), room = object(row.room_info);
    const id = identifier(medal.medal_id), targetUid = identifier(medal.target_id ?? display.ruid ?? anchor.uid);
    if (medal.wearing_status === 1 && id) wearingIds.add(id);
    else if (medal.wearing_status !== 0) completeSelection = false;
    const fields = appearance(display, medal), roomId = identifier(room.room_id ?? room.roomid);
    if (!id || !targetUid || !fields) { completeSelection = false; continue; }
    const declaration = JSON.stringify([targetUid, fields.name, medal.wearing_status]);
    if (declarations.has(id) && declarations.get(id) !== declaration) completeSelection = false;
    declarations.set(id, declaration);
    if (seen.has(id)) continue;
    seen.add(id);
    items.push({ id, targetUid, ...fields, anchorName: text(anchor.nick_name ?? anchor.uname), ...(roomId ? { roomId } : {}) });
  }
  const total = integer(data.total_number, 100_000) ?? null;
  let totalPages: number | undefined;
  // The official account medal center uses page_info, not total_number or the
  // length of list: special/grouped rows need not fill ten ordinary slots.
  if (data.page_info !== undefined && data.page_info !== null) {
    const info = object(data.page_info), currentPage = integer(info.current_page, 10_000);
    totalPages = integer(info.total_page, 10_000);
    const emptyDirectory = totalPages === 0 && page === 1 && items.length === 0 && data.list.length === 0 &&
      (!Array.isArray(data.special_list) || data.special_list.length === 0) && (total === null || total === 0) && [0, 1].includes(currentPage ?? -1);
    if (totalPages === undefined || !emptyDirectory && (currentPage !== page || totalPages < page)) throw unavailable('勋章列表页码发生变化，请刷新重试');
  }
  // Legacy responses without page_info get one final empty ordinary-list read.
  // A short nonempty page is never proof that the account directory has ended.
  const hasMore = totalPages === undefined ? data.list.length > 0 : page < totalPages;
  const selectionPageComplete = completeSelection && wearingIds.size <= 1;
  const completeDirectory = page === 1 && !hasMore && (totalPages !== undefined || total === 0 && items.length === 0);
  const selectedMedalId = selectionPageComplete && wearingIds.size === 1 ? [...wearingIds][0] : wearingIds.size === 0 && selectionPageComplete && completeDirectory ? null : undefined;
  return { items, total, hasMore, ...(totalPages === undefined ? {} : { totalPages }), selectionPageComplete, ...(selectedMedalId !== undefined ? { selectedMedalId } : {}) };
}

/** Room panels supply ordering hints and verified owned IDs, never account-selection proofs. */
export function projectRoomMedalItems(payload: unknown): LocalFanMedal[] {
  const data = object(object(payload).data);
  // Reuse the same bounded row projection/deduplication, deliberately excluding
  // room-panel counts and pagination from the full account directory protocol.
  return projectMedalItems({ data: { list: data.list, special_list: data.special_list } }).items;
}

/** curr_show is the official room-context display and is not a medal_id/permission proof. */
export function projectCurrentMedal(payload: unknown, known: Iterable<LocalFanMedal>): LocalWearingMedal | null {
  const data = object(object(payload).data);
  if (!Object.prototype.hasOwnProperty.call(data, 'curr_show')) throw unavailable('暂时无法确认当前佩戴的勋章，请重试');
  if (data.curr_show === null) return null;
  const current = object(data.curr_show), targetUid = identifier(current.ruid ?? current.target_id), fields = appearance(current);
  if (!targetUid || !fields) {
    if (!Object.keys(current).length || (!current.name && !current.level && [undefined, null, 0, '0', ''].includes(current.ruid as never))) return null;
    throw unavailable('暂时无法确认当前佩戴的勋章，请重试');
  }
  const match = [...known].find(item => item.targetUid === targetUid && item.name === fields.name);
  const medalId = identifier(current.medal_id) ?? match?.id;
  return { ...fields, targetUid, anchorName: match?.anchorName ?? '', ...(medalId ? { id: medalId } : {}), ...(match?.roomId ? { roomId: match.roomId } : {}) };
}

/** No timers, persistence, automatic wear or replay: all work belongs to a visible user operation. */
export class LocalMedalService {
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly pending = new Set<AbortController>();
  private readonly rooms = new Map<string, { roomId: string; targetUid: string; until: number }>();
  private readonly catalogs = new Map<string, { items: Map<string, LocalFanMedal>; until: number }>();
  private readonly writes = new Set<string>();
  private readonly operations = new Map<string, { signature: string; at: number; task: Promise<LocalMedalSelection> }>();
  private blockedUntil = 0;
  constructor(private readonly options: { transport: LocalCookieTransport; sessions: LoginSessions; fetch?: typeof fetch; now?: () => number; onChange?(selection: LocalMedalSelection): void; onDiagnostic?(diagnostic: MedalDiagnostic): void }) {
    this.fetch = options.fetch ?? ((url, init) => fetch(url, init)); this.now = options.now ?? Date.now;
  }
  invalidate(): void {
    for (const controller of this.pending) controller.abort();
    this.rooms.clear(); this.catalogs.clear(); this.operations.clear();
  }
  private key(origin: string, authEpoch: string, uid: string): string { return `${origin}\n${authEpoch}\n${uid}`; }
  private known(key: string): Map<string, LocalFanMedal> {
    const current = this.catalogs.get(key);
    if (current && current.until > this.now()) return current.items;
    this.catalogs.delete(key); return new Map();
  }
  private remember(key: string, items: LocalFanMedal[]): void {
    const known = this.known(key);
    for (const item of items) { known.delete(item.id); known.set(item.id, item); }
    while (known.size > 2048) known.delete(known.keys().next().value!);
    this.catalogs.delete(key); this.catalogs.set(key, { items: known, until: this.now() + 60 * 60_000 });
    while (this.catalogs.size > 8) this.catalogs.delete(this.catalogs.keys().next().value!);
  }
  private validate(input: { roomId?: unknown; authEpoch?: unknown }, keys: string[]): { roomId: string; authEpoch: string } {
    if (Object.keys(input).some(key => !keys.includes(key)) || typeof input.roomId !== 'string' || !identifier(input.roomId) || typeof input.authEpoch !== 'string' || !/^[\w.-]{1,128}$/.test(input.authEpoch)) throw new BrokerError('INVALID_REQUEST', '粉丝勋章请求无效');
    return { roomId: input.roomId, authEpoch: input.authEpoch };
  }
  async page(origin: string, input: { roomId?: unknown; authEpoch?: unknown; page?: unknown; force?: unknown }, signal: AbortSignal): Promise<LocalMedalPage> {
    const { roomId, authEpoch } = this.validate(input, ['roomId', 'authEpoch', 'page', 'force']), page = input.page ?? 1;
    if (typeof page !== 'number' || !Number.isSafeInteger(page) || page < 1 || page > 1000 || input.force !== undefined && typeof input.force !== 'boolean') throw new BrokerError('INVALID_REQUEST', '勋章列表页码无效');
    return this.withSession(origin, authEpoch, signal, async (uid, operationSignal) => {
      const room = await this.room(origin, authEpoch, uid, roomId, operationSignal), url = new URL(MEDAL_PANEL_API);
      for (const [key, value] of Object.entries({ page: String(page), page_size: String(MEDAL_PAGE_SIZE) })) url.searchParams.set(key, value);
      const result = projectMedalItems(await this.request(origin, authEpoch, uid, url, operationSignal), page);
      const key = this.key(origin, authEpoch, uid); this.remember(key, result.items);
      let wearing: LocalWearingMedal | null = null, displayConfirmed = false;
      try { wearing = await this.current(origin, authEpoch, uid, room.targetUid, operationSignal); displayConfirmed = true; }
      catch (failure) {
        if (operationSignal.aborted || failure instanceof AccountVerificationRequired || failure instanceof BrokerError && failure.code !== 'UNAVAILABLE') throw failure;
      }
      return { accountUid: uid, authEpoch, roomId, page, pageSize: MEDAL_PAGE_SIZE, items: result.items, wearing, displayConfirmed, selectionPageComplete: result.selectionPageComplete,
        ...(result.selectedMedalId !== undefined ? { selectedMedalId: result.selectedMedalId } : {}), total: result.total, hasMore: result.hasMore,
        ...(result.totalPages === undefined ? {} : { totalPages: result.totalPages }), resolvedAt: this.now() };
    });
  }
  async roomContext(origin: string, input: { roomId?: unknown; authEpoch?: unknown }, signal: AbortSignal): Promise<LocalMedalRoomContext> {
    const { roomId, authEpoch } = this.validate(input, ['roomId', 'authEpoch']);
    return this.withSession(origin, authEpoch, signal, async (uid, operationSignal) => {
      const room = await this.room(origin, authEpoch, uid, roomId, operationSignal), url = new URL(MEDAL_PANEL_API);
      for (const [key, value] of Object.entries({ page: '1', page_size: String(MEDAL_PAGE_SIZE), room_id: room.roomId, target_id: room.targetUid })) url.searchParams.set(key, value);
      const items = projectRoomMedalItems(await this.request(origin, authEpoch, uid, url, operationSignal));
      this.remember(this.key(origin, authEpoch, uid), items);
      // The page owns bounded reuse/explicit refresh. Each actual RPC reads the
      // official panel; no second cache can hide a requested refresh here.
      return { accountUid: uid, authEpoch, roomId, targetUid: room.targetUid, items, resolvedAt: this.now() };
    });
  }
  async set(origin: string, input: { roomId?: unknown; authEpoch?: unknown; medalId?: unknown; operationId?: unknown }, signal: AbortSignal): Promise<LocalMedalSelection> {
    const { roomId, authEpoch } = this.validate(input, ['roomId', 'authEpoch', 'medalId', 'operationId']);
    if (input.medalId !== null && (typeof input.medalId !== 'string' || !identifier(input.medalId)) || input.operationId !== undefined && (typeof input.operationId !== 'string' || !/^[\w:-]{8,100}$/.test(input.operationId))) throw new BrokerError('INVALID_REQUEST', '请选择列表中的粉丝勋章');
    const medalId = input.medalId as string | null, operationId = input.operationId as string | undefined;
    let enteredWork = false;
    try { return await this.withSession(origin, authEpoch, signal, async (uid, operationSignal) => {
      enteredWork = true;
      const key = this.key(origin, authEpoch, uid), signature = `${key}\n${roomId}\n${medalId ?? ''}`, operationKey = operationId ? `${origin}\n${operationId}` : undefined;
      for (const [key, operation] of this.operations) if (operation.at < this.now() - 10 * 60_000) this.operations.delete(key);
      const previous = operationKey ? this.operations.get(operationKey) : undefined;
      if (previous) {
        if (previous.signature !== signature) throw new BrokerError('INVALID_REQUEST', '此次勋章切换请求已变更，请重新操作');
        return previous.task;
      }
      const selected = medalId === null ? null : this.known(key).get(medalId);
      if (medalId !== null && !selected) throw new BrokerError('INVALID_REQUEST', '请重新打开勋章列表后选择');
      if (this.writes.has(uid)) throw new BrokerError('STATE_CONFLICT', '正在切换勋章，请稍候');
      this.writes.add(uid);
      const task = this.change(origin, authEpoch, uid, roomId, selected, operationSignal).finally(() => this.writes.delete(uid));
      if (operationKey) {
        while (this.operations.size >= 32) this.operations.delete(this.operations.keys().next().value!);
        this.operations.set(operationKey, { signature, at: this.now(), task });
      }
      return task;
    }, true); } catch (failure) {
      if (enteredWork || signal.aborted || failure instanceof AccountVerificationRequired || failure instanceof BrokerError && failure.code !== 'UNAVAILABLE') throw failure;
      // A session/preparation failure before work cannot have issued this POST.
      // Attribute a safe rejection only to an already verified, still-current
      // bound account; otherwise preserve the normal identity error boundary.
      const uid = this.options.sessions.read(origin).expectedUid;
      if (!uid) throw new BrokerError('UNAUTHORIZED', '请先连接并授权本机 B站账号');
      return this.rejectBeforeDispatch(origin, authEpoch, uid, roomId, medalId === null ? 'take_off' : 'wear');
    }
  }
  private rejectBeforeDispatch(origin: string, authEpoch: string, uid: string, roomId: string, action: MedalDiagnostic['action']): LocalMedalSelection {
    this.options.sessions.assertChatCurrent(origin, authEpoch, uid);
    const result: LocalMedalSelection = { accountUid: uid, authEpoch, roomId, status: 'rejected', wearing: null,
      displayConfirmed: false, updatedAt: this.now(), message: '未能切换勋章，请稍后重试' };
    this.options.onDiagnostic?.({ action, write: 'not-dispatched', display: 'unavailable', status: result.status });
    return result;
  }
  private async change(origin: string, authEpoch: string, uid: string, roomId: string, selected: LocalFanMedal | null | undefined, signal: AbortSignal): Promise<LocalMedalSelection> {
    // The only path continuing beyond catch has either an acknowledged POST or
    // a dispatched POST, both of which require this room assignment first.
    let room!: { roomId: string; targetUid: string };
    let dispatched = false, acknowledged = false, rejection: unknown;
    try {
      room = await this.room(origin, authEpoch, uid, roomId, signal);
      const writeEpoch = this.options.transport.writeEpoch;
      const url = new URL(selected ? MEDAL_WEAR_API : MEDAL_TAKE_OFF_API);
      await this.request(origin, authEpoch, uid, url, signal, { target_id: room.targetUid, ...(selected ? { medal_id: selected.id } : {}) }, () => {
        if (writeEpoch !== this.options.transport.writeEpoch || signal.aborted) throw aborted();
        dispatched = true;
      });
      acknowledged = true;
    } catch (failure) {
      if (failure instanceof AccountVerificationRequired || failure instanceof BrokerError && failure.code !== 'UNAVAILABLE') throw failure;
      if (!dispatched) {
        // An identity-checked operation that never crossed beforePost is a safe
        // failure, not an uncertain account write. No display confirmation or
        // POST retry is needed; leave the prior selection/display untouched.
        return this.rejectBeforeDispatch(origin, authEpoch, uid, roomId, selected ? 'wear' : 'take_off');
      }
      rejection = failure;
    }
    // The POST acknowledgement decides the action result. curr_show is only the
    // room's official display; it cannot prove or disprove account selection.
    // One display read never repeats POST or substitutes the clicked row.
    let wearing: LocalWearingMedal | null = null, confirmed = false;
    try { wearing = await this.current(origin, authEpoch, uid, room.targetUid, signal); confirmed = true; }
    catch (failure) { if (failure instanceof AccountVerificationRequired || failure instanceof BrokerError && ['ACCOUNT_CHANGED', 'UNAUTHORIZED'].includes(failure.code)) throw failure; }
    const rejected = rejection instanceof MedalRejection;
    const result: LocalMedalSelection = { accountUid: uid, authEpoch, roomId, wearing,
      status: acknowledged ? 'applied' : rejected ? 'rejected' : 'unknown', displayConfirmed: confirmed, updatedAt: this.now(),
      ...(acknowledged ? { selectedMedalId: selected?.id ?? null } : {}),
      ...(rejected ? { message: (rejection as MedalRejection).message } : !acknowledged ? { message: '勋章切换结果尚未确认，请刷新查看，勿重复切换' } : {}) };
    this.options.onDiagnostic?.({ action: selected ? 'wear' : 'take_off', write: acknowledged ? 'acknowledged' : rejected ? 'rejected' : 'unconfirmed',
      ...(acknowledged ? { upstreamCode: 0 } : rejected && (rejection as MedalRejection).upstreamCode !== undefined ? { upstreamCode: (rejection as MedalRejection).upstreamCode } : {}),
      display: confirmed ? wearing ? 'present' : 'empty' : 'unavailable', status: result.status });
    if (result.status === 'applied') this.options.onChange?.(result);
    return result;
  }
  private async current(origin: string, authEpoch: string, uid: string, targetUid: string, signal: AbortSignal): Promise<LocalWearingMedal | null> {
    const url = new URL(MEDAL_CURRENT_API); url.searchParams.set('uid', uid); url.searchParams.set('up_uid', targetUid);
    return projectCurrentMedal(await this.request(origin, authEpoch, uid, url, signal), this.known(this.key(origin, authEpoch, uid)).values());
  }
  private async room(origin: string, authEpoch: string, uid: string, roomId: string, signal: AbortSignal): Promise<{ roomId: string; targetUid: string }> {
    const cached = this.rooms.get(roomId);
    if (cached && cached.until > this.now()) return cached;
    const url = new URL(ROOM_INIT_API); url.searchParams.set('id', roomId);
    const data = object((await this.request(origin, authEpoch, uid, url, signal, undefined, undefined, true)).data);
    const canonical = identifier(data.room_id), targetUid = identifier(data.uid), short = identifier(data.short_id);
    if (!canonical || !targetUid || canonical !== roomId && short !== roomId) throw unavailable('暂时无法确认直播间，请稍后重试');
    this.rooms.set(roomId, { roomId: canonical, targetUid, until: this.now() + 10 * 60_000 });
    while (this.rooms.size > 32) this.rooms.delete(this.rooms.keys().next().value!);
    return { roomId: canonical, targetUid };
  }
  private async body(response: Response, signal: AbortSignal): Promise<Json> {
    if (Number(response.headers.get('content-length')) > MAX_BYTES) { await response.body?.cancel().catch(() => {}); throw unavailable(); }
    const reader = response.body?.getReader(); if (!reader) throw unavailable();
    const decoder = new TextDecoder(); let size = 0, body = '';
    try { for (;;) { if (signal.aborted) throw aborted(); const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength; if (size > MAX_BYTES) throw unavailable(); body += decoder.decode(part.value, { stream: true }); }
      body += decoder.decode();
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    try { return object(JSON.parse(body)); } catch { throw unavailable(); }
  }
  private async request(origin: string, authEpoch: string, uid: string, url: URL, signal: AbortSignal, fields?: Record<string, string>, beforePost?: () => void, anonymous = false): Promise<Json> {
    this.options.sessions.assertChatCurrent(origin, authEpoch, uid);
    if (signal.aborted) throw aborted();
    if (this.blockedUntil > this.now()) throw new BrokerError('RATE_LIMITED', 'B站暂时限制勋章请求，请稍后重试', Math.ceil((this.blockedUntil - this.now()) / 1000));
    return this.options.transport.run(url, anonymous ? 'anonymous' : 'authenticated', signal, async (cookies, requestSignal) => {
      this.options.sessions.assertChatCurrent(origin, authEpoch, uid);
      if (!anonymous && (!cookies.SESSDATA || cookies.DedeUserID !== uid)) throw new BrokerError('ACCOUNT_CHANGED', 'B站账号已变化，请重新连接账号');
      let body: URLSearchParams | undefined;
      if (fields) {
        if (!cookies.bili_jct) throw unavailable('暂时无法切换勋章，请稍后重试');
        body = new URLSearchParams({ ...fields, csrf: cookies.bili_jct, csrf_token: cookies.bili_jct }); beforePost?.();
      }
      const response = await this.fetch(url, { method: fields ? 'POST' : 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store', signal: requestSignal, headers: { accept: 'application/json' }, ...(body ? { body } : {}) });
      if ([403, 412, 429].includes(response.status)) { await response.body?.cancel().catch(() => {}); this.rateLimited(response); }
      if (!response.ok) { await response.body?.cancel().catch(() => {}); throw unavailable(); }
      const result = await this.body(response, requestSignal);
      const code = result.code;
      if (typeof code !== 'number' || !Number.isSafeInteger(code)) throw unavailable();
      if ([-403, -412, -429, -352].includes(code)) this.rateLimited(response);
      if (code === -101 && !anonymous) throw new AccountVerificationRequired();
      if (code !== 0) throw new MedalRejection(text(result.errorMsg ?? result.message ?? result.msg, 160) || 'B站未接受此次勋章操作', code);
      this.options.sessions.assertChatCurrent(origin, authEpoch, uid);
      if (signal.aborted) throw aborted();
      return result;
    }, { method: fields ? 'POST' : 'GET' });
  }
  private rateLimited(response: Response): never {
    const retry = response.headers.get('retry-after'), parsed = retry && /^\d+$/.test(retry) ? Number(retry) : retry ? (Date.parse(retry) - this.now()) / 1000 : 30;
    const seconds = Math.min(86400, Math.max(30, Number.isFinite(parsed) ? Math.ceil(parsed) : 30));
    this.blockedUntil = Math.max(this.blockedUntil, this.now() + seconds * 1000);
    throw new BrokerError('RATE_LIMITED', 'B站暂时限制勋章请求，请稍后重试', seconds);
  }
  private async withSession<T>(origin: string, authEpoch: string, signal: AbortSignal, work: (uid: string, signal: AbortSignal) => Promise<T>, retainUncertainWrite = false): Promise<T> {
    if (signal.aborted) throw aborted(); if (this.pending.size >= 8) throw unavailable('粉丝勋章正在加载，请稍后再试');
    const controller = new AbortController(), cancel = () => controller.abort(), timeout = setTimeout(cancel, 12_000);
    signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel(); this.pending.add(controller);
    try {
      const session = await this.options.sessions.requireChat(origin, authEpoch, controller.signal), uid = session.account!.uid!;
      const result = await work(uid, controller.signal); this.options.sessions.assertChatCurrent(origin, authEpoch, uid);
      if (controller.signal.aborted && (!retainUncertainWrite || signal.aborted)) throw aborted(); return result;
    } catch (failure) {
      if (failure instanceof AccountVerificationRequired && !controller.signal.aborted) await this.options.sessions.verifyAccountRejection(origin, authEpoch);
      if (signal.aborted) throw aborted(); if (failure instanceof BrokerError || failure instanceof AccountVerificationRequired) throw failure;
      if (failure instanceof MedalRejection) throw unavailable(failure.message);
      throw unavailable();
    } finally { clearTimeout(timeout); signal.removeEventListener('abort', cancel); this.pending.delete(controller); }
  }
}
