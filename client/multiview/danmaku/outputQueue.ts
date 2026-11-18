import { MAX_ADAPTIVE_GRID_ROOMS } from '../adaptiveGrid';
import { DanmakuStore } from './store';
import { eventBytes, messageBytes } from './budget';
import type { DanmakuBatchRoom, DanmakuEvent, DanmakuMessage, DanmakuWorkerEvent } from './types';

export const danmakuOutputLimits = {
  rooms: MAX_ADAPTIVE_GRID_ROOMS, roomEvents: 500, pageEvents: 3000,
  roomBytes: 1024 * 1024, pageBytes: 4 * 1024 * 1024,
  batchEvents: 200, batchBytes: 256 * 1024, flushMs: 40,
} as const;
const isSc = (event: DanmakuEvent): boolean => event.type === 'delete-sc' || event.message.kind === 'sc';
interface Pending { key: number; roomId: string; event: DanmakuEvent; bytes: number }
interface Room { generation: number; clearVersion: number; pending: Map<number, Pending>; bytes: number }
interface Snapshot { id: string; messages: DanmakuMessage[]; offset: number; bytes: number }

/** One ACK credit, incremental indexes and round-robin output across demanded rooms. */
export class DanmakuOutputQueue {
  private readonly rooms = new Map<string, Room>();
  private readonly sc = new DanmakuStore({ roomBytes: danmakuOutputLimits.roomBytes / 2, pageBytes: danmakuOutputLimits.pageBytes / 2 });
  private readonly pending = new Map<number, Pending>();
  private readonly pendingSc = new Map<number, Pending>();
  private readonly snapshots = new Map<string, Snapshot>();
  private pendingBytes = 0;
  private snapshotBytes = 0;
  private scSnapshot = false;
  private snapshotDirty = false;
  private snapshotSequence = 0;
  private eventSequence = 0;
  private cursor = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight?: number;
  private sequence = 0;
  private disposed = false;
  constructor(private readonly post: (event: Extract<DanmakuWorkerEvent, { type: 'batch' }>) => void) {}

  begin(roomId: string, generation: number, clearVersion: number, superChats: DanmakuMessage[]): void {
    if (this.disposed || (this.rooms.get(roomId)?.generation ?? -1) > generation) return;
    if (!this.rooms.has(roomId) && this.rooms.size >= danmakuOutputLimits.rooms) return;
    this.dropRoom(roomId);
    this.rooms.set(roomId, { generation, clearVersion, pending: new Map(), bytes: 0 });
    this.sc.setState(roomId, { superChats });
    if (this.scSnapshot) this.invalidateSnapshots();
    this.bound(roomId);
  }
  current(roomId: string, generation: number): boolean { return !this.disposed && this.rooms.get(roomId)?.generation === generation; }
  private erase(item: Pending): void {
    if (!this.pending.delete(item.key)) return;
    this.pendingSc.delete(item.key); this.pendingBytes -= item.bytes;
    const room = this.rooms.get(item.roomId);
    if (room) { room.pending.delete(item.key); room.bytes -= item.bytes; }
  }
  private dropRoom(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (room) for (const item of room.pending.values()) this.erase(item);
    this.dropSnapshot(roomId); this.sc.remove(roomId);
  }
  clear(roomId: string, generation: number, clearVersion: number): void {
    const room = this.rooms.get(roomId);
    if (!this.current(roomId, generation) || !room || clearVersion <= room.clearVersion) return;
    for (const item of room.pending.values()) this.erase(item);
    room.clearVersion = clearVersion; this.sc.clear(roomId); this.dropSnapshot(roomId);
    if (this.scSnapshot) this.invalidateSnapshots();
  }
  remove(roomId: string, generation: number): void {
    const room = this.rooms.get(roomId);
    if (!room || room.generation > generation) return;
    this.dropRoom(roomId); this.rooms.delete(roomId);
    if (!this.rooms.size) { this.scSnapshot = false; this.snapshotDirty = false; }
    if (!this.pending.size && !this.snapshots.size) this.cancelTimer();
    // A posted batch keeps its ACK credit even when the room is reopened.
  }
  private dropSnapshot(roomId: string): void {
    const previous = this.snapshots.get(roomId); if (previous) this.snapshotBytes -= previous.bytes;
    this.snapshots.delete(roomId);
  }
  private invalidateSnapshots(): void { this.snapshotDirty = true; }
  add(roomId: string, generation: number, events: readonly DanmakuEvent[]): void {
    if (!this.current(roomId, generation) || !events.length) return;
    const room = this.rooms.get(roomId)!;
    for (const event of events) {
      if ((event.type === 'message' ? event.message.roomId : event.roomId) !== roomId) continue;
      const bytes = eventBytes(event);
      if (bytes + 256 > danmakuOutputLimits.batchBytes) continue;
      if (isSc(event) && this.scSnapshot) {
        this.sc.apply([event]); this.invalidateSnapshots();
      } else {
        const item = { key: ++this.eventSequence, roomId, event, bytes };
        this.pending.set(item.key, item); room.pending.set(item.key, item); room.bytes += bytes; this.pendingBytes += bytes;
        if (isSc(event)) this.pendingSc.set(item.key, item);
      }
      this.bound(roomId);
    }
    if (!this.inFlight) {
      if (room.pending.size >= danmakuOutputLimits.batchEvents) this.flush();
      else if (!this.timer && (this.pending.size || this.snapshotDirty || this.snapshots.size)) this.timer = setTimeout(() => this.flush(), danmakuOutputLimits.flushMs);
    }
  }
  ack(batchId: number): void {
    if (this.disposed || this.inFlight === undefined || batchId !== this.inFlight) return;
    this.inFlight = undefined; this.flush();
  }
  private coalesceSc(): void {
    if (this.pendingSc.size) {
      const changes = [...this.pendingSc.values()];
      this.sc.apply(changes.map(item => item.event));
      for (const item of changes) this.erase(item);
    }
    this.scSnapshot = true; this.invalidateSnapshots();
  }
  private bound(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    const overflow = () => this.pending.size > danmakuOutputLimits.pageEvents || this.pendingBytes + this.sc.stats().bytes + this.snapshotBytes > danmakuOutputLimits.pageBytes
      || room.pending.size > danmakuOutputLimits.roomEvents || room.bytes + this.sc.roomBytes(roomId) + (this.snapshots.get(roomId)?.bytes ?? 0) > danmakuOutputLimits.roomBytes;
    if (!overflow()) return;
    if (this.pendingSc.size) this.coalesceSc();
    while (room.pending.size > danmakuOutputLimits.roomEvents || room.bytes + this.sc.roomBytes(roomId) + (this.snapshots.get(roomId)?.bytes ?? 0) > danmakuOutputLimits.roomBytes) {
      const first = room.pending.values().next().value; if (!first) break; this.erase(first);
    }
    while (this.pending.size > danmakuOutputLimits.pageEvents || this.pendingBytes + this.sc.stats().bytes + this.snapshotBytes > danmakuOutputLimits.pageBytes) {
      const first = this.pending.values().next().value; if (!first) break; this.erase(first);
    }
  }
  private cancelTimer(): void { clearTimeout(this.timer); this.timer = undefined; }
  private prepareSnapshots(): void {
    if (!this.snapshotDirty || this.snapshots.size) return;
    this.snapshotDirty = false;
    const id = String(++this.snapshotSequence);
    for (const [roomId, room] of Object.entries(this.sc.snapshot())) {
      const bytes = room.superChats.reduce((sum, message) => sum + messageBytes(message), 0);
      this.snapshots.set(roomId, { id, messages: room.superChats, offset: 0, bytes }); this.snapshotBytes += bytes;
    }
    for (const roomId of this.rooms.keys()) this.bound(roomId);
  }
  private flush(): void {
    this.cancelTimer();
    if (this.disposed || this.inFlight || (!this.pending.size && !this.snapshotDirty && !this.snapshots.size)) return;
    this.prepareSnapshots();
    const updates = new Map<string, DanmakuBatchRoom>();
    let count = 0, bytes = 64;
    const update = (roomId: string): DanmakuBatchRoom => {
      let entry = updates.get(roomId);
      if (!entry) {
        const room = this.rooms.get(roomId)!;
        entry = { roomId, generation: room.generation, clearVersion: room.clearVersion, events: [] };
        updates.set(roomId, entry); bytes += 128 + roomId.length * 2;
      }
      return entry;
    };
    const ids = [...this.rooms.keys()];
    const order = [...ids.slice(this.cursor % Math.max(1, ids.length)), ...ids.slice(0, this.cursor % Math.max(1, ids.length))];
    this.cursor = (this.cursor + 1) % Math.max(1, ids.length);
    let progress = true;
    while (progress && count < danmakuOutputLimits.batchEvents) {
      progress = false;
      for (const roomId of order) {
        if (count >= danmakuOutputLimits.batchEvents) break;
        const room = this.rooms.get(roomId)!;
        const snapshot = this.snapshots.get(roomId);
        if (snapshot && !updates.get(roomId)?.scSnapshot && !updates.get(roomId)?.superChats) {
          const left = snapshot.messages.slice(snapshot.offset);
          const fullBytes = left.reduce((sum, message) => sum + messageBytes(message), 128);
          const overhead = updates.has(roomId) ? 0 : 128 + roomId.length * 2;
          if (snapshot.offset === 0 && count + Math.max(1, left.length) <= danmakuOutputLimits.batchEvents && bytes + fullBytes + overhead <= danmakuOutputLimits.batchBytes) {
            update(roomId).superChats = left; bytes += fullBytes; count += Math.max(1, left.length);
            this.dropSnapshot(roomId); progress = true;
          } else if (snapshot.offset > 0 || fullBytes + 256 > danmakuOutputLimits.batchBytes) {
            const messages: DanmakuMessage[] = [];
            let partBytes = 128;
            for (const message of left) {
              const next = messageBytes(message);
              if (messages.length >= 32 || count + messages.length >= danmakuOutputLimits.batchEvents || bytes + overhead + partBytes + next > danmakuOutputLimits.batchBytes) break;
              messages.push(message); partBytes += next;
            }
            if (messages.length || !left.length) {
              const offset = snapshot.offset; snapshot.offset += messages.length;
              const complete = snapshot.offset === snapshot.messages.length;
              update(roomId).scSnapshot = { id: snapshot.id, offset, total: snapshot.messages.length, messages, complete };
              count += Math.max(1, messages.length); bytes += partBytes;
              if (complete) this.dropSnapshot(roomId);
              progress = true;
            }
          }
        }
        for (let quantum = 0; quantum < 16 && count < danmakuOutputLimits.batchEvents; quantum++) {
          const item = room.pending.values().next().value;
          if (!item) break;
          const overhead = updates.has(roomId) ? 0 : 128 + roomId.length * 2;
          if (bytes + overhead + item.bytes > danmakuOutputLimits.batchBytes) break;
          update(roomId).events.push(item.event); count++; bytes += item.bytes; this.erase(item); progress = true;
        }
      }
    }
    if (!updates.size) return;
    if (!this.scSnapshot) {
      const changes = [...updates.values()].flatMap(room => room.events.filter(isSc));
      if (changes.length) this.sc.apply(changes);
    }
    for (const roomId of this.rooms.keys()) this.bound(roomId);
    if (this.scSnapshot && !this.snapshotDirty && !this.snapshots.size) this.scSnapshot = false;
    const batchId = ++this.sequence; this.inFlight = batchId;
    this.post({ type: 'batch', batchId, rooms: [...updates.values()] });
  }
  stats(): { rooms: number; pendingEvents: number; pendingBytes: number; inFlight: number; scMessages: number } {
    return { rooms: this.rooms.size, pendingEvents: this.pending.size, pendingBytes: this.pendingBytes + this.sc.stats().bytes + this.snapshotBytes,
      inFlight: this.inFlight === undefined ? 0 : 1, scMessages: this.sc.stats().superChats };
  }
  dispose(): void {
    this.disposed = true; this.cancelTimer(); this.pending.clear(); this.pendingSc.clear(); this.rooms.clear(); this.sc.reset(); this.snapshots.clear();
    this.pendingBytes = 0; this.snapshotBytes = 0; this.inFlight = undefined; this.snapshotDirty = false;
  }
}
