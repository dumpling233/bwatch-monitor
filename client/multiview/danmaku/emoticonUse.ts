import type { LocalChatContext, LocalChatEmoticon } from '../../../shared/localDanmaku';

const indexes = new WeakMap<LocalChatEmoticon[], ReadonlyMap<string, LocalChatEmoticon>>();

/** Exact business identifiers only; never match a message by its title, image, or sender. */
export function chatEmoticonsByUnique(context: LocalChatContext): ReadonlyMap<string, LocalChatEmoticon> {
  let index = indexes.get(context.emoticons);
  if (!index) {
    const entries = new Map<string, LocalChatEmoticon>();
    // Match the extension's first exact entry if a legacy helper returns duplicates.
    for (const item of context.emoticons) if (!entries.has(item.unique)) entries.set(item.unique, item);
    index = entries; indexes.set(context.emoticons, index);
  }
  return index;
}

/**
 * Shared picker/repeat eligibility for starting one user-requested operation.
 * A cached permitted entry may be attempted, but is never a verified write grant:
 * the extension re-reads the current account/room catalogue before every image POST.
 */
export function emoticonUseRestriction(context: LocalChatContext | null, unique: string, kind?: LocalChatEmoticon['kind']): string | undefined {
  if (!context) return '暂时无法发送，请稍后重试';
  if (context.muted) return '当前直播间暂时无法发言';
  if (context.emoticonsAvailable === false) return '表情暂时无法获取，请稍后重试';
  const item = chatEmoticonsByUnique(context).get(unique);
  if (!item || kind && item.kind !== kind) return '暂无法确认这条表情的使用权限';
  if (item.permitted !== true) return item.unlockHint || item.unlockLabel || '尚未解锁这条表情';
  if (item.kind === 'image' && (!unique || unique.length > 200 || /[\s\u0000-\u001f\u007f]/.test(unique))) return '这条表情缺少可靠的发送标识';
  return undefined;
}
