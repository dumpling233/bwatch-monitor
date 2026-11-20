import type { DanmakuBootstrap } from '../../../shared/danmaku';
import { MAX_ADAPTIVE_GRID_ROOMS } from '../adaptiveGrid';
import { DanmakuStore, type DanmakuHistoryView } from './store';
import { messageBytes } from './budget';
import type { DanmakuEvent, DanmakuGap, DanmakuMessage, DanmakuRoomState, DanmakuWorkerCommand, DanmakuWorkerEvent } from './types';

const emptyHistory: DanmakuMessage[] = [];
const MAX_GAPS_PER_ROOM = 32;
type ConnectionState = Omit<DanmakuRoomState, 'messages' | 'superChats'>;
const sameProjection = (previous: DanmakuRoomState, current: DanmakuRoomState): boolean => previous.status === current.status
  && previous.receiveMode === current.receiveMode && previous.gaps === current.gaps && previous.error === current.error && previous.retryAt === current.retryAt
  && previous.messages === current.messages && previous.superChats === current.superChats;

interface Entry {
  source: 'custom';
  generation: number;
  clearVersion: number;
  abort?: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  healthyTimer?: ReturnType<typeof setTimeout>;
  bootstrap?: DanmakuBootstrap;
  hostIndex: number;
  failures: number;
  retryAt?: number;
  terminal?: boolean;
  active?: boolean;
}
export interface DanmakuManagerIO {
  bootstrap(roomId: string, refresh: boolean, signal: AbortSignal, source?: 'custom'): Promise<DanmakuBootstrap>;
  post(command: DanmakuWorkerCommand): void;
  changed(rooms: Record<string, DanmakuRoomState>): void;
  messages?(roomId: string, messages: DanmakuMessage[]): void;
  now?: () => number;
  random?: () => number;
}

/** One manager per monitor page, with one worker connection per demanded room. */
export class DanmakuManager {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Map<string, Set<(messages: DanmakuMessage[]) => void>>();
  private readonly store = new DanmakuStore();
  private readonly connectionStates = new Map<string, DanmakuRoomState>();
  private sequence = 0;
  private disposed = false;
  private publishTimer?: ReturnType<typeof setTimeout>;
  private publishing = true;
  private publishedRooms?: ReadonlySet<string>;
  private publishedView: DanmakuHistoryView = 'all';
  private publishedSnapshot?: Record<string, DanmakuRoomState>;
  private forcePublication = false;
  private activeRooms?: Set<string>;
  private demandedRooms = new Set<string>();
  private bootstrapActive = 0;
  private readonly bootstrapQueue: Array<{ roomId: string; signal: AbortSignal; start(): void }> = [];
  private priorities = new Map<string, number>();
  private readonly connectQueue: Array<{ roomId: string; entry: Entry; generation: number }> = [];
  private connectStarts = 0;
  private connectTimer?: ReturnType<typeof setTimeout>;
  private readonly staging = new Map<string, { id: string; total: number; messages: DanmakuMessage[]; bytes: number }>();
  private readonly snapshotRevisions = new Map<string, bigint>();
  private stagedBytes = 0;
  constructor(private readonly io: DanmakuManagerIO) {}
  private now = (): number => this.io.now?.() ?? Date.now();
  private changed(historyOnly = false): void {
    // Overlay delivery and bounded history continue without a visible log.
    // There is no history projection to publish in this case, so do not wake
    // the main thread to scan every connection for an unchanged UI snapshot.
    if (historyOnly && (this.publishedRooms?.size === 0 || this.publishedView === 'none')) return;
    if (this.disposed || !this.publishing || this.publishTimer) return;
    this.publishTimer = setTimeout(() => { this.publishTimer = undefined; if (!this.disposed && this.publishing) this.publish(); }, 100);
  }
  private setState(roomId: string, state: Partial<ConnectionState>): void {
    this.store.setState(roomId, state);
    const previous = this.connectionStates.get(roomId);
    this.connectionStates.set(roomId, { status: 'idle', ...previous, ...state, messages: emptyHistory, superChats: emptyHistory });
  }
  private startGap(roomId: string, entry: Entry, reason: DanmakuGap['reason'], startedAt = this.now()): void {
    const state = this.connectionStates.get(roomId);
    const gaps = state?.gaps ?? [];
    const last = gaps.at(-1);
    if (state?.status !== 'live' || last && last.endedAt === undefined) return;
    const generation = entry.generation;
    this.setState(roomId, { gaps: [...gaps.slice(-(MAX_GAPS_PER_ROOM - 1)), {
      id: String(generation), startedAt, reason, interruptedGeneration: generation,
    }] });
  }
  private endGap(roomId: string, generation: number, endedAt = this.now()): void {
    const gaps = this.connectionStates.get(roomId)?.gaps;
    const last = gaps?.at(-1);
    if (!gaps || !last || last.endedAt !== undefined || generation <= (last.interruptedGeneration ?? -1)) return;
    this.setState(roomId, { gaps: [...gaps.slice(0, -1), { ...last, endedAt: Math.max(endedAt, last.startedAt) }] });
  }
  private publish(): void {
    const previous = this.publishedSnapshot;
    const rooms: Record<string, DanmakuRoomState> = {};
    let changed = this.forcePublication || !previous || Object.keys(previous).length !== this.entries.size;
    for (const roomId of this.entries.keys()) {
      // Hidden rooms expose connection feedback without materializing their retained histories.
      const selected = !this.publishedRooms || this.publishedRooms.has(roomId);
      const current = (selected && this.publishedView !== 'none' ? this.store.room(roomId, this.publishedView) : this.connectionStates.get(roomId))!;
      // A hidden view freezes its last immutable UI snapshot. Keeping these
      // references preserves the virtual list's reading anchor without walking
      // retained histories or publishing incoming messages behind settings.
      const frozen = selected && this.publishedView === 'none' ? previous?.[roomId] : undefined;
      const messages = frozen?.messages ?? current.messages, superChats = frozen?.superChats ?? current.superChats;
      const gaps = selected ? (this.publishedView === 'none' ? frozen?.gaps : current.gaps) : undefined;
      const projected = { ...current, gaps, messages: messages.length ? messages : emptyHistory,
        superChats: superChats.length ? superChats : emptyHistory };
      const last = previous?.[roomId];
      if (last && sameProjection(last, projected)) rooms[roomId] = last;
      else { rooms[roomId] = projected; changed = true; }
    }
    if (!changed) return;
    this.forcePublication = false;
    this.publishedSnapshot = rooms;
    this.io.changed(rooms);
  }
  setPublishing(value: boolean): void {
    this.publishing = value;
    if (!value) { clearTimeout(this.publishTimer); this.publishTimer = undefined; }
    else this.changed();
  }
  setPublishedRooms(roomIds?: readonly string[], view: DanmakuHistoryView = 'all'): void {
    const next = roomIds === undefined ? undefined : new Set(roomIds);
    const sameRooms = next === undefined ? this.publishedRooms === undefined : this.publishedRooms !== undefined
      && next.size === this.publishedRooms.size && [...next].every(id => this.publishedRooms!.has(id));
    if (sameRooms && view === this.publishedView) return;
    this.publishedRooms = next; this.publishedView = view;
    if (view !== 'all' && this.publishedSnapshot && this.publishing && !this.disposed) {
      // Switching the actual visible message view reveals its latest records
      // immediately; ordinary network batches retain the existing 100 ms merge.
      clearTimeout(this.publishTimer); this.publishTimer = undefined; this.publish();
    } else this.changed();
  }
  /** Suspend transport only; histories remain bounded and available on foreground restore. */
  setActiveRooms(roomIds: readonly string[]): void {
    this.activeRooms = new Set(roomIds);
    const priority = new Map(roomIds.map((id, index) => [id, index]));
    for (const [roomId, entry] of [...this.entries].sort(([a], [b]) => (priority.get(a) ?? 999) - (priority.get(b) ?? 999))) {
      this.setEntryActive(roomId, entry, this.demandedRooms.has(roomId) && this.activeRooms.has(roomId), 'background');
    }
    this.changed();
  }
  private setEntryActive(roomId: string, entry: Entry, active: boolean, reason: 'background' | 'paused'): void {
    if (active === entry.active) return;
    entry.active = active;
    if (!active) {
      this.startGap(roomId, entry, reason);
      this.stop(roomId, entry); entry.generation = ++this.sequence;
      if (!entry.terminal) this.setState(roomId, { status: 'idle', retryAt: undefined, error: undefined });
    } else if (!entry.terminal) void this.connect(roomId, entry);
  }
  setRooms(roomIds: readonly string[], sources?: Readonly<Record<string, 'custom'>>,
    retainedRoomIds: readonly string[] = roomIds, activeRoomIds?: readonly string[]): void {
    if (this.disposed) return;
    const wanted = new Set([...new Set(roomIds.filter(id => /^[1-9][0-9]*$/.test(id)))].slice(0, MAX_ADAPTIVE_GRID_ROOMS));
    this.demandedRooms = wanted;
    if (activeRoomIds) this.activeRooms = new Set(activeRoomIds);
    const retained = new Set([...new Set([...wanted, ...retainedRoomIds])].slice(0, MAX_ADAPTIVE_GRID_ROOMS));
    this.priorities = new Map([...wanted].map((id, index) => [id, index]));
    for (const [roomId, entry] of this.entries) {
      if (!retained.has(roomId) || entry.source !== (sources?.[roomId] ?? 'custom')) {
        this.stop(roomId, entry); this.entries.delete(roomId); this.store.remove(roomId); this.connectionStates.delete(roomId); this.snapshotRevisions.delete(roomId);
      } else {
        const demanded = wanted.has(roomId);
        this.setEntryActive(roomId, entry, demanded && (!this.activeRooms || this.activeRooms.has(roomId)), demanded ? 'background' : 'paused');
      }
    }
    for (const roomId of wanted) if (!this.entries.has(roomId)) {
      const entry: Entry = { source: sources?.[roomId] ?? 'custom', generation: ++this.sequence, clearVersion: 0, hostIndex: 0, failures: 0,
        active: !this.activeRooms || this.activeRooms.has(roomId) };
      this.entries.set(roomId, entry); this.setState(roomId, { status: entry.active ? 'connecting' : 'idle' });
      if (entry.active) void this.connect(roomId, entry);
    }
    this.changed();
  }
  private valid(roomId: string, entry: Entry, generation: number): boolean {
    return !this.disposed && this.entries.get(roomId) === entry && entry.generation === generation;
  }
  private stop(roomId: string, entry: Entry): void {
    entry.abort?.abort(); clearTimeout(entry.timer); clearTimeout(entry.healthyTimer);
    for (let index = this.connectQueue.length - 1; index >= 0; index--) if (this.connectQueue[index].entry === entry) this.connectQueue.splice(index, 1);
    this.dropStaging(roomId);
    this.io.post({ type: 'disconnect', roomId, generation: entry.generation });
  }
  private bootstrap(roomId: string, entry: Entry, force: boolean, signal: AbortSignal): Promise<DanmakuBootstrap> {
    return new Promise((resolve, reject) => {
      const abort = () => { const index = this.bootstrapQueue.indexOf(work); if (index >= 0) this.bootstrapQueue.splice(index, 1); reject(new DOMException('Cancelled', 'AbortError')); };
      const work = { roomId, signal, start: () => {
        signal.removeEventListener('abort', abort);
        if (signal.aborted || this.disposed) { abort(); return; }
        this.bootstrapActive++;
        void this.io.bootstrap(roomId, force, signal, entry.source).then(resolve, reject).finally(() => {
          this.bootstrapActive--;
          this.bootstrapQueue.sort((a, b) => (this.priorities.get(a.roomId) ?? 999) - (this.priorities.get(b.roomId) ?? 999));
          while (this.bootstrapActive < 2 && this.bootstrapQueue.length) this.bootstrapQueue.shift()!.start();
        });
      } };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      else if (this.bootstrapActive < 2) work.start(); else this.bootstrapQueue.push(work);
    });
  }
  private dispatchConnect(roomId: string, entry: Entry, generation: number): void {
    this.connectQueue.push({ roomId, entry, generation }); this.drainConnects();
  }
  private drainConnects(): void {
    if (this.disposed) return;
    this.connectQueue.sort((a, b) => (this.priorities.get(a.roomId) ?? 999) - (this.priorities.get(b.roomId) ?? 999));
    while (this.connectStarts < 4 && this.connectQueue.length) {
      const { roomId, entry, generation } = this.connectQueue.shift()!;
      if (!entry.active || !this.valid(roomId, entry, generation) || !entry.bootstrap) continue;
      this.connectStarts++;
      this.io.post({ type: 'connect', roomId, generation, bootstrap: entry.bootstrap, hostIndex: entry.hostIndex });
    }
    if (this.connectStarts && !this.connectTimer) this.connectTimer = setTimeout(() => {
      this.connectTimer = undefined; this.connectStarts = 0; this.drainConnects();
    }, 1000);
  }
  private async connect(roomId: string, entry: Entry, force = false): Promise<void> {
    if (!entry.active || this.disposed) return;
    clearTimeout(entry.timer); entry.timer = undefined; entry.retryAt = undefined;
    entry.abort?.abort(); entry.abort = new AbortController();
    const generation = entry.generation = ++this.sequence;
    this.dropStaging(roomId);
    this.io.post({ type: 'begin', roomId, generation, clearVersion: entry.clearVersion, superChats: this.store.room(roomId, 'sc')?.superChats ?? [] });
    this.setState(roomId, { status: entry.failures ? 'retrying' : 'connecting', error: undefined, retryAt: undefined }); this.changed();
    try {
      if (force || !entry.bootstrap || this.now() - entry.bootstrap.resolvedAt >= 30000 || entry.hostIndex >= entry.bootstrap.hosts.length) {
        const config = await this.bootstrap(roomId, entry, force || entry.failures > 0, entry.abort.signal);
        if (!this.valid(roomId, entry, generation)) return;
        if (!config.hosts.length) throw new Error('没有可用的弹幕节点');
        entry.bootstrap = config; entry.hostIndex = 0;
      }
      if (!this.valid(roomId, entry, generation)) return;
      this.setState(roomId, { receiveMode: entry.bootstrap.mode ?? 'anonymous' }); this.changed();
      this.dispatchConnect(roomId, entry, generation);
    } catch (error) {
      if (!this.valid(roomId, entry, generation) || entry.abort.signal.aborted) return;
      const detail = error as { status?: number; retryAfter?: number };
      if ([400, 401, 403, 404, 409].includes(detail.status || 0)) {
        entry.terminal = true;
        this.setState(roomId, { status: 'error', error: '此房间当前无法获取弹幕连接配置', retryAt: undefined }); this.changed();
      } else this.retry(roomId, entry, error instanceof Error ? error.message : '弹幕配置请求失败', detail.retryAfter);
    }
  }
  private retry(roomId: string, entry: Entry, error: string, retryAfter?: number): void {
    if (entry.timer || entry.terminal) return;
    clearTimeout(entry.healthyTimer);
    const failures = ++entry.failures;
    const base = failures >= 5 ? [60_000, 120_000, 300_000][Math.min(2, failures - 5)] : Math.min(30000, 1000 * 2 ** Math.min(failures - 1, 5));
    const jitter = .8 + (this.io.random?.() ?? Math.random()) * .4;
    const delay = Math.max(Math.round(base * jitter), (retryAfter || 0) * 1000);
    entry.retryAt = this.now() + delay;
    this.setState(roomId, { status: 'retrying', error: error.slice(0, 200), retryAt: entry.retryAt }); this.changed();
    entry.timer = setTimeout(() => { if (entry.active && this.entries.get(roomId) === entry && !this.disposed) void this.connect(roomId, entry); }, delay);
  }
  private dropStaging(roomId: string): void { const previous = this.staging.get(roomId); if (previous) this.stagedBytes -= previous.bytes; this.staging.delete(roomId); }
  private consumeSnapshot(room: Extract<DanmakuWorkerEvent, { type: 'batch' }>['rooms'][number]): void {
    const part = room.scSnapshot;
    if (!part) return;
    if (!/^\d{1,20}$/.test(part.id) || !Number.isSafeInteger(part.total) || part.total < 0 || part.total > 100 || !Number.isSafeInteger(part.offset)) return;
    if (part.offset === 0) {
      const revision = BigInt(part.id);
      if (revision <= (this.snapshotRevisions.get(room.roomId) ?? -1n)) return;
      this.snapshotRevisions.set(room.roomId, revision);
      this.dropStaging(room.roomId); this.staging.set(room.roomId, { id: part.id, total: part.total, messages: [], bytes: 0 });
    }
    const current = this.staging.get(room.roomId);
    if (!current || current.id !== part.id || current.total !== part.total || current.messages.length !== part.offset) return;
    const bytes = part.messages.reduce((sum, message) => sum + messageBytes(message), 0);
    if (current.messages.length + part.messages.length > part.total || current.bytes + bytes > 1024 * 1024 || this.stagedBytes + bytes > 4 * 1024 * 1024 || part.messages.some(message => message.roomId !== room.roomId || message.kind !== 'sc')) {
      this.dropStaging(room.roomId); return;
    }
    current.messages.push(...part.messages); current.bytes += bytes; this.stagedBytes += bytes;
    if (part.complete) {
      if (current.messages.length === current.total) this.store.replaceSuperChats({ [room.roomId]: current.messages });
      this.dropStaging(room.roomId);
    }
  }
  receive(event: DanmakuWorkerEvent): void {
    if (event.type === 'batch') {
      try {
        if (this.disposed) return;
        const rooms = event.rooms.filter(room => {
          const entry = this.entries.get(room.roomId);
          return entry && this.valid(room.roomId, entry, room.generation) && entry.clearVersion === room.clearVersion;
        });
        for (const room of rooms) {
          this.store.apply(room.events);
          if (room.superChats !== undefined) this.dropStaging(room.roomId);
          this.consumeSnapshot(room);
        }
        const sc = Object.fromEntries(rooms.filter(room => room.superChats !== undefined).map(room => [room.roomId, room.superChats!]));
        if (Object.keys(sc).length) this.store.replaceSuperChats(sc);
        if (rooms.length) this.changed(true);
        for (const room of rooms) this.deliver(room.roomId, room.events);
      } finally {
        // Stale/cleared/removed rooms also release the one transport credit.
        // A subscriber exception must not permanently stall the worker.
        if (!this.disposed) this.io.post({ type: 'ack', batchId: event.batchId });
      }
      return;
    }
    const entry = this.entries.get(event.roomId);
    if (!entry || !this.valid(event.roomId, entry, event.generation)) return;
    if (event.type === 'events') {
      this.store.apply(event.events);
      this.deliver(event.roomId, event.events);
      this.changed(true);
    } else if (event.state.status === 'error') {
      this.startGap(event.roomId, entry, 'disconnected', event.occurredAt);
      this.dropStaging(event.roomId);
      entry.hostIndex++;
      this.retry(event.roomId, entry, event.state.error || '弹幕连接已断开');
    } else {
      if (event.state.status === 'live' && entry.timer) return;
      this.setState(event.roomId, { ...event.state, error: undefined, retryAt: undefined }); this.changed();
      if (event.state.status === 'live') {
        this.endGap(event.roomId, event.generation, event.occurredAt);
        clearTimeout(entry.healthyTimer);
        entry.healthyTimer = setTimeout(() => { if (this.valid(event.roomId, entry, event.generation)) entry.failures = 0; }, 30000);
      }
    }
  }
  private deliver(roomId: string, events: readonly DanmakuEvent[]): void {
    const messages = events.filter((value): value is Extract<DanmakuEvent, { type: 'message' }> => value.type === 'message').map(value => value.message);
    if (messages.length) {
      this.io.messages?.(roomId, messages);
      for (const listener of this.listeners.get(roomId) || []) listener(messages);
    }
  }
  clear(roomId: string): void {
    const entry = this.entries.get(roomId);
    if (!entry) return;
    this.io.post({ type: 'clear', roomId, generation: entry.generation, clearVersion: ++entry.clearVersion });
    this.dropStaging(roomId); this.store.clear(roomId); this.setState(roomId, { gaps: undefined });
    const frozen = this.publishedView === 'none' ? this.publishedSnapshot?.[roomId] : undefined;
    if (frozen && (frozen.messages.length || frozen.superChats.length || frozen.gaps?.length)) {
      // Explicit clear also releases a paused view's frozen reading snapshot.
      // If UI publication is suspended, deliver this empty projection on resume.
      this.publishedSnapshot = { ...this.publishedSnapshot, [roomId]: { ...frozen, messages: emptyHistory, superChats: emptyHistory, gaps: undefined } };
      if (this.publishing) this.io.changed(this.publishedSnapshot);
      else this.forcePublication = true;
    }
    this.changed();
  }
  reconnect(roomId: string): void {
    const entry = this.entries.get(roomId);
    if (!entry || !entry.active || (entry.retryAt && entry.retryAt > this.now())) return;
    this.startGap(roomId, entry, 'paused');
    this.stop(roomId, entry); entry.terminal = false; entry.bootstrap = undefined; entry.hostIndex = 0;
    void this.connect(roomId, entry, true);
  }
  online(): void {
    for (const [roomId, entry] of this.entries) if (entry.active && entry.retryAt && entry.retryAt <= this.now()) void this.connect(roomId, entry);
  }
  subscribe(roomId: string, listener: (messages: DanmakuMessage[]) => void): () => void {
    let room = this.listeners.get(roomId); if (!room) this.listeners.set(roomId, room = new Set());
    room.add(listener);
    return () => { room?.delete(listener); if (!room?.size) this.listeners.delete(roomId); };
  }
  dispose(): void {
    this.disposed = true; clearTimeout(this.publishTimer);
    clearTimeout(this.connectTimer); this.connectQueue.length = 0;
    for (const [roomId, entry] of this.entries) this.stop(roomId, entry);
    this.entries.clear(); this.demandedRooms.clear(); this.listeners.clear(); this.store.reset();
    this.connectionStates.clear(); this.publishedSnapshot = undefined;
    this.staging.clear(); this.stagedBytes = 0;
    this.snapshotRevisions.clear();
    this.io.post({ type: 'dispose' });
  }
}
