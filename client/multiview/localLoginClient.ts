import { LOCAL_LOGIN_CHANNEL, LOCAL_LOGIN_VERSION, type LocalAccount, type LocalLoginAction, type LocalLoginEvent,
  type LocalLoginHello, type LocalLoginRequest, type LocalLoginError, type LocalLoginSession, type LocalChatApproval, type LocalAudioPlayback } from '../../shared/localLogin';
import { isPlaybackQuality, type PlaybackCapability, type PlaybackInfo, type PlaybackQuality, type PlaybackSource } from '../../shared/playback';
import { LOCAL_LOGIN_EXTENSION_NAME } from '../../shared/extensionBrand';
import { readMedalSelection } from './localMedalClient';
import { isAllowedMonitorPage } from '../../shared/site';

const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[\w.-]{1,128}$/.test(value);
const text = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value);
const validQn = isPlaybackQuality;

export class LocalLoginClientError extends Error {
  constructor(public readonly code: LocalLoginError['code'] | 'NOT_INSTALLED', message: string, public readonly retryAfter?: number) {
    super(message); this.name = 'LocalLoginClientError';
  }
  get status(): number { return this.code === 'RATE_LIMITED' ? 429 : 503; }
}
/** An invalidation event cannot tell whether an already-dispatched POST completed. */
export class LocalLoginSendInterruptedError extends LocalLoginClientError {
  constructor(code: 'ACCOUNT_CHANGED' | 'UNAVAILABLE') {
    super(code, '本机连接或账号状态已变化，发送结果尚未确认');
    this.name = 'LocalLoginSendInterruptedError';
  }
}
const unavailable = () => new LocalLoginClientError('UNAVAILABLE', '浏览器扩展暂时不可用，请重试连接');
const changed = () => new LocalLoginClientError('ACCOUNT_CHANGED', 'B站账号已变化，请刷新账号状态');

export function readChatApproval(value: unknown): LocalChatApproval {
  const item = object(value);
  if (!item || !identifier(item.approvalId) || !['pending', 'approved', 'cancelled', 'expired', 'invalidated'].includes(String(item.status)) ||
    typeof item.expiresAt !== 'number' || !Number.isFinite(item.expiresAt) || item.expiresAt < 0) throw unavailable();
  return { approvalId: item.approvalId, status: item.status as LocalChatApproval['status'], expiresAt: item.expiresAt };
}

/** Persisted intent is not proof of a currently authenticated browser session. */
export function readLocalSession(value: unknown): LocalLoginSession {
  const item = object(value), preferences = object(item?.preferences);
  if (!item || !preferences || preferences.schemaVersion !== 1 || !Number.isSafeInteger(preferences.revision) ||
    Number(preferences.revision) < 0 || typeof preferences.granted !== 'boolean' ||
    typeof preferences.connectionWanted !== 'boolean' || typeof preferences.playbackWanted !== 'boolean' ||
    (preferences.authorizationVersion !== undefined && preferences.authorizationVersion !== 2) ||
    (preferences.expectedUid !== undefined && (typeof preferences.expectedUid !== 'string' || !/^[1-9][0-9]{0,19}$/.test(preferences.expectedUid))) ||
    typeof item.playbackAllowed !== 'boolean' || (item.chatAllowed !== undefined && typeof item.chatAllowed !== 'boolean') ||
    (item.danmakuAllowed !== undefined && typeof item.danmakuAllowed !== 'boolean') ||
    (preferences.chatWanted !== undefined && typeof preferences.chatWanted !== 'boolean') ||
    !['ready', 'not-connected', 'unauthorized', 'logged-out', 'account-changed', 'unverified'].includes(String(item.reason)) ||
    (item.verifiedAt !== undefined && (typeof item.verifiedAt !== 'number' || !Number.isFinite(item.verifiedAt) || item.verifiedAt < 0))) throw unavailable();
  const account = item.account === undefined ? undefined : readLocalAccount(item.account);
  if (item.playbackAllowed && (!preferences.granted || !preferences.connectionWanted || !preferences.playbackWanted ||
    account?.state !== 'logged-in' || account.uid !== preferences.expectedUid || item.reason !== 'ready' || item.verifiedAt === undefined)) throw unavailable();
  if (item.chatAllowed && (!preferences.granted || !preferences.connectionWanted || !preferences.chatWanted ||
    account?.state !== 'logged-in' || account.uid !== preferences.expectedUid || item.reason !== 'ready' || item.verifiedAt === undefined)) throw unavailable();
  if (item.danmakuAllowed && (!preferences.granted || !preferences.connectionWanted || account?.state !== 'logged-in' ||
    account.uid !== preferences.expectedUid || item.reason !== 'ready' || item.verifiedAt === undefined)) throw unavailable();
  return { preferences: { schemaVersion: 1, revision: Number(preferences.revision), granted: preferences.granted,
    connectionWanted: preferences.connectionWanted, playbackWanted: preferences.playbackWanted,
    ...(typeof preferences.chatWanted === 'boolean' ? { chatWanted: preferences.chatWanted } : {}),
    ...(preferences.authorizationVersion === 2 ? { authorizationVersion: 2 as const } : {}),
    ...(typeof preferences.expectedUid === 'string' ? { expectedUid: preferences.expectedUid } : {}) },
    ...(account ? { account } : {}), ...(typeof item.verifiedAt === 'number' ? { verifiedAt: item.verifiedAt } : {}),
    playbackAllowed: item.playbackAllowed, ...(typeof item.chatAllowed === 'boolean' ? { chatAllowed: item.chatAllowed } : {}),
    ...(typeof item.danmakuAllowed === 'boolean' ? { danmakuAllowed: item.danmakuAllowed } : {}),
    reason: item.reason as LocalLoginSession['reason'] };
}

/** Copy only explicitly supported public fields; never retain arbitrary extension payloads. */
export function readLocalAccount(value: unknown): LocalAccount {
  const item = object(value);
  if (!item || !['unauthorized', 'logged-out', 'logged-in'].includes(String(item.state)) || !identifier(item.authEpoch)) throw unavailable();
  if (item.state === 'logged-in') {
    if (typeof item.uid !== 'string' || !/^[1-9][0-9]{0,19}$/.test(item.uid) || !text(item.name, 100)) throw unavailable();
    return { state: 'logged-in', uid: item.uid, name: item.name, authEpoch: item.authEpoch };
  }
  return { state: item.state as 'unauthorized' | 'logged-out', authEpoch: item.authEpoch };
}

function trustedUrl(value: unknown, protocol: unknown): value is string {
  if (typeof value !== 'string' || value.length > 8192 || value !== value.trim() || /[\s\\\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash && (!url.port || url.port === '443') &&
      ['bilivideo.com', 'bilivideo.cn', 'bilivideo.net'].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`)) &&
      (protocol === 'flv' ? /\.flv$/i.test(url.pathname) : /\.m3u8$/i.test(url.pathname));
  } catch { return false; }
}
function readQualities(value: unknown): PlaybackQuality[] {
  if (!Array.isArray(value) || value.length > 32) throw unavailable();
  return value.map(entry => {
    const item = object(entry);
    if (!item || !validQn(item.qn) || !text(item.label, 40)) throw unavailable();
    if (item.detail !== undefined && !text(item.detail, 120)) throw unavailable();
    return { qn: item.qn, label: item.label, ...(typeof item.detail === 'string' ? { detail: item.detail } : {}) };
  });
}
function readCapabilities(value: unknown): PlaybackCapability[] {
  if (!Array.isArray(value) || value.length > 16) throw unavailable();
  return value.map(entry => {
    const item = object(entry);
    if (!item || !['hls', 'flv'].includes(String(item.protocol)) || item.codec !== 'avc' ||
      (item.protocol === 'flv' ? item.format !== 'flv' : !['ts', 'fmp4'].includes(String(item.format)))) throw unavailable();
    return { protocol: item.protocol as PlaybackSource['protocol'], format: item.format as PlaybackSource['format'], codec: 'avc',
      qualities: readQualities(item.qualities) };
  });
}
export function readLocalPlayback(value: unknown, roomId: string, qn: number): PlaybackInfo {
  const item = object(value);
  if (!isPlaybackQuality(qn) || !item || item.roomId !== roomId || item.requestedQuality !== qn || !['live', 'offline', 'restricted'].includes(String(item.status)) ||
    typeof item.resolvedAt !== 'number' || !Number.isFinite(item.resolvedAt) || !Array.isArray(item.sources) || item.sources.length > 24) throw unavailable();
  const qualities = readQualities(item.qualities);
  const sources: PlaybackSource[] = item.sources.map(entry => {
    const source = object(entry);
    if (!source || !identifier(source.id) || !['hls', 'flv'].includes(String(source.protocol)) || !trustedUrl(source.url, source.protocol) ||
      source.codec !== 'avc' || !validQn(source.actualQuality) || (source.protocol === 'flv' ? source.format !== 'flv' : !['ts', 'fmp4'].includes(String(source.format))) ||
      (source.expiresAt !== undefined && (typeof source.expiresAt !== 'number' || !Number.isFinite(source.expiresAt)))) throw unavailable();
    return { id: source.id, url: source.url, protocol: source.protocol as 'hls' | 'flv', format: source.format as PlaybackSource['format'],
      codec: 'avc', actualQuality: source.actualQuality,
      ...(source.qualities === undefined ? {} : { qualities: readQualities(source.qualities) }),
      ...(typeof source.expiresAt === 'number' ? { expiresAt: source.expiresAt } : {}) };
  });
  if (item.status === 'live' ? !sources.length : sources.length > 0) throw unavailable();
  return { roomId, requestedQuality: qn, status: item.status as PlaybackInfo['status'], qualities, sources, resolvedAt: item.resolvedAt,
    ...(item.capabilities === undefined ? {} : { capabilities: readCapabilities(item.capabilities) }),
    ...(text(item.message, 200) ? { message: item.message } : {}) };
}

export function readLocalAudioPlayback(value: unknown, roomId: string): LocalAudioPlayback {
  const item = object(value);
  if (!item || !identifier(item.leaseId)) throw unavailable();
  const playback = readLocalPlayback(item.playback, roomId, 150);
  if (playback.sources.some(source => source.protocol !== 'flv' || source.format !== 'flv')) throw unavailable();
  return { playback, leaseId: item.leaseId };
}

export interface LoginMessageWindow {
  location: { origin: string; pathname: string };
  top: unknown;
  postMessage(message: unknown, targetOrigin: string): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}
type Pending = { action: LocalLoginAction; resolve(value: unknown): void; reject(error: unknown): void; dispose(): void };

export class LocalLoginClient {
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<(event: LocalLoginEvent) => void>();
  private closed = false;
  private sequence = 0;
  private readonly clientId = globalThis.crypto?.randomUUID?.() ?? `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  constructor(private readonly target: LoginMessageWindow, private readonly timeoutMs = 15_000) {
    target.addEventListener('message', this.onMessage);
  }
  private readonly onMessage = (event: MessageEvent) => {
    if (event.source !== this.target || event.origin !== this.target.location.origin) return;
    const data = object(event.data);
    if (!data || data.channel !== LOCAL_LOGIN_CHANNEL) return;
    if (data.direction === 'event') {
      if (data.event === 'medal-changed') {
        const selection = object(data.medalSelection);
        if (!selection || typeof selection.accountUid !== 'string' || !/^[1-9][0-9]{0,19}$/.test(selection.accountUid) || !identifier(selection.authEpoch) ||
          typeof selection.roomId !== 'string' || !/^[1-9][0-9]{0,19}$/.test(selection.roomId)) return;
        try {
          const safeEvent: LocalLoginEvent = { channel: LOCAL_LOGIN_CHANNEL, direction: 'event', event: 'medal-changed',
            medalSelection: readMedalSelection(selection, selection.accountUid, selection.authEpoch, selection.roomId) };
          for (const listener of this.listeners) listener(safeEvent);
        } catch { /* Malformed display notifications cannot invalidate identity. */ }
        return;
      }
      // A newly installed content script only wakes discovery. It never
      // invalidates account work, media leases or an already-dispatched send.
      if (data.event === 'bridge-ready') {
        if (!identifier(data.bridgeId) || !text(data.extensionVersion, 40)) return;
        const safeEvent: LocalLoginEvent = { channel: LOCAL_LOGIN_CHANNEL, direction: 'event', event: 'bridge-ready',
          bridgeId: data.bridgeId, extensionVersion: data.extensionVersion };
        for (const listener of this.listeners) listener(safeEvent);
        return;
      }
      if (data.event !== 'account-changed' && data.event !== 'disconnected' && data.event !== 'session-changed') return;
      if (data.event === 'account-changed' && !identifier(data.authEpoch)) return;
      if (data.event === 'session-changed' && (!Number.isSafeInteger(data.revision) || Number(data.revision) < 0)) return;
      for (const [id, item] of this.pending) {
        // Revocation broadcasts invalidation before acknowledging DISCONNECT.
        // Keep its acknowledgement alive while immediately rejecting personal work.
        if (data.event !== 'disconnected' && ['DISCONNECT', 'GET_SESSION', 'UPDATE_SESSION', 'HELLO', 'GET_AUTHORIZATION', 'CANCEL_AUTHORIZATION', 'RESOLVE_AUDIO_PLAYBACK', 'RELEASE_AUDIO_PLAYBACK', 'RESOLVE_PUBLIC_ROOM', 'RESOLVE_PUBLIC_PLAYBACK'].includes(item.action)) continue;
        if (item.action === 'REQUEST_AUTHORIZATION') this.send('CANCEL', `${id}-invalidated`, { targetId: id });
        this.pending.delete(id); item.dispose();
        item.reject(item.action === 'SEND_DANMAKU'
          ? new LocalLoginSendInterruptedError(data.event === 'disconnected' ? 'UNAVAILABLE' : 'ACCOUNT_CHANGED')
          : data.event === 'disconnected' ? unavailable() : changed());
      }
      const safeEvent: LocalLoginEvent = { channel: LOCAL_LOGIN_CHANNEL, direction: 'event', event: data.event,
        ...(identifier(data.authEpoch) ? { authEpoch: data.authEpoch } : {}),
        ...(Number.isSafeInteger(data.revision) ? { revision: Number(data.revision) } : {}),
        ...(['credentials-changed', 'preferences-changed', 'playback-disabled', 'revoked', 'permission-removed', 'logged-out', 'account-changed'].includes(String(data.reason)) ?
          { reason: data.reason as LocalLoginEvent['reason'] } : {}) };
      for (const listener of this.listeners) listener(safeEvent);
      return;
    }
    if (data.direction !== 'response' || !identifier(data.requestId) || typeof data.ok !== 'boolean') return;
    const item = this.pending.get(data.requestId);
    if (!item) return;
    this.pending.delete(data.requestId); item.dispose();
    if (data.ok) { item.resolve(data.result); return; }
    const error = object(data.error);
    const code = error?.code;
    if (typeof code !== 'string' || !['UNAUTHORIZED', 'LOGGED_OUT', 'ACCOUNT_CHANGED', 'RATE_LIMITED', 'UNAVAILABLE', 'INVALID_REQUEST', 'STATE_CONFLICT'].includes(code)) {
      item.reject(unavailable()); return;
    }
    const messages: Record<string, string> = { UNAUTHORIZED: `请打开 ${LOCAL_LOGIN_EXTENSION_NAME} 浏览器扩展，允许当前网站使用 B站账号`,
      LOGGED_OUT: '请先在同一浏览器登录B站，再刷新账号状态', ACCOUNT_CHANGED: 'B站账号已变化，请刷新账号状态',
      RATE_LIMITED: 'B站暂时限制请求，请稍后重试', UNAVAILABLE: '浏览器扩展或 B站暂时不可用，请稍后重试', INVALID_REQUEST: '本机登录请求无效，请更新浏览器扩展后重试',
      STATE_CONFLICT: '其他页面已更新本机账号设置，正在同步最新选择' };
    const retryAfter = typeof error?.retryAfter === 'number' && Number.isFinite(error.retryAfter) && error.retryAfter > 0 ? Math.min(86400, Math.ceil(error.retryAfter)) : undefined;
    item.reject(new LocalLoginClientError(code as LocalLoginError['code'], messages[code], retryAfter));
  };
  onEvent(listener: (event: LocalLoginEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private send(action: LocalLoginAction, requestId: string, payload?: LocalLoginRequest['payload']) {
    this.target.postMessage({ channel: LOCAL_LOGIN_CHANNEL, direction: 'request', requestId, action,
      ...(payload === undefined ? {} : { payload }) }, this.target.location.origin);
  }
  async request(action: LocalLoginAction, payload?: LocalLoginRequest['payload'], signal?: AbortSignal, timeout = this.timeoutMs): Promise<unknown> {
    if (this.closed || this.target.top !== this.target || !isAllowedMonitorPage(this.target.location.origin + this.target.location.pathname, true)) throw unavailable();
    if (signal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
    if (this.pending.size >= 128) throw unavailable();
    const id = `${this.clientId}-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const abort = () => {
        if (!this.pending.delete(id)) return;
        dispose(); this.send('CANCEL', `${id}-cancel`, { targetId: id });
        reject(new DOMException('Request cancelled', 'AbortError'));
      };
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        dispose(); this.send('CANCEL', `${id}-timeout`, { targetId: id });
        reject(action === 'HELLO' ? new LocalLoginClientError('NOT_INSTALLED', `暂未连接到 ${LOCAL_LOGIN_EXTENSION_NAME}，请确认浏览器扩展已安装并启用`) : unavailable());
      }, timeout);
      const dispose = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      this.pending.set(id, { action, resolve, reject, dispose });
      signal?.addEventListener('abort', abort, { once: true });
      this.send(action, id, payload);
    });
  }
  async hello(signal?: AbortSignal): Promise<LocalLoginHello> {
    const item = object(await this.request('HELLO', undefined, signal, Math.min(this.timeoutMs, 2000)));
    if (!item || item.version !== LOCAL_LOGIN_VERSION || !text(item.extensionVersion, 40) || !identifier(item.runtimeEpoch) ||
      !Array.isArray(item.capabilities) || !item.capabilities.includes('account') || !item.capabilities.includes('playback')) throw unavailable();
    const capabilities = item.capabilities;
    return { version: 1, extensionVersion: item.extensionVersion, runtimeEpoch: item.runtimeEpoch,
      ...(['development', 'normal', 'sideload', 'other', 'unknown'].includes(String(item.installationType))
        ? { installationType: item.installationType as LocalLoginHello['installationType'] } : {}),
      capabilities: ['account', 'playback', ...['public-room', 'public-playback', 'anonymous-danmaku', 'session', 'danmaku', 'chat', 'profile', 'following', 'following-status', 'following-room-info', 'unified-authorization', 'audio-playback', 'medals', 'medal-room-context'].filter(capability => capabilities.includes(capability))] as LocalLoginHello['capabilities'] };
  }
  async session(force = false, signal?: AbortSignal): Promise<LocalLoginSession> {
    return readLocalSession(await this.request('GET_SESSION', { force }, signal));
  }
  async updateSession(payload: { revision: number; connectionWanted?: boolean; playbackWanted?: boolean; chatWanted?: boolean; confirmUid?: string }, signal?: AbortSignal): Promise<LocalLoginSession> {
    return readLocalSession(await this.request('UPDATE_SESSION', payload, signal));
  }
  async account(signal?: AbortSignal): Promise<LocalAccount> { return readLocalAccount(await this.request('GET_ACCOUNT', undefined, signal)); }
  /** The medal adapter validates this projection against its expected account and room. */
  async getRoomFanMedals(roomId: string, authEpoch: string, signal?: AbortSignal): Promise<unknown> {
    if (!/^[1-9][0-9]{0,19}$/.test(roomId) || !identifier(authEpoch)) throw unavailable();
    return this.request('GET_ROOM_FAN_MEDALS', { roomId, authEpoch }, signal);
  }
  async requestAuthorization(signal?: AbortSignal): Promise<LocalChatApproval> {
    return readChatApproval(await this.request('REQUEST_AUTHORIZATION', undefined, signal));
  }
  async authorization(approvalId: string, signal?: AbortSignal): Promise<LocalChatApproval> {
    if (!identifier(approvalId)) throw unavailable();
    const result = readChatApproval(await this.request('GET_AUTHORIZATION', { approvalId }, signal));
    if (result.approvalId !== approvalId) throw unavailable();
    return result;
  }
  async cancelAuthorization(approvalId: string): Promise<void> {
    if (!identifier(approvalId)) return;
    await this.request('CANCEL_AUTHORIZATION', { approvalId });
  }
  async playback(roomId: string, qn: number, force: boolean, authEpoch: string, signal: AbortSignal): Promise<PlaybackInfo> {
    if (!/^[1-9][0-9]{0,19}$/.test(roomId) || !validQn(qn) || !identifier(authEpoch)) throw unavailable();
    return readLocalPlayback(await this.request('RESOLVE_PLAYBACK', { roomId, qn, force, authEpoch }, signal), roomId, qn);
  }
  async publicPlayback(roomId: string, qn: number, force: boolean, signal: AbortSignal): Promise<PlaybackInfo> {
    if (!/^[1-9][0-9]{0,19}$/.test(roomId) || !validQn(qn)) throw unavailable();
    return readLocalPlayback(await this.request('RESOLVE_PUBLIC_PLAYBACK', { roomId, qn, force }, signal), roomId, qn);
  }
  async publicRoom(roomId: string, signal: AbortSignal): Promise<unknown> {
    if (!/^[1-9][0-9]{0,19}$/.test(roomId)) throw unavailable();
    return this.request('RESOLVE_PUBLIC_ROOM', { roomId }, signal);
  }
  async disconnect(revision?: number): Promise<void> { await this.request('DISCONNECT', revision === undefined ? undefined : { revision }); }
  async audioPlayback(roomId: string, force: boolean, signal: AbortSignal): Promise<LocalAudioPlayback> {
    if (!/^[1-9][0-9]{0,19}$/.test(roomId)) throw unavailable();
    const value = await this.request('RESOLVE_AUDIO_PLAYBACK', { roomId, force }, signal);
    try { return readLocalAudioPlayback(value, roomId); }
    catch (error) {
      const lease = object(value)?.leaseId;
      if (identifier(lease)) void this.releaseAudioPlayback(lease).catch(() => undefined);
      throw error;
    }
  }
  async releaseAudioPlayback(leaseId: string): Promise<void> {
    if (!identifier(leaseId)) return;
    await this.request('RELEASE_AUDIO_PLAYBACK', { leaseId }, undefined, 2000);
  }
  destroy(): void {
    this.closed = true; this.target.removeEventListener('message', this.onMessage);
    for (const [id, item] of this.pending) { this.send('CANCEL', `${id}-destroy`, { targetId: id }); item.dispose(); item.reject(new DOMException('Page closed', 'AbortError')); }
    this.pending.clear(); this.listeners.clear();
  }
}
