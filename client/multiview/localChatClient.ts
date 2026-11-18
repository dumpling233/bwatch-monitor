import type { LocalChatContext, LocalChatEmoticon, LocalDanmakuBootstrap, LocalDanmakuSendResult, LocalPublicProfile } from '../../shared/localDanmaku';
import { LocalLoginClient, LocalLoginClientError, LocalLoginSendInterruptedError } from './localLoginClient';
import { LocalProfileQueue } from './localProfileQueue';

const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const uid = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
const clean = (value: unknown, max = 128): value is string => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const invalid = () => new LocalLoginClientError('UNAVAILABLE', '本机弹幕数据暂不可用');

/** A failed CDN URL is never rewritten to a BWatch proxy. */
export function localChatImage(value: unknown): string | undefined {
  if (!clean(value, 2048) || /[\\\s]/.test(value)) return;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')) return;
    if (url.href.length <= 2048 && ['hdslb.com', 'biliimg.com'].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) return url.href;
  } catch { /* Missing or untrusted media uses a local placeholder. */ }
}

export function readLocalDanmaku(value: unknown, roomId: string, mode: 'anonymous' | 'authenticated', expectedUid?: string, expectedEpoch?: string): LocalDanmakuBootstrap {
  const item = record(value);
  if (!item || item.requestedRoomId !== roomId || !uid(item.roomId) || item.mode !== mode || !clean(item.authEpoch) || !item.authEpoch ||
    !clean(item.token, 4096) || !item.token || !clean(item.buvid, 256) || !item.buvid ||
    typeof item.resolvedAt !== 'number' || !Number.isFinite(item.resolvedAt) || !Array.isArray(item.hosts) || !item.hosts.length || item.hosts.length > 16) throw invalid();
  if (mode === 'authenticated' ? !uid(item.uid) || item.uid !== expectedUid || item.accountUid !== expectedUid : item.uid !== '0' || item.accountUid !== undefined) throw invalid();
  if (mode === 'authenticated' && expectedEpoch !== undefined && item.authEpoch !== expectedEpoch) throw invalid();
  const hosts = item.hosts.map(entry => {
    const host = record(entry);
    if (!host || typeof host.host !== 'string' || !(host.host === 'chat.bilibili.com' || /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.chat\.bilibili\.com$/i.test(host.host)) ||
      !Number.isInteger(host.wssPort) || Number(host.wssPort) < 1 || Number(host.wssPort) > 65535 || typeof host.url !== 'string') throw invalid();
    const url = new URL(host.url);
    if (url.protocol !== 'wss:' || url.hostname !== host.host || Number(url.port || 443) !== host.wssPort || url.pathname !== '/sub' || url.search || url.hash || url.username || url.password) throw invalid();
    return { host: host.host, wssPort: Number(host.wssPort), url: url.href };
  });
  return { requestedRoomId: roomId, roomId: item.roomId, mode, uid: String(item.uid), authEpoch: item.authEpoch,
    ...(mode === 'authenticated' ? { accountUid: expectedUid } : {}), hosts, token: item.token, buvid: item.buvid, resolvedAt: item.resolvedAt };
}

export function readChatContext(value: unknown, accountUid: string, authEpoch: string): LocalChatContext {
  const item = record(value);
  if (!item || !uid(item.roomId) || item.accountUid !== accountUid || item.authEpoch !== authEpoch || !Array.isArray(item.emoticons) || item.emoticons.length > 2048) throw invalid();
  const emoticons: LocalChatEmoticon[] = item.emoticons.map(value => {
    const emote = record(value);
    if (!emote || !clean(emote.unique, 256) || !clean(emote.text, 128) || !clean(emote.packageName, 80) ||
      !['text', 'image'].includes(String(emote.kind)) || typeof emote.permitted !== 'boolean') throw invalid();
    return { unique: emote.unique, text: emote.text, packageName: emote.packageName, kind: emote.kind as 'text' | 'image',
      permitted: emote.permitted, url: localChatImage(emote.url) ?? '',
      ...(clean(emote.unlockHint, 160) ? { unlockHint: emote.unlockHint } : {}),
      ...(clean(emote.unlockLabel, 40) ? { unlockLabel: emote.unlockLabel } : {}),
      ...(clean(emote.packageId, 128) ? { packageId: emote.packageId } : {}),
      ...(typeof emote.dynamic === 'boolean' ? { dynamic: emote.dynamic } : {}),
      ...(Number.isInteger(emote.width) && Number(emote.width) > 0 && Number(emote.width) <= 4096 ? { width: Number(emote.width) } : {}),
      ...(Number.isInteger(emote.height) && Number(emote.height) > 0 && Number(emote.height) <= 4096 ? { height: Number(emote.height) } : {}),
    };
  });
  let emoticonPackages: LocalChatContext['emoticonPackages'];
  if (item.emoticonPackages !== undefined) {
    if (!Array.isArray(item.emoticonPackages) || item.emoticonPackages.length > 64) throw invalid();
    const known = new Set(emoticons.map(emote => emote.unique)), seen = new Set<string>();
    let references = 0;
    emoticonPackages = item.emoticonPackages.map(value => {
      const group = record(value);
      if (!group || !clean(group.id, 128) || !group.id || seen.has(group.id) || !clean(group.name, 80) ||
        !Array.isArray(group.emoticonUniques) || group.emoticonUniques.length > 2048) throw invalid();
      seen.add(group.id);
      references += group.emoticonUniques.length;
      if (references > 4096 || group.emoticonUniques.some(id => !clean(id, 256) || !known.has(id))) throw invalid();
      return { id: group.id, name: group.name, icon: localChatImage(group.icon) ?? '', emoticonUniques: [...new Set(group.emoticonUniques as string[])],
        ...(Number.isInteger(group.type) ? { type: Number(group.type) } : {}),
        ...(typeof group.permitted === 'boolean' ? { permitted: group.permitted } : {}),
      };
    });
  }
  return { roomId: item.roomId, accountUid, authEpoch, emoticons, ...(emoticonPackages ? { emoticonPackages } : {}),
    ...(typeof item.emoticonsAvailable === 'boolean' ? { emoticonsAvailable: item.emoticonsAvailable } : {}),
    ...(typeof item.emoticonsTruncated === 'boolean' ? { emoticonsTruncated: item.emoticonsTruncated } : {}),
    ...(typeof item.emoticonPermissionsVerified === 'boolean' ? { emoticonPermissionsVerified: item.emoticonPermissionsVerified } : {}),
    ...(typeof item.emoticonsCached === 'boolean' ? { emoticonsCached: item.emoticonsCached } : {}),
    ...(typeof item.maxLength === 'number' && Number.isInteger(item.maxLength) && item.maxLength > 0 && item.maxLength <= 500 ? { maxLength: item.maxLength } : {}),
    ...(typeof item.cooldownSeconds === 'number' && Number.isFinite(item.cooldownSeconds) && item.cooldownSeconds >= 0 && item.cooldownSeconds <= 86400 ? { cooldownSeconds: item.cooldownSeconds } : {}),
    ...(typeof item.muted === 'boolean' ? { muted: item.muted } : {}) };
}

export function readChatSendResult(value: unknown, operationId: string): LocalDanmakuSendResult {
  const item = record(value);
  if (!item || item.operationId !== operationId || !['dispatching', 'submitted', 'rejected', 'unknown'].includes(String(item.status))) throw invalid();
  return { operationId, status: item.status as LocalDanmakuSendResult['status'], ...(clean(item.message, 200) ? { message: item.message } : {}) };
}

/** Small local profile cache. Visibility cancellation never cancels another row's shared read. */
export class LocalChatBridge {
  private readonly profiles: LocalProfileQueue;
  constructor(private readonly client: () => LocalLoginClient, now = () => Date.now(), private readonly accountFailure?: (failure: unknown) => void) {
    this.profiles = new LocalProfileQueue(async (id, signal) => {
      const item = record(await this.client().request('GET_PUBLIC_PROFILE', { uid: id }, signal));
      if (!item || item.uid !== id) throw invalid();
      const face = localChatImage(item.face);
      const fetchedAt = typeof item.avatarFetchedAt === 'number' && Number.isFinite(item.avatarFetchedAt) && item.avatarFetchedAt >= 0 && item.avatarFetchedAt <= now()
        ? item.avatarFetchedAt : undefined;
      return face ? { uid: id, face, ...(fetchedAt !== undefined ? { avatarFetchedAt: fetchedAt } : {}),
        ...(item.avatarCacheHit === true ? { avatarCacheHit: true } : {}) } : null;
    }, now);
  }

  invalidate(): void {
    this.profiles.invalidate();
  }
  rememberAvatar(id: string, face: string): void { const safe = localChatImage(face); if (uid(id) && safe) this.profiles.remember(id, safe); }
  rejectAvatar(id: string, face: string): void { this.profiles.forget(id, face); }
  async bootstrap(roomId: string, mode: 'anonymous' | 'authenticated', authEpoch: string | undefined, accountUid: string | undefined, force: boolean, signal: AbortSignal): Promise<LocalDanmakuBootstrap> {
    return readLocalDanmaku(await this.client().request('RESOLVE_DANMAKU', { roomId, mode, force, ...(authEpoch ? { authEpoch } : {}) }, signal), roomId, mode, accountUid, authEpoch);
  }
  async context(roomId: string, accountUid: string, authEpoch: string, signal: AbortSignal, force = false): Promise<LocalChatContext> {
    return readChatContext(await this.client().request('GET_CHAT_CONTEXT', { roomId, authEpoch, ...(force ? { force: true } : {}) }, signal), accountUid, authEpoch);
  }
  async send(roomId: string, authEpoch: string, operationId: string, content: { text?: string; emoticonUnique?: string }, signal?: AbortSignal): Promise<LocalDanmakuSendResult> {
    let result: LocalDanmakuSendResult;
    try {
      result = readChatSendResult(await this.client().request('SEND_DANMAKU', { roomId, authEpoch, operationId, ...content }, signal), operationId);
    } catch (failure) {
      if (failure instanceof LocalLoginClientError && ['UNAUTHORIZED', 'LOGGED_OUT', 'ACCOUNT_CHANGED'].includes(failure.code)) this.accountFailure?.(failure);
      if (failure instanceof LocalLoginClientError && !(failure instanceof LocalLoginSendInterruptedError) &&
        ['UNAUTHORIZED', 'LOGGED_OUT', 'ACCOUNT_CHANGED', 'INVALID_REQUEST', 'RATE_LIMITED'].includes(failure.code))
        return { operationId, status: 'rejected', message: failure.message };
      result = { operationId, status: 'unknown' };
    }
    if (result.status === 'submitted' || result.status === 'rejected') return result;
    // A lost response may hide a definitive ledger result. Read it once as
    // part of this action; never repeat SEND_DANMAKU or its POST.
    if (!signal?.aborted) {
      try {
        const confirmed = await this.result(operationId, signal);
        if (confirmed.status === 'submitted' || confirmed.status === 'rejected') return confirmed;
      } catch { /* Unavailable confirmation does not justify a second write. */ }
    }
    return { operationId, status: 'unknown', message: '暂未确认是否发送成功，请先查看直播间，避免重复发送' };
  }
  async result(operationId: string, signal?: AbortSignal): Promise<LocalDanmakuSendResult> {
    return readChatSendResult(await this.client().request('GET_DANMAKU_SEND_RESULT', { operationId }, signal), operationId);
  }
  async profile(id: string, signal?: AbortSignal): Promise<LocalPublicProfile | null> {
    if (!uid(id) || signal?.aborted || (typeof document !== 'undefined' && document.hidden)) return null;
    return this.profiles.request(id, signal);
  }
}
