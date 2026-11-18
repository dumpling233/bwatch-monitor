import type { LocalFanMedal, LocalWearingMedal, LocalMedalPage, LocalMedalRoomContext, LocalMedalSelection } from '../../shared/localMedals';
import { LocalLoginClientError } from './localLoginClient';

const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const id = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
const clean = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value);
const invalid = () => new LocalLoginClientError('UNAVAILABLE', '粉丝勋章暂时无法加载，请稍后重试');

function readWearingMedal(value: unknown): LocalWearingMedal {
  const item = record(value);
  if (!item || (item.id !== undefined && !id(item.id)) || !id(item.targetUid) || !clean(item.name, 40) || !item.name || !clean(item.anchorName, 100) ||
    !Number.isInteger(item.level) || Number(item.level) < 1 || Number(item.level) > 1000 || typeof item.lighted !== 'boolean' ||
    (item.roomId !== undefined && !id(item.roomId))) throw invalid();
  const colors: Partial<LocalFanMedal> = {};
  for (const field of ['color', 'colorStart', 'colorEnd', 'colorBorder', 'colorText', 'colorLevel'] as const) {
    if (item[field] === undefined) continue;
    if (typeof item[field] !== 'string' || !/^#[0-9a-f]{6}$/i.test(item[field])) throw invalid();
    colors[field] = item[field];
  }
  return { ...(item.id ? { id: item.id as string } : {}), targetUid: item.targetUid, name: item.name, level: Number(item.level), anchorName: item.anchorName,
    lighted: item.lighted, ...(item.roomId ? { roomId: item.roomId as string } : {}), ...colors,
    ...(Number.isInteger(item.guardLevel) && Number(item.guardLevel) >= 0 && Number(item.guardLevel) <= 3 ? { guardLevel: Number(item.guardLevel) } : {}) };
}
function readMedal(value: unknown): LocalFanMedal {
  const medal = readWearingMedal(value);
  if (!medal.id) throw invalid();
  return { ...medal, id: medal.id };
}
function readSelectionFacts(item: Record<string, unknown>) {
  if (item.selectedMedalId !== undefined && item.selectedMedalId !== null && !id(item.selectedMedalId) ||
    item.displayConfirmed !== undefined && typeof item.displayConfirmed !== 'boolean' || item.displayConfirmed === false && item.wearing !== null) throw invalid();
  return { ...(item.selectedMedalId !== undefined ? { selectedMedalId: item.selectedMedalId as string | null } : {}),
    ...(item.displayConfirmed !== undefined ? { displayConfirmed: item.displayConfirmed as boolean } : {}) };
}

export function readMedalPage(value: unknown, accountUid: string, authEpoch: string, roomId: string, page: number): LocalMedalPage {
  const item = record(value);
  if (!item || item.accountUid !== accountUid || item.authEpoch !== authEpoch || item.roomId !== roomId || item.page !== page || !Array.isArray(item.items) ||
    item.items.length > 110 || typeof item.hasMore !== 'boolean' || !Number.isInteger(item.pageSize) || Number(item.pageSize) < 1 || Number(item.pageSize) > 50 ||
    !(item.total === null || Number.isSafeInteger(item.total) && Number(item.total) >= 0) ||
    item.totalPages !== undefined && (!Number.isSafeInteger(item.totalPages) || Number(item.totalPages) < 0 || Number(item.totalPages) > 10000 ||
      item.hasMore !== (page < Number(item.totalPages)) || Number(item.totalPages) > 0 && page > Number(item.totalPages) ||
      Number(item.totalPages) === 0 && (page !== 1 || item.items.length !== 0 || item.total !== null && item.total !== 0)) ||
    item.selectionPageComplete !== undefined && typeof item.selectionPageComplete !== 'boolean' ||
    typeof item.resolvedAt !== 'number' || !Number.isFinite(item.resolvedAt) || item.resolvedAt < 0) throw invalid();
  const items = item.items.map(readMedal);
  if (new Set(items.map(item => item.id)).size !== items.length) throw invalid();
  return { accountUid, authEpoch, roomId, page, pageSize: Number(item.pageSize), total: item.total as number | null, items,
    wearing: item.wearing === null ? null : readWearingMedal(item.wearing), ...readSelectionFacts(item),
    ...(item.selectionPageComplete !== undefined ? { selectionPageComplete: item.selectionPageComplete as boolean } : {}),
    ...(item.totalPages !== undefined ? { totalPages: Number(item.totalPages) } : {}), hasMore: item.hasMore, resolvedAt: item.resolvedAt };
}

export function readMedalSelection(value: unknown, accountUid: string, authEpoch: string, roomId: string): LocalMedalSelection {
  const item = record(value);
  if (!item || item.accountUid !== accountUid || item.authEpoch !== authEpoch || item.roomId !== roomId || !['applied', 'rejected', 'unknown'].includes(String(item.status)) ||
    typeof item.updatedAt !== 'number' || !Number.isFinite(item.updatedAt) || item.updatedAt < 0 ||
    (item.message !== undefined && !clean(item.message, 200))) throw invalid();
  return { accountUid, authEpoch, roomId, status: item.status as LocalMedalSelection['status'],
    wearing: item.wearing === null ? null : readWearingMedal(item.wearing), ...readSelectionFacts(item), updatedAt: item.updatedAt,
    ...(item.message ? { message: item.message as string } : {}) };
}

export function readMedalRoomContext(value: unknown, accountUid: string, authEpoch: string, roomId: string): LocalMedalRoomContext {
  const item = record(value);
  if (!item || item.accountUid !== accountUid || item.authEpoch !== authEpoch || item.roomId !== roomId || !id(item.targetUid) ||
    !Array.isArray(item.items) || item.items.length > 110 || typeof item.resolvedAt !== 'number' || !Number.isFinite(item.resolvedAt) || item.resolvedAt < 0) throw invalid();
  const items = item.items.map(readMedal);
  if (new Set(items.map(item => item.id)).size !== items.length) throw invalid();
  return { accountUid, authEpoch, roomId, targetUid: item.targetUid, items, resolvedAt: item.resolvedAt };
}

export interface LocalMedalSnapshot {
  scope: string;
  revision: number;
  items: LocalFanMedal[];
  roomItems?: LocalFanMedal[];
  roomLoading?: boolean;
  roomError?: string;
  roomTargetUid?: string;
  manualRevision?: number;
  wearing: LocalWearingMedal | null;
  selectedMedalId?: string | null;
  /** Verified account selection metadata, never a room's curr_show. */
  selectedMedal?: LocalFanMedal | null;
  displayConfirmed: boolean;
  loaded: boolean;
  loading: boolean;
  changing: boolean;
  /** Automatic writes yield to chat sends through their lease instead of disabling the composer. */
  automaticChanging?: boolean;
  page: number;
  hasMore: boolean;
  limitReached?: boolean;
  error: string;
  unknown: boolean;
}
export interface DanmakuMedalAdapter {
  getSnapshot(): LocalMedalSnapshot;
  subscribe(listener: () => void): () => void;
  load(page: number, signal?: AbortSignal, force?: boolean): Promise<void>;
  loadRoom?(signal?: AbortSignal, force?: boolean): Promise<void>;
  select(medalId: string | null, signal?: AbortSignal): Promise<boolean>;
}
/** Read-only preparation failed before SET_FAN_MEDAL was dispatched. */
export class LocalMedalNotDispatchedError extends Error {
  constructor(message: string) { super(message); this.name = 'LocalMedalNotDispatchedError'; }
}
export type LocalMedalSource = { kind: 'directory'; page: number } | { kind: 'room' };
type MedalTransport = {
  page(page: number, signal: AbortSignal, force: boolean): Promise<LocalMedalPage>;
  room?(signal: AbortSignal): Promise<LocalMedalRoomContext>;
  select(medalId: string | null, signal: AbortSignal, source: LocalMedalSource, beforeDispatch?: () => void): Promise<LocalMedalSelection>;
};
const REUSE_MS = 5 * 60_000;
const RECHECK_GAP_MS = 15_000;
const MAX_MEDALS = 1000;
type AccountMedalFacts = Pick<LocalMedalSnapshot, 'selectedMedalId' | 'selectedMedal' | 'changing' | 'automaticChanging' | 'unknown' | 'error' | 'manualRevision'>;

/** Wearing is an account operation; only curr_show and directory views belong to rooms. */
export class LocalMedalAccountCoordinator {
  private facts: AccountMedalFacts = { changing: false, unknown: false, error: '' };
  private readonly listeners = new Set<(facts: AccountMedalFacts, previous: AccountMedalFacts, origin?: LocalMedalStore) => void>();
  private readonly catalog = new Map<string, LocalFanMedal>();
  private write?: AbortController;
  private disposed = false;
  selectedAt = -1;
  source?: LocalMedalStore;
  getSnapshot = () => this.facts;
  noteManual = (): void => { this.update({ manualRevision: (this.facts.manualRevision ?? 0) + 1 }); };
  subscribe = (listener: (facts: AccountMedalFacts, previous: AccountMedalFacts, origin?: LocalMedalStore) => void) => {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  };
  update(next: Partial<AccountMedalFacts>, origin?: LocalMedalStore): boolean {
    if (this.disposed) return false;
    if (Object.prototype.hasOwnProperty.call(next, 'selectedMedalId')) next = { ...next,
      selectedMedal: next.selectedMedalId === null ? null : next.selectedMedalId ? this.catalog.get(next.selectedMedalId) : undefined };
    const previous = this.facts;
    if (!Object.keys(next).some(key => next[key as keyof AccountMedalFacts] !== previous[key as keyof AccountMedalFacts])) return false;
    this.facts = { ...previous, ...next };
    for (const listener of this.listeners) listener(this.facts, previous, origin);
    if (!this.facts.changing && !this.facts.unknown) this.source = undefined;
    return true;
  }
  remember(items: readonly LocalFanMedal[]): void {
    if (this.disposed) return;
    for (const item of items) {
      const safe = readMedal(item);
      this.catalog.delete(safe.id); this.catalog.set(safe.id, safe);
    }
    for (const key of this.catalog.keys()) {
      if (this.catalog.size <= MAX_MEDALS) break;
      if (key !== this.facts.selectedMedalId) this.catalog.delete(key);
    }
    const selected = this.facts.selectedMedalId ? this.catalog.get(this.facts.selectedMedalId) : undefined;
    if (selected) this.update({ selectedMedal: selected });
  }
  begin(store: LocalMedalStore, controller: AbortController, automatic = false): boolean {
    if (this.disposed || this.write || this.facts.changing || this.facts.unknown) return false;
    this.source = store; this.write = controller;
    this.update({ changing: true, automaticChanging: automatic, error: '' }, store); return true;
  }
  finish(store: LocalMedalStore, controller: AbortController): void {
    if (this.write !== controller) return;
    this.write = undefined; this.update({ changing: false, automaticChanging: false }, store);
    if (!this.facts.unknown) this.source = undefined;
  }
  retains(store: LocalMedalStore): boolean { return this.source === store && (this.facts.changing || this.facts.unknown); }
  dispose(): void {
    this.disposed = true; this.write?.abort(); this.write = undefined;
    this.source = undefined; this.selectedAt = -1; this.catalog.clear();
    this.facts = { changing: false, unknown: false, error: '' }; this.listeners.clear();
  }
}

/** Account-bound room presentation cache. It never polls or retries a write. */
export class LocalMedalStore implements DanmakuMedalAdapter {
  private state: LocalMedalSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly pages = new Map<number, { value: LocalMedalPage; at: number }>();
  private readonly itemPages = new Map<string, number>();
  private pending?: { page: number; controller: AbortController; consumers: Set<symbol>; promise: Promise<void>; generation: number };
  private roomValue?: { value: LocalMedalRoomContext; at: number };
  private roomPending?: { controller: AbortController; consumers: Set<symbol>; promise: Promise<void> };
  private roomTransport?: MedalTransport['room'];
  private write?: AbortController;
  private automaticWrite?: { controller: AbortController; dispatched: boolean; promise?: Promise<boolean> };
  private refreshAfterWrite = false;
  private generation = 0;
  private confirmedAt = -1;
  private unresolvedSource: LocalMedalSource = { kind: 'directory', page: 1 };
  private unsubscribeAccount: () => void;
  private get selectedAt() { return this.account.selectedAt; }
  private set selectedAt(value: number) { this.account.selectedAt = value; }
  constructor(scope: string, private readonly transport: MedalTransport, private readonly now = Date.now,
    private readonly account = new LocalMedalAccountCoordinator()) {
    this.roomTransport = transport.room;
    this.state = { scope, revision: 0, items: [], roomItems: [], roomLoading: false, roomError: '', wearing: null, displayConfirmed: false, loaded: false, loading: false, page: 0, hasMore: false, ...account.getSnapshot() };
    this.unsubscribeAccount = account.subscribe((facts, previous, origin) => {
      const selectionChanged = facts.selectedMedalId !== previous.selectedMedalId;
      if (facts.changing && !previous.changing && origin !== this) {
        this.generation++;
        this.pending?.controller.abort(); this.pending = undefined;
        this.roomPending?.controller.abort(); this.roomPending = undefined;
      }
      if (selectionChanged && origin !== this) { this.pages.clear(); this.roomValue = undefined; }
      this.state = { ...this.state, ...facts,
        ...(facts.changing ? { loading: false, roomLoading: false } : {}),
        ...((selectionChanged || previous.changing && !facts.changing) && origin !== this ? { revision: this.state.revision + 1 } : {}) };
      this.emit();
    });
  }
  getSnapshot = (): LocalMedalSnapshot => this.state;
  configureRoom = (room?: MedalTransport['room']): void => {
    if (!room && this.roomTransport) {
      this.roomPending?.controller.abort(); this.roomPending = undefined; this.roomValue = undefined;
      this.patch({ roomItems: [], roomTargetUid: undefined, roomLoading: false, roomError: '' }, false);
    }
    this.roomTransport = room;
  };
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private emit(): void { for (const listener of this.listeners) listener(); }
  private patch(next: Partial<LocalMedalSnapshot>, share = true): void {
    this.state = { ...this.state, ...next };
    const shared: Partial<AccountMedalFacts> = {};
    for (const key of ['selectedMedalId', 'changing', 'unknown'] as const) if (Object.prototype.hasOwnProperty.call(next, key)) Object.assign(shared, { [key]: next[key] });
    if (share && Object.keys(shared).length) {
      if (next.error !== undefined) shared.error = next.error;
      if (this.account.update(shared, this)) return;
    }
    this.emit();
  }
  acceptSelection = (selection: LocalMedalSelection, sameRoom = true): void => {
    if (selection.status !== 'applied') return;
    const selectedCurrent = selection.selectedMedalId !== undefined && selection.updatedAt >= this.selectedAt;
    const displayCurrent = sameRoom && selection.displayConfirmed !== false && selection.updatedAt >= this.confirmedAt;
    if (!selectedCurrent && !displayCurrent) return;
    if (selectedCurrent) this.selectedAt = selection.updatedAt;
    if (displayCurrent) this.confirmedAt = selection.updatedAt;
    this.pages.clear();
    this.roomValue = undefined;
    // A notification can precede this tab's own write acknowledgement. It is
    // display data, not an account invalidation or a new transport generation.
    this.pending?.controller.abort(); this.pending = undefined;
    this.roomPending?.controller.abort(); this.roomPending = undefined;
    this.patch({ ...(selectedCurrent ? { selectedMedalId: selection.selectedMedalId } : {}),
      ...(displayCurrent ? { wearing: selection.wearing, displayConfirmed: true } : sameRoom && selection.updatedAt >= this.confirmedAt && selection.displayConfirmed === false ? { displayConfirmed: false } : {}), loading: false, roomLoading: false, unknown: false, error: '' });
  };
  invalidate = (): void => {
    this.pages.clear();
    this.roomValue = undefined;
    if (this.write) { this.refreshAfterWrite = true; return; }
    this.generation++;
    this.pending?.controller.abort(); this.pending = undefined;
    this.roomPending?.controller.abort(); this.roomPending = undefined;
    this.patch({ loaded: false, loading: false, roomLoading: false, revision: this.state.revision + 1 });
  };
  dispose = (): void => {
    this.unsubscribeAccount(); this.listeners.clear();
    if (this.account.retains(this)) {
      this.pending?.controller.abort(); this.pending = undefined;
      this.roomPending?.controller.abort(); this.roomPending = undefined;
      return;
    }
    this.generation++;
    this.pending?.controller.abort(); this.pending = undefined;
    this.roomPending?.controller.abort(); this.roomPending = undefined;
    this.refreshAfterWrite = false;
    this.confirmedAt = -1;
    this.unresolvedSource = { kind: 'directory', page: 1 };
    this.roomValue = undefined;
    this.pages.clear();
    this.itemPages.clear();
    this.patch({ items: [], roomItems: [], roomTargetUid: undefined, roomLoading: false, roomError: '', wearing: null, displayConfirmed: false, loaded: false, loading: false, page: 0, hasMore: false, limitReached: false }, false);
  };
  private applyPage(value: LocalMedalPage): void {
    this.account.remember(value.items);
    const items = new Map<string, LocalFanMedal>();
    if (value.page > 1) for (const item of this.state.items) items.set(item.id, item);
    else this.itemPages.clear();
    for (const item of value.items) { items.set(item.id, item); this.itemPages.set(item.id, value.page); }
    const retained = [...items.values()].slice(0, MAX_MEDALS), retainedIds = new Set(retained.map(item => item.id));
    for (const key of this.itemPages.keys()) if (!retainedIds.has(key)) this.itemPages.delete(key);
    const current = value.resolvedAt >= this.confirmedAt;
    const displayCurrent = current && value.displayConfirmed !== false;
    const selectedCurrent = value.selectedMedalId !== undefined && value.resolvedAt >= this.selectedAt;
    const selectedNoLongerOnPage = value.selectionPageComplete === true && value.selectedMedalId === undefined && value.resolvedAt >= this.selectedAt &&
      this.state.selectedMedalId != null && value.items.some(item => item.id === this.state.selectedMedalId);
    if (displayCurrent) this.confirmedAt = value.resolvedAt;
    if (selectedCurrent || selectedNoLongerOnPage) this.selectedAt = value.resolvedAt;
    // Legacy extensions can confirm only their room display. New paginated
    // responses must not invent a global "not worn" from a missing selection.
    const confirmed = selectedCurrent || value.displayConfirmed === undefined && displayCurrent;
    this.patch({ items: retained,
      ...(displayCurrent ? { wearing: value.wearing, displayConfirmed: true } : current && value.displayConfirmed === false ? { displayConfirmed: false } : {}),
      ...(selectedCurrent ? { selectedMedalId: value.selectedMedalId } : selectedNoLongerOnPage ? { selectedMedalId: undefined } : {}), ...(confirmed ? { unknown: false } : {}), loaded: true,
      page: value.page, hasMore: value.hasMore && items.size < MAX_MEDALS && value.page < 100,
      limitReached: value.hasMore && (items.size >= MAX_MEDALS || value.page >= 100),
      error: this.state.unknown && !confirmed ? this.state.error : '' });
  }
  private applyRoom(value: LocalMedalRoomContext): void {
    this.account.remember(value.items);
    this.roomValue = { value, at: this.now() };
    this.patch({ roomItems: value.items, roomTargetUid: value.targetUid, roomError: '' }, false);
  }
  /** The official room panel is a separate hint list, never a directory page or selection proof. */
  async loadRoom(signal?: AbortSignal, force = false): Promise<void> {
    if (!this.roomTransport || signal?.aborted || this.write || this.state.changing || this.state.unknown) return;
    if (this.roomValue && this.now() - this.roomValue.at < (force ? RECHECK_GAP_MS : REUSE_MS)) return;
    if (!this.roomPending) {
      const controller = new AbortController(), generation = this.generation;
      const pending = { controller, consumers: new Set<symbol>(), promise: Promise.resolve() };
      this.roomPending = pending; this.patch({ roomLoading: true, roomError: '' }, false);
      pending.promise = this.roomTransport(controller.signal).then(value => {
        if (controller.signal.aborted || generation !== this.generation) return;
        this.applyRoom(value);
      }).catch(() => {
        if (!controller.signal.aborted && generation === this.generation) this.patch({ roomError: '房间勋章暂时无法加载' }, false);
      }).finally(() => {
        if (this.roomPending === pending) { this.roomPending = undefined; this.patch({ roomLoading: false }, false); }
      });
    }
    const pending = this.roomPending, token = Symbol(); pending.consumers.add(token);
    await new Promise<void>(resolve => {
      const release = () => {
        signal?.removeEventListener('abort', release); pending.consumers.delete(token);
        if (!pending.consumers.size && this.roomPending === pending) { pending.controller.abort(); this.roomPending = undefined; this.patch({ roomLoading: false }, false); }
        resolve();
      };
      signal?.addEventListener('abort', release, { once: true }); void pending.promise.then(release);
    });
  }
  /** An explicit refresh may reconcile a lost ACK with GETs; it never repeats SET. */
  private async reconcileUnknown(source: LocalMedalSource, controller: AbortController, generation: number): Promise<void> {
    const checked = new Map<number, LocalMedalPage>();
    const current = () => !controller.signal.aborted && generation === this.generation && this.state.unknown;
    const read = async (page: number): Promise<LocalMedalPage | undefined> => {
      if (!current()) return;
      // Reuse this pass's fresh source page when the sequential scan reaches it.
      let value = checked.get(page);
      if (!value) {
        value = await this.transport.page(page, controller.signal, true);
        if (!current()) return;
        checked.set(page, value); this.pages.set(page, { value, at: this.now() });
      }
      this.applyPage(value); return value;
    };
    // Room hints contain no selection facts. Recovery always starts from the
    // complete account directory and cannot be blocked by a failed hint list.
    await read(source.kind === 'directory' ? source.page : 1);
    if (!current()) return;
    const first = await read(1);
    if (!first || !current()) return;
    const { total, pageSize, totalPages } = first;
    // The official personal panel's page_info counts pages independently of
    // total_number (special medals can occupy ordinary page slots).
    const lastPage = totalPages !== undefined ? Math.max(1, totalPages) : null;
    const pageLimit = Math.min(100, lastPage ?? Math.floor(MAX_MEDALS / pageSize), Math.ceil(MAX_MEDALS / pageSize));
    let complete = (lastPage === null || lastPage <= 100 && lastPage <= Math.ceil(MAX_MEDALS / pageSize)) && (total === null || total <= MAX_MEDALS);
    for (let page = 1; page <= pageLimit; page++) {
      const value = page === 1 ? first : await read(page);
      if (!value || !current()) return;
      if (value.total !== total || value.pageSize !== pageSize || value.totalPages !== totalPages) return;
      complete = complete && value.selectionPageComplete === true;
      if (lastPage !== null && value.hasMore !== (page < lastPage)) return;
      if (!value.hasMore) {
        // special_list may repeat an item or add a pinned medal, so projected
        // item counts cannot prove completeness. Trust explicit per-page proof
        // only after every numbered page and its pagination facts agree.
        if (complete && (lastPage === null || lastPage === page)) {
          const resolvedAt = Math.max(...[...checked.values()].map(value => value.resolvedAt));
          if (resolvedAt >= this.selectedAt) {
            this.selectedAt = resolvedAt;
            this.patch({ selectedMedalId: null, unknown: false, error: '' });
          }
        }
        return;
      }
    }
  }
  async load(page: number, signal?: AbortSignal, force = false): Promise<void> {
    if (signal?.aborted || this.write || this.state.changing || !Number.isInteger(page) || page < 1 || page > 100) return;
    // A room switch cannot abandon a submitted account operation. Recovery
    // always reads the original room and source page, then this room's display.
    const source = this.account.source;
    if (this.state.unknown && source && source !== this) {
      if (!force) return;
      const generation = this.generation;
      this.patch({ loading: true });
      try { await source.load(1, signal, true); }
      finally { if (generation === this.generation) this.patch({ loading: false }); }
      if (signal?.aborted || generation !== this.generation || this.account.getSnapshot().unknown) return;
    }
    // A refresh after an ambiguous write first reads the page that contained
    // the user's choice. It never asks the user to find that page again.
    if (this.state.unknown && page === 1 && this.unresolvedSource.kind === 'directory') page = this.unresolvedSource.page;
    const cached = this.pages.get(page);
    if (cached && cached.value.displayConfirmed !== false && !this.state.unknown && this.now() - cached.at < (force ? RECHECK_GAP_MS : REUSE_MS)) {
      // A cached old page must not roll back this room's newer display.
      if (!this.state.loaded || page > this.state.page) this.applyPage({ ...cached.value, wearing: this.state.loaded ? this.state.wearing : cached.value.wearing });
      return;
    }
    if (this.pending && this.pending.page !== page) return;
    if (!this.pending) {
      const controller = new AbortController(), generation = this.generation;
      const pending = { page, controller, generation, consumers: new Set<symbol>(), promise: Promise.resolve() };
      this.pending = pending;
      this.patch({ loading: true, ...(!this.state.unknown ? { error: '' } : {}) });
      const reading = this.state.unknown && force ? this.reconcileUnknown(this.unresolvedSource, controller, generation) : this.transport.page(page, controller.signal, force).then(value => {
        if (controller.signal.aborted || generation !== this.generation) return;
        this.pages.set(page, { value, at: this.now() });
        this.applyPage(value);
      });
      pending.promise = reading.catch(error => {
        if (!controller.signal.aborted && generation === this.generation) this.patch({ error: error instanceof LocalLoginClientError ? error.message : '粉丝勋章暂时无法加载，请稍后重试' });
      }).finally(() => {
        if (this.pending === pending) { this.pending = undefined; this.patch({ loading: false }); }
      });
    }
    const pending = this.pending, token = Symbol(); pending.consumers.add(token);
    await new Promise<void>(resolve => {
      const release = () => {
        signal?.removeEventListener('abort', release);
        pending.consumers.delete(token);
        if (!pending.consumers.size && this.pending === pending) { pending.controller.abort(); this.pending = undefined; this.patch({ loading: false }); }
        resolve();
      };
      signal?.addEventListener('abort', release, { once: true });
      void pending.promise.then(release);
    });
  }
  async select(medalId: string | null, signal?: AbortSignal): Promise<boolean> {
    this.account.noteManual();
    const automatic = this.automaticWrite;
    if (automatic) {
      if (!automatic.dispatched) automatic.controller.abort();
      await automatic.promise;
      if (signal?.aborted) return false;
    }
    return this.performSelect(medalId, signal);
  }
  selectAuto(medalId: string, signal: AbortSignal, beforeDispatch: () => void): Promise<boolean> {
    if (this.automaticWrite || signal.aborted) return Promise.resolve(false);
    const automatic = { controller: new AbortController(), dispatched: false, promise: undefined as Promise<boolean> | undefined };
    this.automaticWrite = automatic;
    const abort = () => { if (!automatic.dispatched) automatic.controller.abort(); };
    signal.addEventListener('abort', abort, { once: true });
    automatic.promise = this.performSelect(medalId, automatic.controller.signal, () => {
      beforeDispatch(); automatic.dispatched = true;
    }).finally(() => {
      signal.removeEventListener('abort', abort);
      if (this.automaticWrite === automatic) this.automaticWrite = undefined;
    });
    return automatic.promise;
  }
  private async performSelect(medalId: string | null, signal?: AbortSignal, automatic?: () => void): Promise<boolean> {
    if (signal?.aborted || this.write || this.state.changing || this.state.unknown || !this.state.loaded ||
      (medalId !== null && !this.state.items.some(item => item.id === medalId) && !this.state.roomItems?.some(item => item.id === medalId))) return false;
    const source: LocalMedalSource = medalId === null ? { kind: 'directory', page: 1 } : this.itemPages.has(medalId)
      ? { kind: 'directory', page: this.itemPages.get(medalId)! } : { kind: 'room' };
    if (this.state.selectedMedalId !== undefined && this.state.selectedMedalId === medalId) return true;
    this.pending?.controller.abort(); this.pending = undefined; this.pages.clear();
    this.roomPending?.controller.abort(); this.roomPending = undefined; this.roomValue = undefined;
    this.unresolvedSource = source;
    const controller = new AbortController(), generation = ++this.generation;
    let dispatched = false;
    const abort = () => { if (!automatic || !dispatched) controller.abort(); }; signal?.addEventListener('abort', abort, { once: true });
    if (!this.account.begin(this, controller, Boolean(automatic))) { signal?.removeEventListener('abort', abort); return false; }
    this.write = controller; this.patch({ changing: true, loading: false, roomLoading: false, error: '' });
    try {
      const result = await this.transport.select(medalId, controller.signal, source, () => {
        if (controller.signal.aborted) throw new LocalMedalNotDispatchedError('勋章尚未切换');
        automatic?.(); dispatched = true;
      });
      if (generation !== this.generation) return false;
      // A later selection from another tab may arrive before this write's
      // acknowledgement. Its confirmed display must remain the newer fact.
      const current = result.updatedAt >= this.confirmedAt;
      const displayCurrent = current && !controller.signal.aborted && result.displayConfirmed !== false;
      const selectedCurrent = !controller.signal.aborted && result.updatedAt >= this.selectedAt &&
        (result.selectedMedalId !== undefined || result.status === 'applied');
      if (displayCurrent) this.confirmedAt = result.updatedAt;
      if (selectedCurrent) this.selectedAt = result.updatedAt;
      const facts = { ...(displayCurrent ? { wearing: result.wearing, displayConfirmed: true } : current && !controller.signal.aborted && result.displayConfirmed === false ? { displayConfirmed: false } : {}),
        ...(selectedCurrent ? { selectedMedalId: result.selectedMedalId !== undefined ? result.selectedMedalId : medalId } : {}) };
      if (!controller.signal.aborted && result.status === 'rejected') {
        this.patch({ ...facts, unknown: false, error: result.message || '此次勋章切换未成功，请稍后重试' }); return false;
      }
      if (controller.signal.aborted || result.status !== 'applied') {
        if (current) this.patch({ ...facts, unknown: true, error: result.message || '暂未确认切换结果，请刷新勋章后再试' });
        return false;
      }
      this.patch({ ...facts, error: '', unknown: false }); return true;
    } catch (error) {
      if (generation === this.generation) this.patch({
        unknown: !(error instanceof LocalMedalNotDispatchedError || error instanceof LocalLoginClientError && ['UNAUTHORIZED', 'LOGGED_OUT', 'ACCOUNT_CHANGED', 'INVALID_REQUEST', 'RATE_LIMITED', 'STATE_CONFLICT'].includes(error.code)),
        error: automatic && !dispatched ? '' : error instanceof LocalMedalNotDispatchedError || error instanceof LocalLoginClientError ? error.message : '暂未确认切换结果，请刷新勋章后再试' });
      return false;
    } finally {
      signal?.removeEventListener('abort', abort);
      this.account.finish(this, controller);
      if (this.write === controller) {
        this.write = undefined; this.patch({ changing: false });
        if (this.refreshAfterWrite) { this.refreshAfterWrite = false; this.invalidate(); }
      }
    }
  }
}
