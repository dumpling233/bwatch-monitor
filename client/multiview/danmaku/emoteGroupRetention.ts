/** Bound retained grid DOM; native image loading belongs to the browser. */
export const EMOTE_GROUP_CELL_LIMIT = 224;

/** UI-only LRU, oldest first. Image bytes and catalogue freshness remain owned
 * by the browser and the existing catalogue lifecycle respectively. */
export function retainEmoteGroups(previous: readonly string[], groups: readonly { id: string; count: number }[], current: string): string[] {
  const counts = new Map(groups.map(group => [group.id, group.count]));
  const size = counts.get(current);
  if (size === undefined) return [];
  // Large packages use a virtual grid; never retain their hidden grid or hold
  // ordinary packages beside them that could multiply retained DOM.
  if (size > EMOTE_GROUP_CELL_LIMIT) return [current];
  const retained = [...new Set(previous)].filter(id => id !== current && counts.has(id) && counts.get(id)! <= EMOTE_GROUP_CELL_LIMIT);
  retained.push(current);
  let cells = retained.reduce((sum, id) => sum + counts.get(id)!, 0);
  while (cells > EMOTE_GROUP_CELL_LIMIT && retained.length > 1) cells -= counts.get(retained.shift()!)!;
  return retained;
}
