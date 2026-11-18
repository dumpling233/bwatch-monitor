export interface MultiviewLayout {
  id: string;
  name: string;
  count: number;
  areas: string[];
}

export type RoomSlot = string | null;

/** Explicit rectangular tracks preserve the ALGS silhouettes at every size. */
export const MULTIVIEW_LAYOUTS: readonly MultiviewLayout[] = [
  { id: 'one', name: '单画面', count: 1, areas: ['A'] },
  { id: 'two-wide', name: '双画面 · 左右', count: 2, areas: ['A B'] },
  { id: 'two-tall', name: '双画面 · 上下', count: 2, areas: ['A', 'B'] },
  { id: 'three-pyramid', name: '三画面 · 上一后二', count: 3, areas: ['. A A .', 'B B C C'] },
  { id: 'three-focus', name: '三画面 · 左侧主画面', count: 3, areas: ['A A A A B B', 'A A A A C C'] },
  { id: 'four-grid', name: '四画面 · 网格', count: 4, areas: ['A B', 'C D'] },
  { id: 'four-focus', name: '四画面 · 上方主画面', count: 4, areas: ['. A A A A .', '. A A A A .', 'B B C C D D'] },
  { id: 'five-wide', name: '五画面 · 上二下三', count: 5, areas: ['A A A B B B', 'C C D D E E'] },
  { id: 'five-side', name: '五画面 · 左二右三', count: 5, areas: ['A A A C C C', 'A A A C C C', 'A A A D D D', 'B B B D D D', 'B B B E E E', 'B B B E E E'] },
  { id: 'five-centered', name: '五画面 · 居中', count: 5, areas: ['. A A B B .', 'C C D D E E'] },
  { id: 'six-wide', name: '六画面 · 三列', count: 6, areas: ['A B C', 'D E F'] },
  { id: 'six-tall', name: '六画面 · 两列', count: 6, areas: ['A B', 'C D', 'E F'] },
  { id: 'six-focus', name: '六画面 · 主画面', count: 6, areas: ['A A B', 'A A C', 'D E F'] },
  { id: 'seven', name: '七画面 · 居中', count: 7, areas: ['A B C', 'D E F', '. G .'] },
  { id: 'eight-grid', name: '八画面 · 三列', count: 8, areas: ['A B C', 'D E F', 'G H .'] },
  { id: 'eight-focus', name: '八画面 · 主画面', count: 8, areas: ['A A A B', 'A A A C', 'A A A D', 'E F G H'] },
  { id: 'eight-wide', name: '八画面 · 四列', count: 8, areas: ['A B C D', 'E F G H'] },
  { id: 'eight-gallery', name: '八画面 · 四大四小', count: 8, areas: ['A A B B', 'A A B B', 'A A B B', 'A A B B', 'C C D D', 'C C D D', 'C C D D', 'C C D D', 'E F G H', 'E F G H'] },
  { id: 'nine-grid', name: '九画面 · 网格', count: 9, areas: ['A B C', 'D E F', 'G H I'] },
  { id: 'nine-focus', name: '九画面 · 主画面', count: 9, areas: ['A A B', 'A A C', 'D E F', 'G H I'] },
  { id: 'ten-top', name: '十画面 · 上方双主画面', count: 10, areas: ['A A B B', 'A A B B', 'C D E F', 'G H I J'] },
  { id: 'ten-left', name: '十画面 · 左侧双主画面', count: 10, areas: ['A A B C', 'A A D E', 'F F G H', 'F F I J'] },
  { id: 'ten-right', name: '十画面 · 右侧双主画面', count: 10, areas: ['A B I I', 'C D I I', 'E F J J', 'G H J J'] },
  { id: 'ten-centered', name: '十画面 · 三列居中', count: 10, areas: ['A B C', 'D E F', 'G H I', '. J .'] },
  { id: 'eleven', name: '十一画面', count: 11, areas: ['A B C', 'D E F', 'G H I', 'J K .'] },
  { id: 'twelve', name: '十二画面', count: 12, areas: ['A B C', 'D E F', 'G H I', 'J K L'] },
];

export const DEFAULT_LAYOUT_ID = 'four-grid';
export const SLOT_AREAS = 'ABCDEFGHIJKL'.split('');

export function findLayout(id: string): MultiviewLayout {
  return MULTIVIEW_LAYOUTS.find(layout => layout.id === id) ?? MULTIVIEW_LAYOUTS.find(layout => layout.id === DEFAULT_LAYOUT_ID)!;
}

export function layoutForCount(count: number, currentId?: string): MultiviewLayout {
  const current = currentId ? findLayout(currentId) : undefined;
  const safeCount = Math.max(1, Math.min(12, Math.ceil(count)));
  return current?.count === safeCount ? current : MULTIVIEW_LAYOUTS.find(layout => layout.count === safeCount)!;
}

export function layoutGridStyle(layout: MultiviewLayout) {
  return {
    gridTemplateAreas: layout.areas.map(row => `"${row}"`).join(' '),
    gridTemplateColumns: `repeat(${layout.areas[0].trim().split(/\s+/).length}, minmax(0, 1fr))`,
    gridTemplateRows: `repeat(${layout.areas.length}, minmax(0, 1fr))`,
  };
}

const slotCapacity = (capacity: number) => Number.isFinite(capacity) ? Math.max(1, Math.min(12, Math.ceil(capacity))) : 1;

/** Keep holes and selected rooms beyond the current template, without trusting saved slot IDs. */
export function normalizeSlotRoomIds(input: unknown, roomIds: readonly string[], minimumCapacity: number): RoomSlot[] {
  const selected = [...new Set(roomIds)].slice(0, SLOT_AREAS.length);
  const allowed = new Set(selected);
  const source = Array.isArray(input) ? input.slice(0, SLOT_AREAS.length) : [];
  const seen = new Set<string>();
  const slots: RoomSlot[] = Array.from(source, value => {
    if (typeof value !== 'string' || !allowed.has(value) || seen.has(value)) return null;
    seen.add(value);
    return value;
  });
  const length = Math.max(slotCapacity(minimumCapacity), selected.length, slots.length);
  while (slots.length < length) slots.push(null);
  for (const id of selected) {
    if (seen.has(id)) continue;
    slots[slots.indexOf(null)] = id;
    seen.add(id);
  }
  return slots;
}

/** Selecting a template deliberately fills it in selection order. */
export function resetSlotRoomIds(roomIds: readonly string[], capacity: number): RoomSlot[] {
  return normalizeSlotRoomIds(undefined, roomIds, capacity);
}

/** A drop exchanges exactly two slots; it never shifts a third room. */
export function swapRoomSlots(slots: readonly RoomSlot[], fromIndex: number, toIndex: number): RoomSlot[] {
  const next = [...slots];
  if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex) || fromIndex < 0 || toIndex < 0 || fromIndex >= next.length || toIndex >= next.length) return next;
  [next[fromIndex], next[toIndex]] = [next[toIndex], next[fromIndex]];
  return next;
}

export function visibleSlotIndices(total: number, capacity: number, offset: number): number[] {
  const length = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
  if (!length) return [];
  const startOffset = Number.isFinite(offset) ? Math.trunc(offset) : 0;
  const start = ((startOffset % length) + length) % length;
  const size = Number.isFinite(capacity) ? Math.max(1, Math.floor(capacity)) : 1;
  return Array.from({ length: Math.min(size, length) }, (_, index) => (start + index) % length);
}

export function visibleWindow<T>(items: readonly T[], capacity: number, offset: number): T[] {
  return visibleSlotIndices(items.length, capacity, offset).map(index => items[index]);
}

export function moveRoom(roomIds: readonly string[], from: string, to: string): string[] {
  const fromIndex = roomIds.indexOf(from), toIndex = roomIds.indexOf(to);
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return [...roomIds];
  return moveRoomToIndex(roomIds, fromIndex, fromIndex < toIndex ? toIndex - 1 : toIndex);
}

export function moveRoomToIndex(roomIds: readonly string[], fromIndex: number, insertionIndex: number): string[] {
  if (!Number.isInteger(fromIndex) || fromIndex < 0 || fromIndex >= roomIds.length) return [...roomIds];
  const next = [...roomIds];
  const [room] = next.splice(fromIndex, 1);
  if (room === undefined) return [...roomIds];
  const index = Math.max(0, Math.min(next.length, Math.trunc(insertionIndex)));
  next.splice(index, 0, room);
  return next;
}
