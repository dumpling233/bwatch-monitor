import type { LocalFollowingRoom, LocalFollowingRoomsPage, LocalFollowingStatusBatch } from '../../shared/localFollowing';
import type { MonitorRoomDescriptor } from '../../shared/types';
import { localChatImage } from './localChatClient';
import { LocalLoginClientError } from './localLoginClient';
import { mergeCustomRoom, type CustomRoomRecord } from './customRooms';

const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const uid = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value);
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const time = (value: unknown): value is number | null => value === null || (typeof value === 'number' && Number.isFinite(value) && value > 0);
const invalid = () => new LocalLoginClientError('UNAVAILABLE', '关注直播间暂时无法读取，请稍后重试');

/** Treat the page bridge as untrusted and bind every result to the verified account. */
export function readFollowingRoomsPage(value: unknown, page: number, accountUid: string, authEpoch: string): LocalFollowingRoomsPage {
  const item = record(value);
  if (!item || item.accountUid !== accountUid || item.authEpoch !== authEpoch || item.page !== page ||
    !Number.isInteger(page) || page < 1 || page > 1000 || typeof item.pageSize !== 'number' || ![9, 50, 100].includes(item.pageSize) ||
    !(item.total === null || count(item.total)) || !(item.liveCount === null || count(item.liveCount)) ||
    typeof item.hasMore !== 'boolean' || !Array.isArray(item.rooms) || item.rooms.length > Number(item.pageSize) ||
    typeof item.resolvedAt !== 'number' || !Number.isFinite(item.resolvedAt) || item.resolvedAt <= 0) throw invalid();
  const rooms: LocalFollowingRoom[] = item.rooms.map(value => {
    const room = record(value);
    if (!room || !uid(room.roomId) || !uid(room.uid) || !text(room.anchorName, 128) || !text(room.title, 512) ||
      !['live', 'offline', 'unknown'].includes(String(room.status)) || !(room.online === null || count(room.online)) ||
      !time(room.liveStartTime) || !time(room.lastLiveTime)) throw invalid();
    const cover = localChatImage(room.cover);
    return { roomId: room.roomId, uid: room.uid, anchorName: room.anchorName, title: room.title,
      ...(cover ? { cover } : {}), status: room.status as LocalFollowingRoom['status'], online: null,
      liveStartTime: room.liveStartTime, lastLiveTime: room.lastLiveTime };
  });
  const relations = item.directorySource === 'relations';
  if (item.directorySource !== undefined && !['live', 'relations'].includes(String(item.directorySource))) throw invalid();
  if (relations && (!(item.accountTotal === null || count(item.accountTotal)) || !count(item.scannedAccounts) || Number(item.scannedAccounts) > Math.min(100, item.pageSize) ||
    !Array.isArray(item.scannedUids) || item.scannedUids.length > Math.min(100, item.pageSize) ||
    !item.scannedUids.every(uid) || new Set(item.scannedUids).size !== item.scannedUids.length ||
    rooms.some(room => !(item.scannedUids as unknown[]).includes(room.uid)) ||
    !Array.isArray(item.unresolvedUids) || item.unresolvedUids.length > Math.min(100, item.pageSize) ||
    new Set(item.unresolvedUids).size !== item.unresolvedUids.length || !item.unresolvedUids.every(value => uid(value) && (item.scannedUids as unknown[]).includes(value)))) throw invalid();
  return { accountUid, authEpoch, page, pageSize: item.pageSize as number, total: item.total as number | null, liveCount: item.liveCount as number | null,
    hasMore: item.hasMore, rooms, resolvedAt: item.resolvedAt,
    ...(item.directorySource === 'live' ? { directorySource: 'live' as const } : {}),
    ...(relations ? { directorySource: 'relations' as const, accountTotal: item.accountTotal as number | null,
      scannedAccounts: Number(item.scannedAccounts), scannedUids: item.scannedUids as string[], unresolvedUids: item.unresolvedUids as string[] } : {}) };
}

/** Only requested accounts may return observations; the store also checks room ownership. */
export function readFollowingStatusBatch(value: unknown, uids: string[], accountUid: string, authEpoch: string): LocalFollowingStatusBatch {
  const item = record(value), requested = new Set(uids);
  if (!uids.length || uids.length > 100 || requested.size !== uids.length || !uids.every(uid) || !item ||
    item.accountUid !== accountUid || item.authEpoch !== authEpoch || !Array.isArray(item.uids) ||
    item.uids.length !== uids.length || !item.uids.every((value, index) => value === uids[index]) ||
    !Array.isArray(item.rooms) || item.rooms.length > uids.length ||
    typeof item.resolvedAt !== 'number' || !Number.isFinite(item.resolvedAt) || item.resolvedAt <= 0) throw invalid();
  const seen = new Set<string>(), roomsSeen = new Set<string>();
  const rooms: LocalFollowingStatusBatch['rooms'] = item.rooms.map(value => {
    const room = record(value);
    if (!room || !uid(room.uid) || !requested.has(room.uid) || seen.has(room.uid) || !uid(room.roomId) || roomsSeen.has(room.roomId) ||
      !['live', 'offline', 'unknown'].includes(String(room.status)) || !(room.online === undefined || room.online === null || count(room.online)) || !time(room.liveStartTime) ||
      (room.anchorName !== undefined && !text(room.anchorName, 128)) || (room.title !== undefined && !text(room.title, 512))) throw invalid();
    const cover = room.cover === undefined ? undefined : localChatImage(room.cover);
    if (room.cover !== undefined && !cover) throw invalid();
    seen.add(room.uid); roomsSeen.add(room.roomId);
    return { uid: room.uid, roomId: room.roomId, status: room.status as LocalFollowingRoom['status'], liveStartTime: room.liveStartTime,
      ...(room.online !== undefined ? { online: room.online as number | null } : {}),
      ...(room.anchorName !== undefined ? { anchorName: room.anchorName as string } : {}),
      ...(room.title !== undefined ? { title: room.title as string } : {}), ...(cover ? { cover } : {}) };
  });
  const noRoomUids = item.noRoomUids;
  if (noRoomUids !== undefined && (!Array.isArray(noRoomUids) || noRoomUids.length > uids.length
    || new Set(noRoomUids).size !== noRoomUids.length || !noRoomUids.every(value => uid(value) && requested.has(value) && !seen.has(value)))) throw invalid();
  return { accountUid, authEpoch, uids: [...uids], rooms, resolvedAt: item.resolvedAt,
    ...(noRoomUids !== undefined ? { noRoomUids: [...noRoomUids as string[]] } : {}) };
}

export function followingRoomDescriptor(room: LocalFollowingRoom, resolvedAt: number): MonitorRoomDescriptor {
  const numericUid = Number(room.uid);
  return { source: 'custom', input: room.roomId, roomId: room.roomId, uid: Number.isSafeInteger(numericUid) ? numericUid : null,
    anchorName: room.anchorName, title: room.title, cover: room.cover, status: room.status,
    online: room.online, onlineStale: room.online === null,
    ...(room.online !== null ? { onlineLastSuccessAt: resolvedAt } : {}),
    liveStartTime: room.liveStartTime, lastUpdatedAt: resolvedAt, metadataFetchedAt: resolvedAt, metadataStale: false,
    fansCount: null, fansStale: false, guardCount: null, guardStale: false };
}

export interface FollowingRoomsSnapshot {
  rooms: MonitorRoomDescriptor[];
  loading: boolean;
  hasMore: boolean;
  total: number | null;
  liveCount: number | null;
  complete: boolean;
  indexing: boolean;
  refreshing: boolean;
  refreshKind: 'directory' | 'status' | null;
  loadedCount: number;
  scannedPages: number;
  incompleteReason: string;
  error: string;
  unmappedCount: number;
}
const empty = (): FollowingRoomsSnapshot => ({ rooms: [], loading: false, hasMore: true, total: null, liveCount: null,
  complete: false, indexing: false, refreshing: false, refreshKind: null, loadedCount: 0, scannedPages: 0, incompleteReason: '', error: '', unmappedCount: 0 });
const RESUME_MS = 5 * 60_000;
const DIRECTORY_CACHE_MS = 15 * 60_000;
const STATUS_CACHE_MS = 60_000;
const UNMAPPED_CACHE_MS = 5 * 60_000;
const MAX_BYTES = 8 * 1024 * 1024;
const PAGE_INTERVAL_MS = 500;
type Timer = ReturnType<typeof globalThis.setTimeout>;
interface FollowingTimers { set: (callback: () => void, delay: number) => Timer; clear: (timer: Timer) => void }
const timers: FollowingTimers = { set: (callback, delay) => globalThis.setTimeout(callback, delay), clear: timer => globalThis.clearTimeout(timer) };
interface Scan {
  rooms: Map<string, MonitorRoomDescriptor>;
  uids: Map<string, string>;
  bytes: number;
  page: number;
  startedAt: number;
  total: number | null;
  liveCount: number | null;
  invalidTotal: boolean;
  invalidLive: boolean;
  stopped: boolean;
  pageSize: number | null;
  directorySource?: 'live' | 'relations';
  relationUids: Set<string>;
  unresolvedUids: Set<string>;
  relationBytes: number;
  accountTotal: number | null;
  previousOwners: Map<string, string[]>;
  previousRooms: Map<string, MonitorRoomDescriptor>;
  noRoomAccounts: Set<string>;
}
interface StatusScan {
  rooms: Map<string, MonitorRoomDescriptor>;
  uids: string[];
  owners: Map<string, string[]>;
  offset: number;
  bytes: number;
  startedAt: number;
  roomUids: Map<string, string>;
  noRoomAccounts: Set<string>;
  checksUnmapped: boolean;
}
const roomBytes = (value: MonitorRoomDescriptor) => JSON.stringify(value).length * 2 + 96;
const accountBytes = (value: string) => value.length * 2 + 64;
function ownersByUid(rooms: ReadonlyMap<string, string>): Map<string, string[]> {
  const owners = new Map<string, string[]>();
  for (const [roomId, owner] of rooms) { const ids = owners.get(owner); if (ids) ids.push(roomId); else owners.set(owner, [roomId]); }
  return owners;
}
const unknownRoom = (room: MonitorRoomDescriptor, resolvedAt: number): MonitorRoomDescriptor => ({ ...room,
  status: 'unknown', metadataStale: true, onlineStale: room.online !== null || room.onlineStale,
  lastUpdatedAt: resolvedAt, metadataFetchedAt: resolvedAt });

/** A finite foreground index: one request, at most two page starts per second.
 * Completed directories are reused; only supported foreground status is monitored.
 * Refreshes replace a complete snapshot atomically. */
export class FollowingRoomsStore {
  private state = empty();
  private readonly listeners = new Set<() => void>();
  private scope = '';
  private active = false;
  private fetchedAt = 0;
  private statusAt = 0;
  private unmappedAt = 0;
  private supportsStatus = false;
  private committedUids = new Map<string, string>();
  private committedAccounts = new Set<string>();
  private noRoomAccounts = new Set<string>();
  private details = new Map<string, CustomRoomRecord>();
  private retryAt = 0;
  private lastStartedAt = -Infinity;
  private scan?: Scan;
  private statusScan?: StatusScan;
  private pending?: AbortController;
  private timer?: Timer;
  private refreshTimer?: Timer;
  constructor(private readonly resolve: (page: number, signal: AbortSignal) => Promise<LocalFollowingRoomsPage>, private readonly now = Date.now,
    private readonly clock: FollowingTimers = timers,
    private readonly resolveStatus?: (uids: string[], signal: AbortSignal) => Promise<LocalFollowingStatusBatch>) {}
  getSnapshot = () => this.state;
  getScope = () => this.scope;
  getRoomUid = (roomId: string) => this.scan?.uids.get(roomId) ?? this.committedUids.get(roomId);
  getTrustedRoomIds = () => [...this.details.keys()];
  /** Canonical observations stay in page memory, independent of the follow graph. */
  applyRoomInfo = (roomId: string, info: CustomRoomRecord, scope = this.scope) => {
    if (!scope || scope !== this.scope || info.roomId !== roomId || !this.getRoomUid(roomId)) return;
    const previous = this.state.rooms.find(room => room.roomId === roomId);
    if (!previous || previous.uid !== null && info.uid !== null && previous.uid !== info.uid) return;
    const current = this.details.get(roomId);
    if (current && current.lastUpdatedAt > info.lastUpdatedAt) return;
    const merged = mergeCustomRoom(current ?? { ...previous, source: 'custom', input: roomId }, info, this.now());
    this.details.delete(roomId); this.details.set(roomId, merged);
    let bytes = [...this.details.values()].reduce((total, room) => total + roomBytes(room), 0);
    while (this.details.size > 128 || bytes > 1024 * 1024) {
      const oldest = this.details.keys().next().value!;
      bytes -= roomBytes(this.details.get(oldest)!); this.details.delete(oldest);
    }
    const rooms = this.state.rooms.map(room => room.roomId === roomId ? this.withDetails(room) : room);
    this.patch({ rooms, liveCount: rooms.some(room => room.status === 'unknown') ? null : rooms.filter(room => room.status === 'live').length });
  };
  private withDetails(room: MonitorRoomDescriptor): MonitorRoomDescriptor {
    const info = this.details.get(room.roomId);
    if (!info || room.uid !== null && info.uid !== null && room.uid !== info.uid) return room;
    const details = mergeCustomRoom(undefined, info, this.now());
    const newerStatus = (room.metadataFetchedAt ?? 0) > (details.metadataFetchedAt ?? 0);
    const status = newerStatus ? room.status : details.status;
    return { ...room, ...details, source: room.source, status,
      metadataFetchedAt: Math.max(room.metadataFetchedAt ?? 0, details.metadataFetchedAt ?? 0),
      ...(newerStatus ? { liveStartTime: room.liveStartTime, anchorName: room.anchorName, title: room.title,
        metadataStale: room.metadataStale, metadataError: room.metadataError } : {}),
      ...(status === 'offline' ? { online: null, onlineStale: false, onlineLastSuccessAt: undefined } : {}) };
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private patch(patch: Partial<FollowingRoomsSnapshot>) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(); }
  setContext(scope: string, active: boolean, supportsStatus = this.supportsStatus) {
    if (this.scope !== scope) {
      this.cancel(); this.active = false; this.scope = scope; this.scan = undefined; this.statusScan = undefined;
      this.fetchedAt = 0; this.statusAt = 0; this.committedUids.clear(); this.details.clear();
      this.unmappedAt = 0;
      this.committedAccounts.clear(); this.noRoomAccounts.clear();
      // Keep an upstream cooldown across account changes, just like the transport.
      this.state = empty(); for (const listener of this.listeners) listener();
    }
    const lostStatus = this.supportsStatus && !supportsStatus;
    this.supportsStatus = supportsStatus && Boolean(this.resolveStatus);
    if (lostStatus) this.cancelRefreshTimer();
    if (lostStatus && this.statusScan) { this.cancel(); this.statusScan = undefined; this.patch({ refreshing: false, refreshKind: null }); }
    const opening = active && !this.active;
    this.active = active && Boolean(scope);
    if (!this.active) { this.cancel(); return; }
    if (!opening && !lostStatus) return;
    if (this.scan) {
      if (this.now() - this.scan.startedAt >= RESUME_MS) this.startScan();
      else if (!this.scan.stopped) this.schedule();
    } else if (!this.state.complete || this.directoryExpired()) this.startScan();
    else if (this.supportsStatus && this.statusDue()) {
      if (this.statusScan && this.now() - this.statusScan.startedAt < RESUME_MS) this.schedule();
      else this.startStatusScan();
    } else this.armRefreshTimer();
  }
  private directoryExpired() { return this.now() - this.fetchedAt >= (this.supportsStatus ? DIRECTORY_CACHE_MS : RESUME_MS); }
  private unmappedAccounts(): string[] {
    const mapped = new Set(this.committedUids.values());
    return [...this.committedAccounts].filter(owner => !mapped.has(owner) && !this.noRoomAccounts.has(owner));
  }
  private knownStatusAccounts(): string[] {
    return [...new Set(this.committedUids.values())].filter(owner => !this.noRoomAccounts.has(owner));
  }
  private statusDue() {
    return (this.knownStatusAccounts().length > 0 && this.now() - this.statusAt >= STATUS_CACHE_MS)
      || (this.unmappedAccounts().length > 0 && this.now() - this.unmappedAt >= UNMAPPED_CACHE_MS);
  }
  private cancelRefreshTimer() {
    if (this.refreshTimer !== undefined) { this.clock.clear(this.refreshTimer); this.refreshTimer = undefined; }
  }
  private armRefreshTimer() {
    this.cancelRefreshTimer();
    if (!this.active || !this.scope || !this.supportsStatus || !this.resolveStatus || !this.state.complete
      || this.scan || this.statusScan || this.pending || this.timer !== undefined
      || this.state.error || this.state.incompleteReason || this.now() < this.retryAt) return;
    // Measure from the completed atomic sample, never from each batch or render.
    // One deadline chooses the next status sample or low-frequency directory sync.
    const deadline = Math.min(this.fetchedAt + DIRECTORY_CACHE_MS,
      this.knownStatusAccounts().length ? this.statusAt + STATUS_CACHE_MS : Infinity,
      this.unmappedAccounts().length ? this.unmappedAt + UNMAPPED_CACHE_MS : Infinity);
    this.refreshTimer = this.clock.set(() => {
      this.refreshTimer = undefined;
      if (!this.active || !this.scope || !this.supportsStatus || this.scan || this.statusScan || this.pending
        || this.state.error || this.state.incompleteReason) return;
      if (this.directoryExpired()) this.startScan(); else this.startStatusScan();
    }, Math.max(0, deadline - this.now()));
  }
  private cancel() {
    this.cancelRefreshTimer();
    if (this.timer !== undefined) { this.clock.clear(this.timer); this.timer = undefined; }
    const pending = this.pending; this.pending = undefined; pending?.abort();
    if (this.state.loading || this.state.indexing) this.patch({ loading: false, indexing: false });
  }
  private startScan() {
    if (!this.scope || !this.active) return;
    this.cancel();
    this.statusScan = undefined;
    this.scan = { rooms: new Map(), uids: new Map(), bytes: 0, page: 0, startedAt: this.now(), total: null, liveCount: null,
      invalidTotal: false, invalidLive: false, stopped: false, pageSize: null,
      relationUids: new Set(), unresolvedUids: new Set(), relationBytes: 0, accountTotal: null,
      previousOwners: ownersByUid(this.committedUids), previousRooms: new Map(this.state.rooms.map(room => [room.roomId, room])), noRoomAccounts: new Set() };
    this.patch({ refreshing: this.state.complete, refreshKind: 'directory', loadedCount: 0, scannedPages: 0, incompleteReason: '', error: '', hasMore: true });
    this.schedule();
  }
  private startStatusScan() {
    if (!this.scope || !this.active || !this.supportsStatus || !this.resolveStatus || !this.state.complete || !this.committedAccounts.size) return;
    const checksUnmapped = this.now() - this.unmappedAt >= UNMAPPED_CACHE_MS;
    const requested = new Set(this.knownStatusAccounts());
    if (checksUnmapped) for (const owner of this.unmappedAccounts()) requested.add(owner);
    if (!requested.size) { this.armRefreshTimer(); return; }
    this.cancel(); this.scan = undefined;
    const owners = ownersByUid(this.committedUids);
    this.statusScan = { rooms: new Map(this.state.rooms.map(room => [room.roomId, room])),
      uids: [...requested], owners, offset: 0,
      bytes: this.state.rooms.reduce((sum, room) => sum + roomBytes(room), 0) + [...this.committedAccounts].reduce((sum, owner) => sum + accountBytes(owner), 0),
      startedAt: this.now(), roomUids: new Map(this.committedUids), noRoomAccounts: new Set(this.noRoomAccounts), checksUnmapped };
    this.patch({ refreshing: true, refreshKind: 'status', error: '', incompleteReason: '' });
    this.schedule();
  }
  /** Explicit retry resumes the failed page; a terminal malformed scan starts afresh. */
  loadMore = () => {
    if (!this.active || this.pending || this.timer !== undefined) return;
    if (this.statusScan) {
      if (this.directoryExpired()) this.startScan();
      else if (this.now() - this.statusScan.startedAt >= RESUME_MS) this.startStatusScan();
      else this.schedule();
    }
    else if (!this.scan) { if (!this.state.complete) this.startScan(); }
    else if (this.scan.stopped || this.now() - this.scan.startedAt >= RESUME_MS) this.startScan(); else this.schedule();
  };
  reload = () => { if (!this.pending && this.timer === undefined) this.startScan(); };
  private schedule() {
    if (!this.scope || !this.active || (!this.statusScan && (!this.scan || this.scan.stopped)) || this.pending || this.timer !== undefined) return;
    if (this.now() < this.retryAt) { this.patch({ indexing: false, error: 'B站暂时限制读取，请稍后再试' }); return; }
    this.patch({ indexing: true, error: '', incompleteReason: '' });
    const delay = Math.max(0, this.lastStartedAt + PAGE_INTERVAL_MS - this.now());
    const fetch = () => this.statusScan ? this.fetchStatus() : this.fetch();
    if (!delay) void fetch();
    else this.timer = this.clock.set(() => { this.timer = undefined; void fetch(); }, delay);
  }
  private stopIncomplete(reason: string) {
    if (this.scan) this.scan.stopped = true;
    this.patch({ indexing: false, hasMore: false, incompleteReason: reason });
  }
  private stageDirectoryRoom(scan: Scan, descriptor: MonitorRoomDescriptor, owner: string): boolean {
    const previous = scan.rooms.get(descriptor.roomId);
    const bytes = scan.bytes + roomBytes(descriptor) - (previous ? roomBytes(previous) : 0);
    if (bytes + scan.relationBytes > MAX_BYTES) {
      this.stopIncomplete('关注列表较大，本次未能读取完整，请稍后刷新'); return false;
    }
    scan.bytes = bytes; scan.rooms.set(descriptor.roomId, descriptor); scan.uids.set(descriptor.roomId, owner); return true;
  }
  private async fetch() {
    const scan = this.scan;
    if (!this.scope || !this.active || !scan || scan.stopped || this.pending) return;
    const page = scan.page + 1;
    if (page > 1000) { this.stopIncomplete('关注列表较大，本次未能读取完整，请稍后刷新'); return; }
    const controller = new AbortController(), scope = this.scope;
    this.pending = controller; this.lastStartedAt = this.now(); this.patch({ loading: true, indexing: true, error: '' });
    try {
      const result = await this.resolve(page, controller.signal);
      if (this.pending !== controller || controller.signal.aborted || this.scope !== scope || this.scan !== scan || !this.active) return;
      if (![9, 50, 100].includes(result.pageSize) || (scan.pageSize !== null && result.pageSize !== scan.pageSize)) {
        this.stopIncomplete('B站返回的关注列表发生变化，请刷新重试'); return;
      }
      scan.pageSize = result.pageSize;
      const source = result.directorySource ?? 'live';
      if (scan.directorySource && scan.directorySource !== source) { this.stopIncomplete('关注来源发生变化，请刷新重试'); return; }
      scan.directorySource = source;
      let accountAdditions = 0;
      if (source === 'relations') {
        if (result.accountTotal !== null && result.accountTotal !== undefined) scan.accountTotal = Math.max(scan.accountTotal ?? 0, result.accountTotal);
        for (const owner of result.scannedUids ?? []) if (!scan.relationUids.has(owner)) {
          scan.relationUids.add(owner); accountAdditions++; scan.relationBytes += accountBytes(owner);
        }
        const mapped = new Set(result.rooms.map(room => room.uid)), unresolved = new Set(result.unresolvedUids ?? []);
        for (const owner of result.scannedUids ?? []) {
          scan.unresolvedUids.delete(owner); scan.noRoomAccounts.delete(owner);
          if (unresolved.has(owner)) scan.unresolvedUids.add(owner);
          else if (!mapped.has(owner)) scan.noRoomAccounts.add(owner);
        }
        if (scan.bytes + scan.relationBytes > MAX_BYTES) { this.stopIncomplete('关注列表较大，本次未能读取完整，请稍后刷新'); return; }
      }
      let additions = 0;
      for (const room of result.rooms) {
        const previous = scan.rooms.get(room.roomId);
        if (previous && scan.uids.get(room.roomId) !== room.uid) {
          this.stopIncomplete('B站返回的房间信息发生变化，本次列表未能读取完整，请刷新重试'); return;
        }
        // A directory refresh cannot silently rebind a previously known room.
        const originalOwner = this.committedUids.get(room.roomId);
        if (originalOwner && originalOwner !== room.uid) continue;
        const originalRooms = scan.previousOwners.get(room.uid) ?? [];
        if (originalRooms.length && !originalRooms.includes(room.roomId)) {
          for (const roomId of originalRooms) {
            const original = scan.previousRooms.get(roomId);
            if (original && !this.stageDirectoryRoom(scan, unknownRoom(original, result.resolvedAt), room.uid)) return;
          }
          continue;
        }
        let descriptor = followingRoomDescriptor(room, result.resolvedAt);
        if (previous && result.resolvedAt < (previous.metadataFetchedAt ?? 0)) continue;
        if (previous && descriptor.status === 'unknown') descriptor = { ...descriptor, status: previous.status };
        if (!this.stageDirectoryRoom(scan, descriptor, room.uid)) return;
        if (!previous) additions++;
      }
      scan.page = page;
      const rows = [...scan.rooms.values()].map(room => this.withDetails(room)), live = rows.filter(room => room.status === 'live').length;
      const total = result.total ?? scan.total, liveCount = result.liveCount ?? scan.liveCount;
      if (total !== null && total < rows.length) scan.invalidTotal = true;
      if (liveCount !== null && (liveCount < live || (total !== null && liveCount > total))) scan.invalidLive = true;
      scan.total = scan.invalidTotal ? null : total;
      scan.liveCount = scan.invalidLive ? null : liveCount;
      this.patch({ loadedCount: rows.length, scannedPages: page,
        ...(!this.state.complete ? { rooms: rows, total: scan.total, liveCount: scan.liveCount } : {}) });
      const remaining = source !== 'relations' && scan.total !== null && scan.total > rows.length;
      if ((source === 'relations' ? !accountAdditions && result.hasMore : !additions && (result.hasMore || remaining)) || (!result.hasMore && remaining)) {
        this.stopIncomplete('B站未返回完整关注列表，当前结果可能不全，请重试'); return;
      }
      if (!result.hasMore) {
        if (source === 'relations' && scan.accountTotal !== null && scan.relationUids.size < scan.accountTotal) {
          this.stopIncomplete('部分关注账号尚未读取完整，请刷新重试'); return;
        }
        const accounts = source === 'relations' ? scan.relationUids : new Set(scan.uids.values());
        if (source === 'relations') {
          for (const [roomId, owner] of this.committedUids) {
            if (!accounts.has(owner) || scan.uids.has(roomId)) continue;
            const previous = scan.previousRooms.get(roomId);
            if (previous && !this.stageDirectoryRoom(scan, unknownRoom(previous, result.resolvedAt), owner)) return;
          }
        }
        const completed = [...scan.rooms.values()].map(room => this.withDetails(room));
        for (const roomId of this.details.keys()) if (!scan.uids.has(roomId)) this.details.delete(roomId);
        this.fetchedAt = this.now(); this.statusAt = this.now(); this.committedUids = scan.uids;
        this.unmappedAt = this.now();
        this.committedAccounts = new Set(accounts); this.noRoomAccounts = scan.noRoomAccounts; this.scan = undefined;
        this.patch({ rooms: completed, total: completed.length, loadedCount: completed.length,
          unmappedCount: this.unmappedAccounts().length,
          liveCount: completed.some(room => room.status === 'unknown') ? null : completed.filter(room => room.status === 'live').length, complete: true, indexing: false,
          refreshing: false, refreshKind: null, hasMore: false, incompleteReason: '', error: '' });
      }
    } catch (error) {
      if (this.pending !== controller || controller.signal.aborted || this.scope !== scope || this.scan !== scan) return;
      if (error instanceof LocalLoginClientError && error.retryAfter) this.retryAt = this.now() + error.retryAfter * 1000;
      this.patch({ indexing: false, error: error instanceof Error && error.name !== 'AbortError' ? error.message : '关注直播间暂时无法读取，请重试' });
    } finally {
      if (this.pending === controller) {
        this.pending = undefined; this.patch({ loading: false });
        if (this.state.indexing && this.scan === scan && !scan.stopped) this.schedule();
        else this.armRefreshTimer();
      }
    }
  }
  private async fetchStatus() {
    const scan = this.statusScan;
    if (!this.scope || !this.active || !scan || !this.resolveStatus || !this.supportsStatus || this.pending) return;
    const requested = scan.uids.slice(scan.offset, scan.offset + 100);
    if (!requested.length) return;
    const controller = new AbortController(), scope = this.scope;
    this.pending = controller; this.lastStartedAt = this.now(); this.patch({ loading: true, indexing: true, error: '' });
    try {
      const result = await this.resolveStatus(requested, controller.signal);
      if (this.pending !== controller || controller.signal.aborted || this.scope !== scope || this.statusScan !== scan || !this.active) return;
      const results = new Map(result.rooms.map(room => [room.uid, room]));
      const noRooms = new Set(result.noRoomUids ?? []);
      const stage = (descriptor: MonitorRoomDescriptor, owner: string) => {
        const previous = scan.rooms.get(descriptor.roomId);
        const bytes = scan.bytes + roomBytes(descriptor) - (previous ? roomBytes(previous) : 0);
        if (bytes > MAX_BYTES) throw new LocalLoginClientError('UNAVAILABLE', '关注列表较大，本次未能更新开播状态，请稍后重试');
        scan.bytes = bytes; scan.rooms.set(descriptor.roomId, descriptor); scan.roomUids.set(descriptor.roomId, owner);
      };
      for (const originalUid of requested) {
        const observed = results.get(originalUid), owned = scan.owners.get(originalUid) ?? [];
        if (noRooms.has(originalUid)) scan.noRoomAccounts.add(originalUid); else scan.noRoomAccounts.delete(originalUid);
        if (!owned.length && observed && this.committedAccounts.has(originalUid)) {
          // Previously unmapped followed accounts may acquire a room later.
          // A positive room id is required, and another owner's room is never rebound.
          const owner = scan.roomUids.get(observed.roomId);
          if (!owner || owner === originalUid) {
            stage(followingRoomDescriptor({ ...observed, anchorName: observed.anchorName || `房间 ${observed.roomId}`,
              title: observed.title || (observed.status === 'live' ? '直播中' : 'B站直播间'), online: null, lastLiveTime: null }, result.resolvedAt), originalUid);
            scan.owners.set(originalUid, [observed.roomId]);
          }
          continue;
        }
        for (const roomId of owned) {
          const previous = scan.rooms.get(roomId)!;
          const descriptor: MonitorRoomDescriptor = observed?.roomId === roomId ? { ...previous, status: observed.status, liveStartTime: observed.liveStartTime,
            anchorName: observed.anchorName || previous.anchorName, title: observed.title || previous.title, cover: observed.cover ?? previous.cover,
            ...(observed.status === 'offline' ? { online: null, onlineStale: false, onlineLastSuccessAt: undefined } : {}),
            lastUpdatedAt: result.resolvedAt, metadataFetchedAt: result.resolvedAt, metadataStale: observed.status === 'unknown' }
            : unknownRoom(previous, result.resolvedAt);
          stage(descriptor, originalUid);
        }
      }
      scan.offset += requested.length;
      if (scan.offset >= scan.uids.length) {
        const rows = [...scan.rooms.values()].map(room => this.withDetails(room)); this.statusAt = this.now(); this.statusScan = undefined;
        this.committedUids = scan.roomUids; this.noRoomAccounts = scan.noRoomAccounts;
        if (scan.checksUnmapped) this.unmappedAt = this.now();
        this.patch({ rooms: rows, total: rows.length, liveCount: rows.some(room => room.status === 'unknown') ? null : rows.filter(room => room.status === 'live').length,
          unmappedCount: this.unmappedAccounts().length,
          indexing: false, refreshing: false, refreshKind: null, error: '', incompleteReason: '' });
      }
    } catch (error) {
      if (this.pending !== controller || controller.signal.aborted || this.scope !== scope || this.statusScan !== scan) return;
      if (error instanceof LocalLoginClientError && error.retryAfter) this.retryAt = this.now() + error.retryAfter * 1000;
      this.patch({ indexing: false, error: error instanceof Error && error.name !== 'AbortError' ? error.message : '开播状态暂时无法更新，请重试' });
    } finally {
      if (this.pending === controller) {
        this.pending = undefined; this.patch({ loading: false });
        if (this.state.indexing && this.statusScan === scan) this.schedule();
        else this.armRefreshTimer();
      }
    }
  }
  dispose() { this.active = false; this.cancel(); }
}
