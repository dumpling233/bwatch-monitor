import type { LocalChatContext } from '../../../shared/localDanmaku';
import type { DanmakuMessage } from './types';
import { emoticonUseRestriction } from './emoticonUse';

export type DanmakuRepeatContent = { text: string; emoticonUnique?: never } | { text?: never; emoticonUnique: string };
export interface DanmakuRepeatState {
  roomId: string | null;
  accountUid?: string;
  authEpoch?: string;
  sessionScope?: string;
  ready: boolean;
  context: LocalChatContext | null;
}
export type DanmakuRepeatSender = (content: DanmakuRepeatContent, roomId: string) => boolean;

/** Large emotes are a distinct upstream send operation; never reconstruct one from a name or image URL. */
export function repeatMessageContent(message: DanmakuMessage): { content?: DanmakuRepeatContent; reason?: string } {
  if (message.kind !== 'danmaku') return { reason: 'SC 不支持复读' };
  const images = message.segments?.filter(part => part.type === 'emote' && part.emoteSize !== 'small') ?? [];
  if (images.length) {
    const image = images[0];
    if (message.segments?.length !== 1 || images.length !== 1 || image.emoteSize !== 'large' ||
      !image.unique || image.unique.length > 200 || /[\s\u0000-\u001f\u007f]/.test(image.unique)) {
      return { reason: '这条表情缺少可靠的发送标识' };
    }
    return { content: { emoticonUnique: image.unique } };
  }
  if (!message.text.trim()) return { reason: '这条弹幕没有可发送的内容' };
  return { content: { text: message.text } };
}

/** This is only a UI decision. The extension independently checks the current send permission. */
export function repeatContentRestriction(content: DanmakuRepeatContent, context: LocalChatContext | null): string | undefined {
  if (!context) return '暂时无法发送，请稍后重试';
  if (context.muted) return '当前直播间暂时无法发言';
  if (content.emoticonUnique) {
    return emoticonUseRestriction(context, content.emoticonUnique, 'image');
  } else if (Array.from(content.text ?? '').length > (context.maxLength ?? 500)) return '这条弹幕超过当前可发送字数';
  return undefined;
}
