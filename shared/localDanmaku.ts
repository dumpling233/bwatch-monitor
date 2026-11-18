import type { DanmakuBootstrap } from './danmaku.js';

/** Fixed local RPC projections. No Cookie, CSRF or arbitrary upstream request fields. */
export interface LocalDanmakuBootstrap extends DanmakuBootstrap {
  mode: 'anonymous' | 'authenticated';
  accountUid?: string;
  uid: string;
  authEpoch: string;
}
export interface LocalChatEmoticon {
  unique: string;
  text: string;
  url: string;
  permitted: boolean;
  unlockHint?: string;
  unlockLabel?: string;
  packageName: string;
  packageId?: string;
  kind: 'text' | 'image';
  width?: number;
  height?: number;
  dynamic?: boolean;
}
export interface LocalChatEmoticonPackage {
  id: string;
  name: string;
  type?: number;
  icon: string;
  permitted?: boolean;
  emoticonUniques: string[];
}
export interface LocalChatContext {
  roomId: string;
  accountUid: string;
  authEpoch: string;
  emoticons: LocalChatEmoticon[];
  emoticonPackages?: LocalChatEmoticonPackage[];
  emoticonsAvailable?: boolean;
  emoticonsTruncated?: boolean;
  /** A persisted catalogue is a browsing snapshot, never a current write grant. */
  emoticonPermissionsVerified?: boolean;
  emoticonsCached?: boolean;
  maxLength?: number;
  cooldownSeconds?: number;
  muted?: boolean;
}
export interface LocalPublicProfile {
  uid: string;
  name?: string;
  face?: string;
  /** Original public-avatar lookup time; cache hits do not renew its freshness. */
  avatarFetchedAt?: number;
  /** Scheduling hint only; never evidence of account or room permissions. */
  avatarCacheHit?: boolean;
  level?: number;
  sex?: string;
  sign?: string;
}
export interface LocalDanmakuSendResult {
  status: 'dispatching' | 'submitted' | 'rejected' | 'unknown';
  operationId: string;
  message?: string;
}
