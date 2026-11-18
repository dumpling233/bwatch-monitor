import type { LocalChatContext, LocalChatEmoticon, LocalChatEmoticonPackage } from '../../shared/localDanmaku';
import { emoticonImage } from './emoticons';

type Storage = { get(keys: string[]): Promise<Record<string, unknown>>; set(values: Record<string, unknown>): Promise<void> };
type Directory = Pick<LocalChatContext, 'emoticons' | 'emoticonPackages' | 'emoticonsTruncated'>;
type Row = { accountUid: string; roomId: string; aliases: string[]; updatedAt: number; usedAt: number; directory: Directory };
export const EMOTICON_CATALOG_KEY = 'bwatchMonitorEmoticonCatalog';
export const EMOTICON_CATALOG_FRESH_MS = 86_400_000;
export const EMOTICON_CATALOG_IDLE_MS = 7 * EMOTICON_CATALOG_FRESH_MS;
export const EMOTICON_CATALOG_MAX_BYTES = 4 * 1024 * 1024;
const MAX_DIRECTORY_BYTES = 1600 * 1024;
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const id = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const integer = (value: unknown, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
const image = (value: unknown): value is string => {
  if (!text(value, 2048)) return false;
  if (!value) return true;
  // Stored entries are already projected HTTPS URLs, not legacy API inputs.
  return value.startsWith('https://') && emoticonImage(value) === value;
};
export const catalogBytes = (value: unknown): number => JSON.stringify(value).length * 2;

/** Parse only projected display fields. Persisted data never restores runtime
 * account evidence, restrictions, CSRF or permission authority. */
function directory(value: unknown): Directory | undefined {
  const source = object(value);
  if (!Array.isArray(source.emoticons) || source.emoticons.length > 2048 ||
    (source.emoticonPackages !== undefined && (!Array.isArray(source.emoticonPackages) || source.emoticonPackages.length > 64)) ||
    (source.emoticonsTruncated !== undefined && typeof source.emoticonsTruncated !== 'boolean')) return;
  const emoticons: LocalChatEmoticon[] = [], seen = new Set<string>();
  for (const raw of source.emoticons) {
    const entry = object(raw);
    if (!text(entry.unique, 200) || !entry.unique || seen.has(entry.unique) || !text(entry.text, 100) || !image(entry.url) ||
      typeof entry.permitted !== 'boolean' || !text(entry.packageName, 80) || !['text', 'image'].includes(String(entry.kind)) ||
      (entry.packageId !== undefined && !text(entry.packageId, 160)) ||
      (entry.unlockHint !== undefined && !text(entry.unlockHint, 160)) || (entry.unlockLabel !== undefined && !text(entry.unlockLabel, 40)) ||
      (entry.width !== undefined && !integer(entry.width, 4096)) || (entry.height !== undefined && !integer(entry.height, 4096)) ||
      (entry.dynamic !== undefined && typeof entry.dynamic !== 'boolean')) return;
    seen.add(entry.unique);
    emoticons.push({ unique: entry.unique, text: entry.text, url: entry.url, permitted: entry.permitted,
      packageName: entry.packageName, kind: entry.kind as 'text' | 'image',
      ...(entry.packageId !== undefined ? { packageId: entry.packageId as string } : {}),
      ...(entry.unlockHint !== undefined ? { unlockHint: entry.unlockHint as string } : {}),
      ...(entry.unlockLabel !== undefined ? { unlockLabel: entry.unlockLabel as string } : {}),
      ...(entry.width !== undefined ? { width: entry.width as number } : {}), ...(entry.height !== undefined ? { height: entry.height as number } : {}),
      ...(entry.dynamic !== undefined ? { dynamic: entry.dynamic as boolean } : {}) });
  }
  const emoticonPackages: LocalChatEmoticonPackage[] = [], packageIds = new Set<string>();
  let references = 0;
  for (const raw of (source.emoticonPackages ?? []) as unknown[]) {
    const entry = object(raw);
    if (!text(entry.id, 160) || !entry.id || packageIds.has(entry.id) || !text(entry.name, 80) || !image(entry.icon) ||
      (entry.type !== undefined && !integer(entry.type, 65535)) || !Array.isArray(entry.emoticonUniques) ||
      entry.emoticonUniques.length > 2048 || entry.emoticonUniques.some(unique => typeof unique !== 'string' || !seen.has(unique)) ||
      (references += entry.emoticonUniques.length) > 4096) return;
    packageIds.add(entry.id);
    emoticonPackages.push({ id: entry.id, name: entry.name, icon: entry.icon,
      ...(entry.type !== undefined ? { type: entry.type as number } : {}), emoticonUniques: [...entry.emoticonUniques] as string[] });
  }
  const result: Directory = { emoticons, ...(source.emoticonPackages !== undefined ? { emoticonPackages } : {}),
    ...(source.emoticonsTruncated !== undefined ? { emoticonsTruncated: source.emoticonsTruncated as boolean } : {}) };
  return catalogBytes(result) <= MAX_DIRECTORY_BYTES ? result : undefined;
}

/** Demand-only display cache. There are no timers, prefetches or shared room
 * memberships; every stored package list belongs to one UID and real room. */
export class EmoticonCatalog {
  private readonly rows = new Map<string, Row>();
  private readonly touchSavedAt = new Map<string, number>();
  private generation = 0;
  private serial: Promise<unknown> = Promise.resolve();
  readonly ready: Promise<void>;
  constructor(private readonly storage: Storage | undefined, private readonly now: () => number) { this.ready = this.restore(); }
  private async restore(): Promise<void> {
    const generation = this.generation;
    try {
      const source = object((await this.storage?.get([EMOTICON_CATALOG_KEY]))?.[EMOTICON_CATALOG_KEY]);
      if (generation !== this.generation || source.schemaVersion !== 1 || !Array.isArray(source.rows) || source.rows.length > 32) return;
      for (const raw of source.rows) {
        const item = object(raw);
        if (!id(item.accountUid) || !id(item.roomId) || !Array.isArray(item.aliases) || item.aliases.length > 8 || !item.aliases.every(id) ||
          typeof item.updatedAt !== 'number' || !Number.isFinite(item.updatedAt) || item.updatedAt > this.now() ||
          typeof item.usedAt !== 'number' || !Number.isFinite(item.usedAt) || item.usedAt < item.updatedAt || item.usedAt > this.now() ||
          item.usedAt <= this.now() - EMOTICON_CATALOG_IDLE_MS) continue;
        const value = directory(item.directory); if (!value) continue;
        this.rows.set(`${item.accountUid}:${item.roomId}`, { accountUid: item.accountUid, roomId: item.roomId,
          aliases: [...new Set(item.aliases)] as string[], updatedAt: item.updatedAt, usedAt: item.usedAt, directory: value });
        this.touchSavedAt.set(`${item.accountUid}:${item.roomId}`, item.usedAt);
      }
      const trimmed = this.trim();
      if (trimmed || this.rows.size !== source.rows.length) this.persist();
    } catch { /* A damaged/unavailable optional display cache cannot stop chat. */ }
  }
  private trim(): boolean {
    const previousSize = this.rows.size;
    for (const [key, row] of this.rows) if (row.usedAt <= this.now() - EMOTICON_CATALOG_IDLE_MS) this.rows.delete(key);
    const ordered = [...this.rows].sort((a, b) => a[1].usedAt - b[1].usedAt);
    let bytes = catalogBytes({ schemaVersion: 1, rows: [...this.rows.values()] });
    for (const [key, row] of ordered) {
      if (this.rows.size <= 32 && bytes <= EMOTICON_CATALOG_MAX_BYTES) break;
      this.rows.delete(key); bytes -= catalogBytes(row) + 2;
    }
    for (const key of this.touchSavedAt.keys()) if (!this.rows.has(key)) this.touchSavedAt.delete(key);
    return this.rows.size !== previousSize;
  }
  private persist(): void {
    const generation = this.generation;
    const task = async () => {
      if (generation !== this.generation || !this.storage) return;
      await this.storage.set({ [EMOTICON_CATALOG_KEY]: { schemaVersion: 1, rows: [...this.rows.values()] } });
    };
    this.serial = this.serial.then(task, task).catch(() => {});
  }
  peek(accountUid: string, roomId: string): { roomId: string; directory: Directory; fresh: boolean } | undefined {
    if (this.trim()) this.persist();
    const row = this.rows.get(`${accountUid}:${roomId}`) ?? [...this.rows.values()].find(value => value.accountUid === accountUid && value.aliases.includes(roomId));
    return row ? { roomId: row.roomId, directory: structuredClone(row.directory), fresh: row.updatedAt + EMOTICON_CATALOG_FRESH_MS > this.now() } : undefined;
  }
  touch(accountUid: string, roomId: string): void {
    const key = `${accountUid}:${roomId}`, row = this.rows.get(key);
    if (!row) return;
    row.usedAt = this.now();
    // Coalesce frequent openings without a timer or a disk write per click.
    if (row.usedAt - (this.touchSavedAt.get(key) ?? 0) >= 3_600_000) { this.touchSavedAt.set(key, row.usedAt); this.persist(); }
  }
  set(accountUid: string, roomId: string, alias: string, value: Directory): Promise<void> {
    const parsed = directory(value); if (!parsed || !id(accountUid) || !id(roomId) || !id(alias)) return Promise.resolve();
    const key = `${accountUid}:${roomId}`, old = this.rows.get(key);
    const changed = !old || !old.aliases.includes(alias) || JSON.stringify(old.directory) !== JSON.stringify(parsed);
    this.rows.set(key, { accountUid, roomId, aliases: [...new Set([alias, ...(old?.aliases ?? [])])].slice(0, 8),
      updatedAt: this.now(), usedAt: this.now(), directory: parsed });
    const trimmed = this.trim();
    if (changed || trimmed || this.now() - (this.touchSavedAt.get(key) ?? 0) >= 3_600_000) {
      this.touchSavedAt.set(key, this.now()); this.persist();
    }
    return this.flush();
  }
  clear(): void { this.generation++; this.rows.clear(); this.touchSavedAt.clear(); this.persist(); }
  async flush(): Promise<void> { await this.serial; }
}
