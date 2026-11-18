import type { DanmakuEvent, DanmakuMessage } from './types';

/** Logical UTF-16/object estimates only; these are not browser heap or image budgets. */
export function logicalBytes(value: unknown, depth = 0): number {
  if (typeof value === 'string') return 16 + value.length * 2;
  if (value === null || value === undefined) return 8;
  if (typeof value !== 'object') return 8;
  if (depth >= 8) return 256;
  if (Array.isArray(value)) return 24 + value.reduce((sum, item) => sum + logicalBytes(item, depth + 1), 0);
  return 48 + Object.entries(value).reduce((sum, [key, item]) => sum + key.length * 2 + 16 + logicalBytes(item, depth + 1), 0);
}

// Normalized messages are immutable across the queue, history and SC snapshots.
// A WeakMap avoids rescanning rich fields at every handoff without retaining them.
const measuredMessages = new WeakMap<DanmakuMessage, number>();
export function messageBytes(message: DanmakuMessage): number {
  let bytes = measuredMessages.get(message);
  if (bytes === undefined) { bytes = 256 + logicalBytes(message); measuredMessages.set(message, bytes); }
  return bytes;
}
export const eventBytes = (event: DanmakuEvent): number => event.type === 'message' ? 64 + messageBytes(event.message) : 64 + logicalBytes(event);
export const historyLimits = { roomBytes: 1024 * 1024, pageBytes: 8 * 1024 * 1024,
  roomMessages: 500, pageMessages: 3000, roomSc: 100, pageSc: 300 } as const;
