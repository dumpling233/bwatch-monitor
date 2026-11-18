import type { DanmakuEvent, DanmakuRoomState, DanmakuMessage } from './types';
import { historyLimits, messageBytes } from './budget';
import { OrderedIndex } from './orderedIndex';

export const emptyDanmakuRoom = (): DanmakuRoomState => ({ status: 'idle', messages: [], superChats: [] });
export type DanmakuHistoryView = 'all' | 'danmaku' | 'sc' | 'none';
const emptyHistory: DanmakuMessage[] = [];
type Kind = 'messages' | 'superChats';
interface Stored { key: string; roomId: string; kind: Kind; message: DanmakuMessage; bytes: number; sequence: number }
interface Room { state: DanmakuRoomState; messages: Map<string, Stored>; superChats: Map<string, Stored>;
  order: Map<string, Stored>; bytes: number; dirtyMessages: boolean; dirtySc: boolean }
interface Limits { roomBytes?: number; pageBytes?: number }

/** Insertion-ordered indexes make duplicate checks and oldest eviction constant-time. */
export class DanmakuStore {
  private readonly rooms = new Map<string, Room>();
  private readonly order = new Map<string, Stored>();
  private readonly messages = new Map<string, Stored>();
  private readonly superChats = new Map<string, Stored>();
  private bytes = 0;
  private sequence = 0;
  private readonly oldestAll = new OrderedIndex<Stored>((a, b) => a.message.receivedAt - b.message.receivedAt || a.sequence - b.sequence);
  private readonly oldestMessages = new OrderedIndex<Stored>((a, b) => a.message.receivedAt - b.message.receivedAt || a.sequence - b.sequence);
  private readonly oldestSc = new OrderedIndex<Stored>((a, b) => a.message.receivedAt - b.message.receivedAt || a.sequence - b.sequence);
  constructor(private readonly limits: Limits = {}) {}
  private dirty(room: Room, kind: Kind): void {
    const flag = kind === 'messages' ? 'dirtyMessages' : 'dirtySc';
    if (!room[flag]) room.state = { ...room.state, [kind]: [] };
    room[flag] = true;
  }
  setState(roomId: string, state: Partial<DanmakuRoomState>): void {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = { state: emptyDanmakuRoom(), messages: new Map(), superChats: new Map(), order: new Map(), bytes: 0, dirtyMessages: false, dirtySc: false };
      this.rooms.set(roomId, room);
    }
    const { messages, superChats, ...connection } = state;
    room.state = { ...room.state, ...connection };
    if (messages) this.replace(roomId, 'messages', messages);
    if (superChats) this.replace(roomId, 'superChats', superChats);
    this.bound();
  }
  private erase(item: Stored): void {
    const room = this.rooms.get(item.roomId);
    if (!room || !room[item.kind].delete(item.message.id)) return;
    room.order.delete(item.key); this.order.delete(item.key); this[item.kind].delete(item.key);
    this.oldestAll.remove(item.key); (item.kind === 'messages' ? this.oldestMessages : this.oldestSc).remove(item.key);
    room.bytes -= item.bytes; this.bytes -= item.bytes;
    this.dirty(room, item.kind);
  }
  private oldest(index: Map<string, Stored>): void {
    const heap = index === this.messages ? this.oldestMessages : index === this.superChats ? this.oldestSc : index === this.order ? this.oldestAll : undefined;
    const first = heap ? heap.first() : index.values().next().value;
    if (first) this.erase(first);
  }
  private insert(roomId: string, message: DanmakuMessage): void {
    const room = this.rooms.get(roomId);
    if (!room || message.roomId !== roomId) return;
    const kind: Kind = message.kind === 'sc' ? 'superChats' : 'messages';
    if (room[kind].has(message.id)) return;
    const bytes = messageBytes(message), roomLimit = this.limits.roomBytes ?? historyLimits.roomBytes;
    if (bytes > roomLimit || bytes > (this.limits.pageBytes ?? historyLimits.pageBytes)) return;
    const key = `${roomId}\0${kind}\0${message.id}`;
    const item: Stored = { key, roomId, kind, message, bytes, sequence: ++this.sequence };
    room[kind].set(message.id, item); room.order.set(key, item); this[kind].set(key, item); this.order.set(key, item);
    this.oldestAll.add(item); (kind === 'messages' ? this.oldestMessages : this.oldestSc).add(item);
    room.bytes += bytes; this.bytes += bytes;
    this.dirty(room, kind);
    const count = kind === 'messages' ? historyLimits.roomMessages : historyLimits.roomSc;
    while (room[kind].size > count) this.oldest(room[kind]);
    while (room.bytes > roomLimit) this.oldest(room.order);
  }
  apply(events: readonly DanmakuEvent[]): void {
    for (const event of events) {
      if (event.type === 'message') this.insert(event.message.roomId, event.message);
      else {
        const room = this.rooms.get(event.roomId);
        if (room) for (const id of event.ids) { const item = room.superChats.get(id); if (item) this.erase(item); }
      }
    }
    this.bound();
  }
  private bound(): void {
    while (this.messages.size > historyLimits.pageMessages) this.oldest(this.messages);
    while (this.superChats.size > historyLimits.pageSc) this.oldest(this.superChats);
    while (this.bytes > (this.limits.pageBytes ?? historyLimits.pageBytes)) this.oldest(this.order);
  }
  private replace(roomId: string, kind: Kind, messages: readonly DanmakuMessage[]): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    const wanted = new Set(messages.filter(message => message.roomId === roomId && (message.kind === 'sc') === (kind === 'superChats')).map(message => message.id));
    for (const item of [...room[kind].values()]) if (!wanted.has(item.message.id)) this.erase(item);
    for (const message of messages) if ((message.kind === 'sc') === (kind === 'superChats')) this.insert(roomId, message);
  }
  replaceSuperChats(rooms: Readonly<Record<string, readonly DanmakuMessage[]>>): void {
    for (const [roomId, messages] of Object.entries(rooms)) this.replace(roomId, 'superChats', messages);
    this.bound();
  }
  clear(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (room) for (const item of [...room.order.values()]) this.erase(item);
  }
  remove(roomId: string): void { this.clear(roomId); this.rooms.delete(roomId); }
  reset(): void {
    this.rooms.clear(); this.order.clear(); this.messages.clear(); this.superChats.clear();
    this.oldestAll.clear(); this.oldestMessages.clear(); this.oldestSc.clear(); this.bytes = 0;
  }
  room(roomId: string, view: Exclude<DanmakuHistoryView, 'none'> = 'all'): DanmakuRoomState | undefined {
    const room = this.rooms.get(roomId);
    if (!room) return;
    const messages = view !== 'sc' && room.dirtyMessages;
    const superChats = view !== 'danmaku' && room.dirtySc;
    if (messages || superChats) {
      room.state = { ...room.state,
        ...(messages ? { messages: [...room.messages.values()].map(item => item.message) } : {}),
        ...(superChats ? { superChats: [...room.superChats.values()].map(item => item.message) } : {}) };
      if (messages) room.dirtyMessages = false;
      if (superChats) room.dirtySc = false;
    }
    return view === 'all' ? room.state : { ...room.state,
      ...(view === 'sc' ? { messages: emptyHistory } : { superChats: emptyHistory }) };
  }
  snapshot(roomIds?: readonly string[]): Record<string, DanmakuRoomState> {
    return Object.fromEntries((roomIds ?? [...this.rooms.keys()]).flatMap(id => { const room = this.room(id); return room ? [[id, room]] : []; }));
  }
  stats(): { bytes: number; messages: number; superChats: number } { return { bytes: this.bytes, messages: this.messages.size, superChats: this.superChats.size }; }
  roomBytes(roomId: string): number { return this.rooms.get(roomId)?.bytes ?? 0; }
}
