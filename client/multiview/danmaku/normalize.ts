import type { DanmakuEvent, DanmakuMedal, DanmakuMessage, DanmakuSegment } from './types';
import { resolveSuperChatColors, superChatHexColor } from './superChatColors';
import { messageBytes } from './budget';
import { decodeDanmakuV2 } from './dmV2';

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, max = 2000): string => typeof value === 'string' ? value.slice(0, max) : '';
const flag = (value: unknown): boolean | undefined => value === true || value === 1 ? true : value === false || value === 0 ? false : undefined;
const role = (value: unknown): 0 | 1 | 2 | 3 | undefined => typeof value === 'number' && [0, 1, 2, 3].includes(value) ? value as 0 | 1 | 2 | 3 : undefined;
const positive = (value: unknown, max = Number.MAX_SAFE_INTEGER): number | undefined => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= max ? value : undefined;
const timestamp = (value: unknown, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n < 1e12 ? n * 1000 : n : fallback;
};
let sequence = 0;

export const exactDanmakuUid = (value: unknown): string | undefined => {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
  if (typeof value !== 'string' || !/^\d{1,20}$/.test(value)) return undefined;
  return value.replace(/^0+/, '') || undefined;
};
/** Direct Bilibili CDN assets only. This never creates a site proxy request. */
export function danmakuAssetUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\]/.test(value)) return undefined;
  try {
    const url = new URL(value.startsWith('//') ? `https:${value}` : value);
    if (url.username || url.password || url.hash) return undefined;
    if (!['hdslb.com', 'biliimg.com'].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) return undefined;
    // Legacy messages still carry HTTP CDN links. Upgrade only an already
    // validated host and its standard HTTP port; never issue an HTTP request.
    if (url.protocol === 'http:' && !url.port) url.protocol = 'https:';
    if (url.protocol !== 'https:' || (url.port && url.port !== '443')) return undefined;
    return url.href.length <= 2048 ? url.href : undefined;
  } catch { return undefined; }
}
const optionalRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'string') return record(value);
  if (value.length > 65536) return {};
  try { return record(JSON.parse(value)); } catch { return {}; }
};
type IdentityCandidate = { name: unknown; id: unknown; face?: unknown; mystery?: unknown };
function identity(values: IdentityCandidate[]): Pick<DanmakuMessage, 'userName' | 'userId' | 'userIdentity' | 'avatarUrl' | 'isMystery'> {
  const candidates = values.map(value => ({ name: text(value.name, 100), id: exactDanmakuUid(value.id), face: danmakuAssetUrl(value.face), mystery: flag(value.mystery) }));
  const mystery = candidates.some(value => value.mystery === true);
  const selected = (mystery ? undefined : candidates.find(value => value.name && !value.name.includes('*'))) ?? candidates.find(value => value.name) ?? candidates.find(value => value.id);
  // Never turn an explicitly masked identity into a real user using another projection.
  const masked = mystery || Boolean(selected?.name.includes('*') && !selected.id);
  const ids = new Set(candidates.map(value => value.id).filter((id): id is string => Boolean(id)));
  const id = masked ? undefined : selected?.id ?? (ids.size === 1 ? [...ids][0] : undefined);
  const face = masked ? undefined : selected?.face ?? candidates.find(value => id && value.id === id && value.face)?.face;
  return { userName: selected?.name || '匿名用户', userIdentity: masked ? 'masked' : selected?.name ? 'full' : 'unknown',
    ...(id ? { userId: id } : {}), ...(face ? { avatarUrl: face } : {}), ...(mystery ? { isMystery: true } : {}) };
}
const color = (value: unknown): string | undefined => {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffff) return `#${value.toString(16).padStart(6, '0')}`;
  return superChatHexColor(value);
};
function medalFrom(value: unknown, legacy: unknown): DanmakuMedal | undefined {
  const m = record(value), old = Array.isArray(legacy) ? legacy : [];
  const name = text(m.name ?? m.medal_name ?? old[1], 32);
  const level = positive(m.level ?? m.medal_level ?? old[0], 200);
  if (!name || !level) return undefined;
  const roomId = exactDanmakuUid(m.target_roomid ?? m.target_room_id ?? old[3]);
  const uid = exactDanmakuUid(m.ruid ?? m.target_id ?? old[12]);
  return { name, level, ...(roomId ? { targetRoomId: roomId } : {}), ...(uid ? { targetUid: uid } : {}),
    color: color(m.color ?? m.medal_color ?? old[4]), colorBorder: color(m.color_border ?? m.medal_color_border ?? old[6]),
    colorStart: color(m.color_start ?? m.medal_color_start ?? old[7]), colorEnd: color(m.color_end ?? m.medal_color_end ?? old[8]),
    guardLevel: role(m.guard_level ?? old[10]), lighted: flag(m.is_lighted ?? old[11]) };
}
const emoteUnique = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : undefined;
function mergeEmoteSource(primary: unknown, fallback: unknown): Record<string, unknown> {
  const current = record(primary), old = record(fallback);
  const unique = emoteUnique(current.unique ?? current.emoticon_unique);
  const oldUnique = emoteUnique(old.unique ?? old.emoticon_unique);
  // Only combine projections of this message's same emote, never an image
  // belonging to a conflicting identifier or another room's send directory.
  if (unique && oldUnique && unique !== oldUnique) return current;
  return { ...old, ...current,
    url: danmakuAssetUrl(current.url ?? current.emoticon_url) ?? danmakuAssetUrl(old.url ?? old.emoticon_url),
    unique: unique ?? oldUnique,
    is_dynamic: flag(current.is_dynamic ?? current.dynamic) ?? flag(old.is_dynamic ?? old.dynamic),
    width: current.width ?? old.width, height: current.height ?? old.height };
}
function emoteSegment(value: unknown, fallback: string, emoteSize: 'small' | 'large' = 'small'): DanmakuSegment {
  const source = record(value), url = danmakuAssetUrl(source.url ?? source.emoticon_url);
  const unique = emoteUnique(source.unique ?? source.emoticon_unique);
  // A known emote remains an emote even when its image is absent or invalid.
  // Ordinary text must not become a candidate for name-based replacement.
  return { type: 'emote', emoteSize, text: text(source.emoji ?? source.text, 100) || fallback, ...(url ? { url } : {}), ...(unique ? { unique } : {}),
    width: positive(source.width, 512), height: positive(source.height, 512),
    dynamic: flag(source.is_dynamic ?? source.dynamic) ?? /\.(?:gif|apng)(?:\?|$)/i.test(url ?? '') };
}
function segmentsFor(content: string, emotes: unknown, single?: unknown, large = false): DanmakuSegment[] | undefined {
  if (large) return [emoteSegment(single, content || '[表情]', 'large')];
  const entries = Object.entries(record(emotes)).slice(0, 100).filter(([key]) => key && key.length <= 100);
  if (!entries.length) return undefined;
  const parts: DanmakuSegment[] = [];
  let cursor = 0;
  while (cursor < content.length && parts.length < 30) {
    let next: { at: number; key: string; value: unknown } | undefined;
    for (const [key, value] of entries) {
      const at = content.indexOf(key, cursor);
      if (at >= 0 && (!next || at < next.at || (at === next.at && key.length > next.key.length))) next = { at, key, value };
    }
    if (!next) break;
    if (next.at > cursor) parts.push({ type: 'text', text: content.slice(cursor, next.at) });
    parts.push(emoteSegment(next.value, next.key));
    cursor = next.at + next.key.length;
  }
  if (cursor < content.length) parts.push({ type: 'text', text: content.slice(cursor) });
  return parts.some(part => part.type === 'emote') ? parts : undefined;
}
const encoder = new TextEncoder();
function bounded(message: DanmakuMessage): DanmakuMessage {
  // Six escaped JSON bytes per UTF-16 code unit is a conservative upper bound.
  // Ordinary text fits without allocating both a JSON string and a UTF-8 buffer;
  // large rich projections still receive the exact original 16 KiB check.
  if (messageBytes(message) * 3 <= 16 * 1024 || encoder.encode(JSON.stringify(message)).length <= 16 * 1024) return message;
  // Rich data is optional; text remains readable when the upstream projection is large.
  const { segments: _segments, avatarUrl: _avatar, medal: _medal, ...base } = message;
  return base;
}

/** Known JSON and bounded official dm_v2 emote fields; no identity inference. */
export function normalizeDanmaku(roomId: string, value: unknown, now = Date.now()): DanmakuEvent[] {
  const payload = record(value), command = text(payload.cmd, 100).split(':')[0];
  if (command === 'DANMU_MSG') {
    const info = Array.isArray(payload.info) ? payload.info : [], data = record(payload.data);
    const meta = Array.isArray(info[0]) ? info[0] : [], oldUser = Array.isArray(info[2]) ? info[2] : [];
    const extra = record(meta[15]), extended = optionalRecord(extra.extra);
    const v2 = decodeDanmakuV2(payload.dm_v2);
    const sender = record(extra.user ?? data.user ?? data.uinfo), base = record(sender.base);
    const moreUser = record(extended.user), moreBase = record(moreUser.base);
    const dmType = v2?.dmType ?? Number(meta[12] ?? data.dm_type);
    const legacyContent = text(info[1] ?? data.text ?? data.content, 500);
    // The wire key can be an identifier. A friendly description carried by
    // this very message remains useful as its large-emote alternative text.
    const content = dmType === 1 && legacyContent ? legacyContent : text(v2?.content, 500) || legacyContent;
    if (!content) return [];
    const v2Emotes = v2 && Object.keys(v2.emoticons).length ? v2.emoticons : undefined;
    const oldEmotes = record(extended.emots ?? data.emots);
    const emotes = v2Emotes ? Object.fromEntries([
      ...Object.entries(v2Emotes).map(([key, source]) => [key, mergeEmoteSource(source, oldEmotes[key])]),
      ...Object.entries(oldEmotes).slice(0, 100).filter(([key]) => !Object.hasOwn(v2Emotes, key)),
    ]) : oldEmotes;
    const singleV2 = v2Emotes?.[v2?.content || content];
    const single = singleV2 ? mergeEmoteSource(singleV2, meta[13] ?? data.emoticon) : meta[13] ?? data.emoticon;
    const who = identity([{ name: base.name ?? sender.uname, id: sender.uid, face: base.face ?? sender.face, mystery: base.is_mystery ?? sender.is_mystery ?? data.is_mystery },
      { name: oldUser[1], id: oldUser[0], mystery: extended.is_mystery }, { name: moreBase.name, id: moreUser.uid, face: moreBase.face, mystery: moreBase.is_mystery }]);
    const sourceRoomId = exactDanmakuUid(data.source_room_id ?? extra.source_room_id ?? extended.source_room_id ?? oldUser[11]);
    const isMirror = flag(data.is_mirror ?? extra.is_mirror ?? extended.is_mirror);
    const eventId = text(extra.id_str ?? data.id_str, 128) || (typeof meta[5] === 'string' ? meta[5].slice(0, 128) : '');
    const safeRoles = who.userIdentity !== 'masked';
    return [{ type: 'message', message: bounded({ id: eventId ? `dm:${eventId}` : `dm:${now}:${++sequence}`, roomId, kind: 'danmaku', text: content, ...who,
      color: color(meta[3] ?? data.color) ?? '#ffffff', sourceTime: timestamp(meta[4] ?? data.timestamp, now), receivedAt: now,
      sourceRoomId, isMirror, roleRoomId: isMirror && !sourceRoomId ? undefined : sourceRoomId ?? roomId,
      ...(safeRoles ? { isModerator: flag(data.isadmin ?? data.is_admin ?? oldUser[2]), isAnchor: flag(data.is_anchor ?? sender.is_anchor ?? base.is_anchor), guardLevel: role(data.guard_level ?? info[7]), medal: medalFrom(sender.medal ?? extended.medal, info[3]) } : {}),
      segments: segmentsFor(content, emotes, single, dmType === 1),
    }) }];
  }
  if (command === 'SUPER_CHAT_MESSAGE') {
    const data = record(payload.data), content = text(data.message);
    if (!content || !['string', 'number'].includes(typeof data.id)) return [];
    const price = Number(data.price), user = record(data.user_info), sender = record(data.uinfo), base = record(sender.base);
    const who = identity([{ name: base.name, id: sender.uid, face: base.face, mystery: base.is_mystery ?? data.is_mystery }, { name: user.uname, id: data.uid ?? user.uid, face: user.face, mystery: user.is_mystery }]);
    // Paid highlight duration is not a lifetime for the bounded chat history.
    const start = timestamp(data.start_time, now);
    return [{ type: 'message', message: bounded({ id: `sc:${String(data.id).slice(0, 128)}`, roomId, kind: 'sc', text: content, ...who,
      color: '#ffffff', sourceTime: start, receivedAt: now,
      ...(who.userIdentity !== 'masked' ? { roleRoomId: roomId, guardLevel: role(user.guard_level ?? data.guard_level), isModerator: flag(user.is_admin ?? user.isadmin), isAnchor: flag(user.is_anchor ?? sender.is_anchor ?? base.is_anchor), medal: medalFrom(sender.medal ?? data.medal_info, undefined) } : {}),
      ...(Number.isFinite(price) && price >= 0 ? { price } : {}), scColors: resolveSuperChatColors(price, {
        background: superChatHexColor(data.background_color), body: superChatHexColor(data.background_bottom_color), price: superChatHexColor(data.background_price_color) }),
    }) }];
  }
  if (command === 'SUPER_CHAT_MESSAGE_DELETE') {
    const ids = record(payload.data).ids;
    if (!Array.isArray(ids)) return [];
    return [{ type: 'delete-sc', roomId, ids: ids.filter(id => typeof id === 'number' || typeof id === 'string').slice(0, 1000).map(id => `sc:${String(id).slice(0, 128)}`) }];
  }
  return [];
}
