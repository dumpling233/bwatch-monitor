import type { LocalChatEmoticon, LocalChatEmoticonPackage } from '../../shared/localDanmaku';

type Json = Record<string, unknown>;
const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const text = (value: unknown, max: number): string => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max) : '';
const integer = (value: unknown, max: number): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : undefined;

// The official directory includes legacy http image URLs. Upgrade only the
// validated Bilibili image CDN; never turn a failed image into a site request.
export const emoticonImage = (value: unknown): string => {
  if (typeof value !== 'string' || value.length > 2048 || /[\\\s\u0000-\u001f\u007f]/.test(value)) return '';
  try {
    const url = new URL(value.replace(/^\/\//, 'https://'));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port || url.hash ||
      !['hdslb.com', 'biliimg.com'].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) return '';
    url.protocol = 'https:'; return url.href.length <= 2048 ? url.href : '';
  } catch { return ''; }
};

/** Official UI uses identity + package scope for the detailed locked dialog.
 * unlock_show_text is only the short label on the image, not a full reason. */
function unlockHint(emote: Json, packageType: number | undefined): string {
  const identity = integer(emote.identity, 4), level = integer(emote.unlock_need_level, 100_000);
  const scope = packageType === 1 ? '任一主播的' : packageType === 2 ? '本直播间主播的' : '';
  if (identity === 4) return level !== undefined && level > 1
    ? `需要${scope}粉丝团等级达到 ${level} 级` : `需要加入${scope}粉丝团`;
  const guard = identity === 1 ? '总督' : identity === 2 ? '提督' : identity === 3 ? '舰长' : '';
  if (guard) return `需要开通${scope}${guard}`;
  return text(emote.unlock_show_text, 160);
}

/** Pure bounded projection. Keep package order and every official package type.
 * Type 3 is the image-backed inline emoji whose descript is inserted as text;
 * other types use emoticon_unique and dm_type=1, subject to an explicit perm. */
export function projectEmoticons(packages: unknown[]): {
  emoticons: LocalChatEmoticon[]; emoticonPackages: LocalChatEmoticonPackage[]; emoticonsTruncated: boolean;
} {
  const emoticons: LocalChatEmoticon[] = [], emoticonPackages: LocalChatEmoticonPackage[] = [];
  const byUnique = new Map<string, LocalChatEmoticon>(), packageIds = new Set<string>();
  const maxItems = 2048, maxPackages = 64, maxReferences = 4096, maxBytes = 1536 * 1024;
  let bytes = 0, references = 0, truncated = packages.length > maxPackages;
  outer: for (const [packageIndex, rawPackage] of packages.slice(0, maxPackages).entries()) {
    const pkg = object(rawPackage), type = integer(pkg.pkg_type, 65535);
    const rawId = typeof pkg.pkg_id === 'number' && Number.isSafeInteger(pkg.pkg_id) ? String(pkg.pkg_id) : text(pkg.pkg_id, 100);
    let packageId = rawId || `package:${type ?? 'unknown'}:${packageIndex}`;
    if (packageIds.has(packageId)) packageId = `${packageId}:${packageIndex}`;
    packageIds.add(packageId);
    const name = text(pkg.pkg_name, 80) || '表情';
    const group: LocalChatEmoticonPackage = { id: packageId, name, icon: emoticonImage(pkg.current_cover) || emoticonImage(pkg.cover),
      ...(type !== undefined ? { type } : {}), emoticonUniques: [] };
    const groupCost = JSON.stringify(group).length * 2;
    if (bytes + groupCost > maxBytes) { truncated = true; break; }
    emoticonPackages.push(group); bytes += groupCost;
    const groupUniques = new Set<string>();
    const values = Array.isArray(pkg.emoticons) ? pkg.emoticons : [];
    if (values.length > maxItems) truncated = true;
    for (const [emoteIndex, value] of values.slice(0, maxItems).entries()) {
      const emote = object(value), kind = type === 3 ? 'text' : 'image';
      const label = text(kind === 'text' ? emote.descript || emote.emoji : emote.emoji || emote.descript || '[表情]', 100);
      const unique = text(emote.emoticon_unique, 200) || (kind === 'text' && label ? `inline:${packageIndex}:${emoteIndex}` : '');
      if (!unique || !label) continue;
      const hint = unlockHint(emote, type), unlockLabel = text(emote.unlock_show_text, 40);
      const width = integer(emote.width, 4096), height = integer(emote.height, 4096);
      const entry: LocalChatEmoticon = { unique, text: label, url: emoticonImage(emote.url),
        // Inserting an inline emoji is an ordinary draft edit. Image sends still
        // require a positive server permission; a label/role cannot grant it.
        permitted: kind === 'text' || emote.perm === 1, packageName: name, packageId, kind,
        ...(hint ? { unlockHint: hint } : {}), ...(unlockLabel ? { unlockLabel } : {}),
        ...(width !== undefined && width > 0 ? { width } : {}), ...(height !== undefined && height > 0 ? { height } : {}),
        ...(emote.is_dynamic === 0 || emote.is_dynamic === 1 ? { dynamic: emote.is_dynamic === 1 } : {}) };
      const existing = byUnique.get(unique);
      // Duplicate directory entries must not turn a locked image into a grant.
      if (existing) {
        existing.permitted = existing.permitted && entry.permitted;
        if (!existing.url && entry.url) {
          const cost = entry.url.length * 2;
          if (bytes + cost > maxBytes) { truncated = true; break outer; }
          bytes += cost; existing.url = entry.url;
        }
        if (!groupUniques.has(unique)) {
          const cost = unique.length * 2 + 8;
          if (references >= maxReferences || bytes + cost > maxBytes) { truncated = true; break outer; }
          bytes += cost; references++; groupUniques.add(unique); group.emoticonUniques.push(unique);
        }
        continue;
      }
      const cost = JSON.stringify(entry).length * 2 + unique.length * 2 + 8;
      if (emoticons.length >= maxItems || references >= maxReferences || bytes + cost > maxBytes) { truncated = true; break outer; }
      bytes += cost; references++; byUnique.set(unique, entry); emoticons.push(entry); groupUniques.add(unique); group.emoticonUniques.push(unique);
    }
  }
  return { emoticons, emoticonPackages, emoticonsTruncated: truncated };
}
