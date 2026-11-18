import type { PlaybackInfo } from './playback.js';
import type { LocalChatContext, LocalDanmakuBootstrap, LocalDanmakuSendResult, LocalPublicProfile } from './localDanmaku.js';
import type { LocalFollowingRoomInfo, LocalFollowingRoomsPage, LocalFollowingStatusBatch } from './localFollowing.js';
import type { LocalMedalPage, LocalMedalRoomContext, LocalMedalSelection } from './localMedals.js';
import type { MonitorRoomDescriptor } from './types.js';

/** No Cookie, arbitrary URL or headers may cross this protocol. */
export const LOCAL_LOGIN_CHANNEL = 'bwatch-monitor.local-login.v1';
export const LOCAL_LOGIN_VERSION = 1;
export type LocalLoginAction = 'HELLO' | 'GET_ACCOUNT' | 'GET_SESSION' | 'UPDATE_SESSION' | 'RESOLVE_PUBLIC_ROOM' | 'RESOLVE_PUBLIC_PLAYBACK' | 'RESOLVE_PLAYBACK' | 'RESOLVE_AUDIO_PLAYBACK' | 'RELEASE_AUDIO_PLAYBACK' | 'RESOLVE_DANMAKU' | 'GET_CHAT_CONTEXT' | 'GET_PUBLIC_PROFILE' | 'GET_FOLLOWING_ROOMS' | 'GET_FOLLOWING_STATUS' | 'GET_FOLLOWING_ROOM_INFO' | 'GET_FAN_MEDALS' | 'GET_ROOM_FAN_MEDALS' | 'SET_FAN_MEDAL' | 'SEND_DANMAKU' | 'GET_DANMAKU_SEND_RESULT' | 'REQUEST_AUTHORIZATION' | 'GET_AUTHORIZATION' | 'CANCEL_AUTHORIZATION' | 'CANCEL' | 'DISCONNECT';
export interface LocalAccount {
  state: 'unauthorized' | 'logged-out' | 'logged-in';
  uid?: string;
  name?: string;
  authEpoch: string;
}
export interface LocalLoginHello {
  version: 1;
  extensionVersion: string;
  runtimeEpoch: string;
  /** Browser-reported installation form; normal does not prove a store channel. */
  installationType?: 'development' | 'normal' | 'sideload' | 'other' | 'unknown';
  capabilities: ['account', 'playback', ...('public-room' | 'public-playback' | 'anonymous-danmaku' | 'session' | 'danmaku' | 'chat' | 'profile' | 'following' | 'following-status' | 'following-room-info' | 'medals' | 'medal-room-context' | 'unified-authorization' | 'audio-playback')[]];
}
/** Anonymous media lease; contains no account credential or reusable header permission. */
export interface LocalAudioPlayback { playback: PlaybackInfo; leaseId: string; }
/** A short-lived confirmation in extension-owned UI; never a reusable write permission. */
export interface LocalChatApproval {
  approvalId: string;
  status: 'pending' | 'approved' | 'cancelled' | 'expired' | 'invalidated';
  expiresAt: number;
}
export type LocalAuthorizationRequest = LocalChatApproval;
/** Intent only. Cookie material, runtime epochs and verified login flags never persist. */
export interface LocalLoginPreferences {
  schemaVersion: 1;
  revision: number;
  granted: boolean;
  connectionWanted: boolean;
  playbackWanted: boolean;
  chatWanted?: boolean;
  expectedUid?: string;
  /** Explicit trusted consent to the complete local account capability set. */
  authorizationVersion?: 2;
}
export type LocalLoginSessionReason = 'ready' | 'not-connected' | 'unauthorized' | 'logged-out' | 'account-changed' | 'unverified';
export interface LocalLoginSession {
  preferences: LocalLoginPreferences;
  account?: LocalAccount;
  verifiedAt?: number;
  playbackAllowed: boolean;
  chatAllowed?: boolean;
  /** Verified login reception is independent of optional sending permission. */
  danmakuAllowed?: boolean;
  reason: LocalLoginSessionReason;
}
export interface LocalLoginSessionUpdate {
  /** Legacy internal migration shape. Unified extensions reject page UPDATE_SESSION. */
  revision: number;
  connectionWanted?: boolean;
  playbackWanted?: boolean;
  /** Kept for old stored formats; current authorization binds all capabilities together. */
  chatWanted?: boolean;
  confirmUid?: string;
}
export interface LocalLoginRequest {
  channel: typeof LOCAL_LOGIN_CHANNEL;
  direction: 'request';
  requestId: string;
  action: LocalLoginAction;
  payload?: { roomId?: string; qn?: number; force?: boolean; authEpoch?: string; targetId?: string; page?: number; uids?: string[];
    mode?: 'anonymous' | 'authenticated'; uid?: string; operationId?: string; text?: string; emoticonUnique?: string; approvalId?: string; leaseId?: string; medalId?: string | null } & Partial<LocalLoginSessionUpdate>;
}
export interface LocalLoginError {
  code: 'UNAUTHORIZED' | 'LOGGED_OUT' | 'ACCOUNT_CHANGED' | 'STATE_CONFLICT' | 'RATE_LIMITED' | 'UNAVAILABLE' | 'INVALID_REQUEST';
  message: string;
  retryAfter?: number;
}
export interface LocalLoginResponse {
  channel: typeof LOCAL_LOGIN_CHANNEL;
  direction: 'response';
  requestId: string;
  ok: boolean;
  result?: LocalLoginHello | LocalAccount | LocalLoginSession | LocalChatApproval | MonitorRoomDescriptor | PlaybackInfo | LocalAudioPlayback | { released: boolean } | LocalDanmakuBootstrap | LocalChatContext | LocalPublicProfile | LocalFollowingRoomsPage | LocalFollowingStatusBatch | LocalFollowingRoomInfo | LocalMedalPage | LocalMedalRoomContext | LocalMedalSelection | LocalDanmakuSendResult | null;
  error?: LocalLoginError;
}
export interface LocalLoginEvent {
  channel: typeof LOCAL_LOGIN_CHANNEL;
  direction: 'event';
  event: 'account-changed' | 'session-changed' | 'disconnected' | 'bridge-ready' | 'medal-changed';
  /** Display state only; never changes authorization, playback or reception identity. */
  medalSelection?: LocalMedalSelection;
  /** Discovery hint only. Version and capabilities must still come from HELLO. */
  bridgeId?: string;
  extensionVersion?: string;
  authEpoch?: string;
  revision?: number;
  reason?: 'credentials-changed' | 'preferences-changed' | 'playback-disabled' | 'revoked' | 'permission-removed' | 'logged-out' | 'account-changed';
}
