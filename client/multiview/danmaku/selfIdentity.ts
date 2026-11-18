import type { DanmakuMessage } from './types';

type MessageIdentity = Pick<DanmakuMessage, 'userId' | 'userIdentity' | 'isMystery'>;

/** Only canonical, positive UIDs from the normalized message are trustworthy. */
export function reliableDanmakuUid(message: MessageIdentity): string | undefined {
  if (message.userIdentity === 'masked' || message.isMystery === true) return;
  return typeof message.userId === 'string' && /^[1-9]\d{0,19}$/.test(message.userId) ? message.userId : undefined;
}

export function isOwnDanmaku(message: MessageIdentity, verifiedUid?: string): boolean {
  return Boolean(verifiedUid && reliableDanmakuUid(message) === verifiedUid);
}
