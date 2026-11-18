import type { LocalAccount, LocalLoginEvent, LocalLoginHello, LocalLoginSession } from '../../shared/localLogin';
import { LOCAL_LOGIN_EXTENSION_NAME } from '../../shared/extensionBrand';
import { LocalLoginClient, LocalLoginClientError } from './localLoginClient';
import { resolveLocalPlayback, type LocalPlaybackResolver } from './localLoginProvider';
import { LocalLoginRecovery } from './localLoginRecovery';

export type LoginStatus = 'restoring' | 'active' | 'anonymous-connected' | 'disconnected' | 'recovering' |
  'logged-out' | 'account-changed' | 'unauthorized' | 'not-connected' | 'update-required' | 'authorization-required';
export interface LocalLoginSnapshot {
  account: LocalAccount | null;
  connected: boolean;
  enabled: boolean;
  wanted: boolean;
  busy: boolean;
  initialReady: boolean;
  status: LoginStatus;
  verificationState: 'idle' | 'checking' | 'verified' | 'unavailable';
  lastVerifiedAt: number;
  extensionVersion: string;
  installationType?: LocalLoginHello['installationType'];
  message: string;
  authSessionKey: string;
  resolutionScope: string;
  capabilities?: readonly string[];
  /** One consumable discovery notification, published only after a real HELLO. */
  bridgeReadyId?: string;
  chatEnabled?: boolean;
  chatWanted?: boolean;
  danmakuEnabled?: boolean;
  danmakuWanted?: boolean;
  granted: boolean;
  connectionWanted: boolean;
  authorizationSupported: boolean;
  authorizationCurrent: boolean;
  authorizationPending: boolean;
  authorizationMessage: string;
  revocationState: 'idle' | 'pending' | 'unconfirmed' | 'revoked';
}
type LoginClient = Pick<LocalLoginClient, 'hello' | 'session' | 'playback' | 'disconnect' | 'onEvent'> &
  Partial<Pick<LocalLoginClient, 'requestAuthorization' | 'authorization' | 'cancelAuthorization'>>;
const cancelled = () => new DOMException('本机账号状态已变化', 'AbortError');
const initialSnapshot = (): LocalLoginSnapshot => ({ account: null, connected: false, enabled: false, wanted: false,
  busy: false, initialReady: false, status: 'restoring', verificationState: 'checking', lastVerifiedAt: 0,
  extensionVersion: '', message: '', authSessionKey: 'anonymous', resolutionScope: 'anonymous', granted: false,
  connectionWanted: false, authorizationSupported: false, authorizationCurrent: false,
  authorizationPending: false, authorizationMessage: '', revocationState: 'idle' });

/** The extension owns one UID-bound authorization. This store only verifies and projects it. */
export class LocalLoginController {
  private state = initialSnapshot();
  private readonly listeners = new Set<() => void>();
  private session?: LocalLoginSession;
  private sequence = 0;
  private operation?: { abort: AbortController; promise: Promise<LocalLoginSession | null>; hello?: LocalLoginHello };
  private alive = false;
  private foreground = true;
  private documentSuspended = false;
  private online = true;
  private unsubscribe?: () => void;
  private timer?: ReturnType<typeof setTimeout>;
  private gate?: ReturnType<typeof setTimeout>;
  private requiresVerification = true;
  private mediaEpoch = '';
  private readonly recovery = new LocalLoginRecovery();
  private retryCount = 0;
  private retryAt = 0;
  private lastFailure?: unknown;
  private revisionFloor = 0;
  private disconnecting = false;
  private pendingDisconnect = false;
  private disconnectRevision?: number;
  private localBlocked = false;
  private approval?: { abort: AbortController; approvalId?: string };
  private readonly announcedBridges = new Set<string>();
  private pendingBridgeId?: string;
  private bridgeWake?: Promise<void>;
  private extensionCheck?: { abort: AbortController; promise: Promise<void> };

  constructor(private readonly client: LoginClient, private readonly options: { now?: () => number; gateMs?: number; approvalPollMs?: number } = {}) {}
  private now = () => this.options.now?.() ?? Date.now();
  getSnapshot = (): LocalLoginSnapshot => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private patch(next: Partial<LocalLoginSnapshot>): void {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener();
  }
  private clearTimer(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
  private cancelExtensionCheck(): void {
    this.extensionCheck?.abort.abort(); this.extensionCheck = undefined;
  }
  private schedule(delay: number): void {
    this.clearTimer();
    if (!this.alive || !this.foreground || !this.online || this.state.status === 'update-required') return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.pendingDisconnect) void this.disconnect(); else void this.sync(false);
    }, Math.max(0, delay));
  }
  private ready(): void {
    if (this.gate) clearTimeout(this.gate); this.gate = undefined;
    if (!this.state.initialReady) this.patch({ initialReady: true });
  }
  start(): void {
    if (this.alive) return;
    this.alive = true; this.unsubscribe = this.client.onEvent(this.onEvent);
    this.gate = setTimeout(() => {
      this.gate = undefined;
      if (this.alive) this.patch({ initialReady: true, message: '正在恢复本机账号，暂时使用匿名模式…' });
    }, this.options.gateMs ?? 3000);
    void this.sync(false);
  }
  stop(): void {
    this.cancelPendingApproval(); this.alive = false; this.clearTimer();
    if (this.gate) clearTimeout(this.gate); this.gate = undefined;
    this.unsubscribe?.(); this.unsubscribe = undefined;
    ++this.sequence; this.operation?.abort.abort(); this.operation = undefined; this.recovery.invalidate();
    this.cancelExtensionCheck();
    this.pendingBridgeId = undefined;
  }
  setForeground(value: boolean): void {
    this.foreground = value;
    if (!value) { this.clearTimer(); this.cancelExtensionCheck(); return; }
    if (this.pendingDisconnect) {
      if (this.now() >= this.retryAt) void this.disconnect(); else this.schedule(this.retryAt - this.now());
    } else if (this.pendingBridgeId) {
      this.documentSuspended = false; this.wakeBridge();
    } else if (this.documentSuspended) {
      this.documentSuspended = false; void this.sync(false, this.state.authorizationCurrent);
    } else if (!this.state.authorizationCurrent && (this.requiresVerification || !this.state.connected)) void this.sync(false);
  }
  setOnline(value: boolean): void {
    this.online = value;
    if (!value) {
      this.clearTimer(); this.cancelExtensionCheck();
    } else if (this.foreground) this.setForeground(true);
  }
  leave(): void {
    this.cancelPendingApproval(); this.foreground = false; this.documentSuspended = true; this.clearTimer(); this.requiresVerification = true;
    ++this.sequence; this.operation?.abort.abort(); this.operation = undefined;
    this.cancelExtensionCheck();
    // Page lifecycle owners release the Worker and media work separately.
    // Keep confirmed authority so a failed BFCache resume can recover on use.
    this.recovery.invalidate(); this.patch({ busy: false });
  }
  private stopPersonal(): void {
    this.recovery.invalidate(); this.mediaEpoch = '';
    this.patch({ enabled: false, chatEnabled: false, danmakuEnabled: false, authSessionKey: 'anonymous', resolutionScope: 'anonymous' });
  }
  private wakeBridge(): void {
    if (!this.alive || !this.foreground || !this.online || this.documentSuspended || this.pendingDisconnect ||
      this.disconnecting || !this.pendingBridgeId || this.bridgeWake) return;
    const wake = (async () => {
      // Do not abort or replace an in-flight account read. If its HELLO was
      // posted before installation, make one follow-up read after it settles.
      if (this.operation) await this.operation.promise;
      if (!this.alive || !this.foreground || !this.online || this.documentSuspended || this.pendingDisconnect || this.disconnecting || !this.pendingBridgeId) return;
      // Installation resolves discovery failure; it cannot bypass B站 cooldowns.
      if (this.lastFailure instanceof LocalLoginClientError && this.lastFailure.code === 'NOT_INSTALLED') {
        this.retryAt = 0; this.clearTimer();
      }
      await this.sync(false, true);
    })();
    this.bridgeWake = wake;
    void wake.finally(() => {
      if (this.bridgeWake !== wake) return;
      this.bridgeWake = undefined;
      if (this.pendingBridgeId && this.now() >= this.retryAt) this.wakeBridge();
    });
  }
  private onEvent = (event: LocalLoginEvent): void => {
    if (!this.alive) return;
    if (event.event === 'medal-changed') return;
    if (event.event === 'bridge-ready') {
      if (!event.bridgeId || this.announcedBridges.has(event.bridgeId)) return;
      this.announcedBridges.add(event.bridgeId);
      if (this.announcedBridges.size > 16) this.announcedBridges.delete(this.announcedBridges.values().next().value!);
      this.pendingBridgeId = event.bridgeId; this.wakeBridge(); return;
    }
    if (event.event === 'session-changed' && this.session && event.revision! <= this.session.preferences.revision) return;
    this.cancelExtensionCheck();
    if (event.revision !== undefined) this.revisionFloor = Math.max(this.revisionFloor, event.revision);
    if (event.reason === 'preferences-changed' && !this.pendingDisconnect) this.localBlocked = false;
    if (event.event === 'disconnected') {
      this.cancelPendingApproval();
      if (this.pendingDisconnect || ['unauthorized', 'account-changed', 'logged-out'].includes(this.state.status)) return;
      this.requiresVerification = true;
      // MV3 may sleep while the CDN and WSS connections remain healthy.
      // Wake it on the next business request, without a reconnect timer.
      if (this.state.authorizationCurrent) return;
      this.patch({ connected: false, chatEnabled: false, danmakuEnabled: false, verificationState: 'unavailable', status: 'recovering',
        message: '本机连接恢复中，现有播放继续；恢复后会重新验证账号。' });
      this.schedule(5000); return;
    }
    this.requiresVerification = true;
    if (['revoked', 'playback-disabled', 'logged-out', 'account-changed', 'permission-removed'].includes(event.reason ?? '')) {
      this.cancelPendingApproval(); this.stopPersonal();
      this.patch({ wanted: false, chatWanted: false, danmakuWanted: false, authorizationCurrent: false, authorizationMessage: '', account: null });
      if (event.reason === 'revoked' || event.reason === 'permission-removed') this.patch({ granted: false, status: 'unauthorized',
        ...(!this.pendingDisconnect ? { revocationState: 'revoked' as const } : {}) });
      else if (event.reason === 'logged-out' || event.reason === 'account-changed') this.patch({ status: event.reason });
    }
    if (event.reason === 'credentials-changed') this.cancelPendingApproval();
    if (this.disconnecting) return;
    ++this.sequence; this.operation?.abort.abort(); this.operation = undefined;
    // The extension coalesces genuine Cookie changes. Synchronize once, quietly;
    // an inability to read NAV does not invalidate an established same-UID WSS.
    void this.sync(false, this.state.authorizationCurrent);
  };
  private adopt(next: LocalLoginSession): void {
    if (next.preferences.revision < this.revisionFloor || (this.session && next.preferences.revision < this.session.preferences.revision)) {
      this.requiresVerification = true; this.schedule(1000); return;
    }
    const previous = this.state.account, account = next.account ?? null, pref = next.preferences;
    if (next.reason === 'unverified' && this.state.authorizationCurrent && pref.authorizationVersion === 2 && pref.granted &&
      pref.connectionWanted && pref.playbackWanted && pref.chatWanted && previous?.uid === pref.expectedUid) {
      this.failed(new LocalLoginClientError('UNAVAILABLE', '账号暂时无法复核，现有播放与弹幕继续；下次使用时自动重试。'));
      return;
    }
    const current = !this.localBlocked && pref.authorizationVersion === 2 && pref.granted && pref.connectionWanted &&
      pref.playbackWanted && pref.chatWanted === true && account?.state === 'logged-in' && account.uid === pref.expectedUid;
    const enabled = current && next.playbackAllowed;
    const sameUid = previous?.state === 'logged-in' && account?.state === 'logged-in' && previous.uid === account.uid;
    if (!enabled || !sameUid) this.recovery.invalidate();
    if (enabled && (!sameUid || !this.mediaEpoch)) this.mediaEpoch = account.authEpoch;
    if (!enabled) this.mediaEpoch = '';
    this.session = next; this.requiresVerification = next.reason === 'unverified';
    this.retryCount = 0; this.retryAt = 0; this.lastFailure = undefined;
    const status: LoginStatus = next.reason === 'ready' ? current ? 'active' : pref.granted ? 'authorization-required' : 'unauthorized' :
      next.reason === 'unverified' ? 'recovering' : next.reason;
    const message = next.reason === 'account-changed' ? 'B站账号已变化，旧账号授权已失效。请为当前账号重新授权。' :
      next.reason === 'logged-out' ? 'B站已退出登录，账号授权已失效。当前使用匿名模式。' :
      next.reason === 'unverified' ? '正在验证本机账号，暂时使用匿名模式。' : '';
    this.patch({ account, connected: true, enabled, wanted: current, chatWanted: current, danmakuWanted: current,
      granted: pref.granted, connectionWanted: pref.connectionWanted, authorizationCurrent: current,
      chatEnabled: current && next.chatAllowed === true, danmakuEnabled: current && next.danmakuAllowed === true,
      verificationState: next.verifiedAt !== undefined ? 'verified' : 'idle', lastVerifiedAt: next.verifiedAt ?? 0,
      status, message, ...(pref.granted ? { revocationState: 'idle' as const } : {}),
      authSessionKey: enabled ? 'extension:' + this.mediaEpoch : 'anonymous', resolutionScope: enabled ? 'extension:' + account!.authEpoch : 'anonymous' });
    this.ready();
    this.clearTimer();
    if (pref.connectionWanted && this.requiresVerification && !current) this.schedule(5000);
  }
  private failed(failure: unknown): void {
    this.lastFailure = failure; this.requiresVerification = true;
    const known = failure instanceof LocalLoginClientError;
    const seconds = known && failure.retryAfter ? failure.retryAfter : Math.min(300, 5 * 2 ** Math.min(6, this.retryCount++));
    this.retryAt = this.now() + seconds * 1000;
    const retained = this.state.authorizationCurrent;
    this.patch({ verificationState: 'unavailable',
      ...(!retained ? { chatEnabled: false, danmakuEnabled: false } : {}),
      connected: !retained && known && failure.code === 'NOT_INSTALLED' ? false : this.state.connected,
      status: this.state.authorizationCurrent ? 'recovering' : 'disconnected', message: known ? failure.message : '本机账号暂时无法验证，稍后会自动重试。' });
    this.ready();
    // Initial discovery still recovers automatically. A confirmed account has
    // no verification polling: the next actual operation retries after cooldown.
    if (!retained) this.schedule(seconds * 1000);
  }
  private sync(force: boolean, quiet = false): Promise<LocalLoginSession | null> {
    if (!this.alive || !this.online || this.pendingDisconnect || this.disconnecting) return Promise.resolve(null);
    if (this.operation) return this.operation.promise;
    if (this.now() < this.retryAt) { if (!this.state.authorizationCurrent) this.schedule(this.retryAt - this.now()); return Promise.resolve(null); }
    const bridgeReadyId = this.pendingBridgeId; this.pendingBridgeId = undefined;
    const id = ++this.sequence, abort = new AbortController();
    if (!quiet) this.patch({ busy: true, verificationState: 'checking' });
    const promise = (async () => {
      try {
        const hello = await this.client.hello(abort.signal);
        if (!this.alive || id !== this.sequence) return null;
        if (this.operation?.abort === abort) this.operation.hello = hello;
        const supported = hello.capabilities.includes('unified-authorization');
        this.patch({ connected: true, extensionVersion: hello.extensionVersion, capabilities: hello.capabilities, installationType: hello.installationType ?? 'unknown', authorizationSupported: supported,
          ...(bridgeReadyId ? { bridgeReadyId } : {}) });
        if (!hello.capabilities.includes('session') || !supported) {
          this.stopPersonal(); this.patch({ wanted: false, chatWanted: false, danmakuWanted: false, authorizationCurrent: false,
            status: 'update-required', verificationState: 'idle', message: `请更新并重新加载 ${LOCAL_LOGIN_EXTENSION_NAME} 浏览器扩展，再连接账号。` });
          this.ready(); return null;
        }
        const next = await this.client.session(force, abort.signal);
        if (!this.alive || id !== this.sequence || abort.signal.aborted) return null;
        this.adopt(next); return next;
      } catch (failure) {
        if (this.alive && id === this.sequence && !abort.signal.aborted) this.failed(failure);
        return null;
      } finally {
        if (id === this.sequence) { this.operation = undefined; if (this.alive) this.patch({ busy: false }); }
      }
    })();
    this.operation = { abort, promise }; return promise;
  }
  /** A retained account after a failed check is not proof that this check succeeded. */
  refresh = async (): Promise<boolean> => {
    const next = await this.sync(true);
    return Boolean(next?.reason === 'ready' && this.session === next && !this.requiresVerification &&
      this.state.authorizationCurrent && next.account?.state === 'logged-in' &&
      next.account.uid === this.state.account?.uid);
  };
  /** Update discovery is read-only: never force NAV, change authority, or cancel business work. */
  checkExtension = (): Promise<void> => {
    if (!this.alive || !this.online || this.documentSuspended || !this.foreground) return Promise.reject(new Error('暂时无法检查浏览器扩展，请稍后重试'));
    if (this.extensionCheck) return this.extensionCheck.promise;
    const abort = new AbortController(), sequence = this.sequence;
    const promise = (async () => {
      // Reuse an ongoing full handshake rather than adding a competing HELLO.
      const ongoing = this.operation;
      if (ongoing) {
        await ongoing.promise;
        if (abort.signal.aborted || !this.alive || sequence !== this.sequence) throw cancelled();
        if (ongoing.hello) return;
      }
      const hello = await this.client.hello(abort.signal);
      if (abort.signal.aborted || !this.alive || sequence !== this.sequence) throw cancelled();
      const supported = hello.capabilities.includes('session') && hello.capabilities.includes('unified-authorization');
      this.patch({ connected: true, extensionVersion: hello.extensionVersion, capabilities: hello.capabilities,
        installationType: hello.installationType ?? 'unknown', authorizationSupported: supported,
        ...(this.state.status === 'update-required' && supported ? { status: 'not-connected' as const, message: '' } : {}) });
    })().finally(() => { if (this.extensionCheck?.abort === abort) this.extensionCheck = undefined; });
    this.extensionCheck = { abort, promise }; return promise;
  };
  private cancelPendingApproval(): void {
    const pending = this.approval; this.approval = undefined; pending?.abort.abort();
    if (pending?.approvalId) void this.client.cancelAuthorization?.(pending.approvalId).catch(() => {});
    if (pending) this.patch({ authorizationPending: false, authorizationMessage: '本次授权未完成。' });
  }
  cancelAuthorization = async (): Promise<void> => {
    this.cancelPendingApproval();
    // If confirmation won a race with cancellation, authoritative consent must still be shown.
    this.retryAt = 0; await this.sync(false);
  };
  authorize = async (): Promise<void> => {
    if (!this.alive || this.state.authorizationPending || this.pendingDisconnect) return;
    if (!this.state.authorizationSupported || !this.client.requestAuthorization || !this.client.authorization) {
      this.patch({ authorizationMessage: `请先安装或更新 ${LOCAL_LOGIN_EXTENSION_NAME} 浏览器扩展，再连接账号。` }); return;
    }
    if (!this.online) { this.patch({ authorizationMessage: '网络恢复后即可连接账号。' }); return; }
    const pending = { abort: new AbortController(), approvalId: undefined as string | undefined };
    this.approval = pending;
    this.patch({ authorizationPending: true, revocationState: 'idle', authorizationMessage: '请在 BWatch 确认窗口中允许连接账号。' });
    try {
      let result = await this.client.requestAuthorization(pending.abort.signal);
      pending.approvalId = result.approvalId;
      while (result.status === 'pending') {
        await new Promise<void>((resolve, reject) => {
          const stop = () => { clearTimeout(timer); reject(cancelled()); };
          const timer = setTimeout(() => { pending.abort.signal.removeEventListener('abort', stop); resolve(); }, this.options.approvalPollMs ?? 1000);
          if (pending.abort.signal.aborted) stop(); else pending.abort.signal.addEventListener('abort', stop, { once: true });
        });
        if (this.approval !== pending || !this.alive) throw cancelled();
        result = await this.client.authorization(result.approvalId, pending.abort.signal);
      }
      if (this.approval !== pending || !this.alive) return;
      if (result.status === 'approved') {
        this.localBlocked = false; this.retryAt = 0;
        ++this.sequence; this.operation?.abort.abort(); this.operation = undefined;
        await this.sync(false);
        if (this.approval === pending) this.patch({ authorizationMessage: this.state.authorizationCurrent ? '已连接，全部登录功能已自动启用。' : '授权已确认，正在恢复账号连接…' });
      } else this.patch({ authorizationMessage: result.status === 'cancelled' ? '已取消，本次授权未生效。' :
        result.status === 'expired' ? '确认已过期，请重新连接账号。' : '账号或页面状态已变化，请重新确认授权。' });
    } catch (failure) {
      if (this.approval === pending && this.alive) this.patch({ authorizationMessage: failure instanceof LocalLoginClientError ? failure.message : '本次授权未完成，请重试。' });
    } finally {
      if (this.approval === pending) { this.approval = undefined; this.patch({ authorizationPending: false }); }
    }
  };
  disconnect = async (): Promise<void> => {
    if (!this.alive || this.disconnecting) return;
    this.cancelExtensionCheck();
    this.cancelPendingApproval(); this.disconnecting = true; this.localBlocked = true;
    if (!this.pendingDisconnect) this.disconnectRevision = this.session?.preferences.revision;
    this.pendingDisconnect = true;
    ++this.sequence; this.operation?.abort.abort(); this.operation = undefined;
    this.clearTimer(); this.stopPersonal(); this.requiresVerification = true;
    this.patch({ wanted: false, chatWanted: false, danmakuWanted: false, authorizationCurrent: false, account: null,
      busy: true, revocationState: 'pending', status: 'unauthorized', authorizationMessage: '', message: '正在撤销本站授权…' });
    const id = this.sequence;
    try {
      await this.client.disconnect(this.disconnectRevision);
      if (!this.alive || id !== this.sequence) return;
      this.session = undefined; this.retryAt = 0; this.pendingDisconnect = false;
      this.patch({ connected: true, granted: false, connectionWanted: false, revocationState: 'revoked', verificationState: 'idle', lastVerifiedAt: 0,
        message: '已撤销本站授权，B站自身登录状态保持不变。' });
    } catch (failure) {
      if (this.alive && id === this.sequence) {
        if (failure instanceof LocalLoginClientError && failure.code === 'STATE_CONFLICT') {
          this.pendingDisconnect = false; this.retryAt = 0; this.localBlocked = false;
          this.patch({ revocationState: 'idle', message: '其他页面已更新授权，正在同步最新状态。' });
        } else {
          this.retryAt = this.now() + 5000;
          this.patch({ connected: false, revocationState: 'unconfirmed', verificationState: 'unavailable',
            message: '本页已停用，撤销尚未确认。将自动重试，也可在扩展中撤销本站授权。' });
          if (this.disconnectRevision === undefined) this.pendingDisconnect = false; else this.schedule(5000);
        }
      }
    } finally {
      this.disconnecting = false;
      if (this.alive && id === this.sequence) {
        this.patch({ busy: false });
        if (!this.pendingDisconnect && this.state.revocationState === 'idle') void this.sync(false);
      }
    }
  };
  /** An explicit write first wakes MV3 and obtains its current epoch, without replaying the write. */
  prepareAccount = async (signal: AbortSignal): Promise<NonNullable<LocalLoginSnapshot['account']>> => {
    if (!this.online) throw new LocalLoginClientError('UNAVAILABLE', '网络已断开，尚未发送');
    const previous = this.state.account, media = this.mediaEpoch;
    const current = () => this.alive && this.state.authorizationCurrent && this.state.chatWanted &&
      this.mediaEpoch === media && this.state.account?.state === 'logged-in' && this.state.account.uid === previous?.uid;
    if (signal.aborted || !current() || !media || !previous?.uid) throw cancelled();
    // A cached GET_SESSION is local work in a healthy worker. Only a cold or
    // invalidated worker needs NAV; this is user-driven, never a polling timer.
    let next = await this.sync(false, true);
    // A coalesced credential event can replace the shared read while it runs.
    // Follow that one replacement before a POST exists; never replay a write.
    if (!next && !signal.aborted && current() && this.operation) next = await this.operation.promise;
    if (signal.aborted || !current()) throw cancelled();
    if (!next || this.requiresVerification) throw this.lastFailure ?? new LocalLoginClientError('UNAVAILABLE', '暂时无法发送，请稍后重试');
    if (!this.state.connected || !this.state.chatEnabled || this.state.account?.state !== 'logged-in')
      throw new LocalLoginClientError('UNAUTHORIZED', '账号授权已停止，尚未发送');
    return this.state.account;
  };
  readAccount = async <T>(signal: AbortSignal, run: (account: NonNullable<LocalLoginSnapshot['account']>) => Promise<T>): Promise<T> => {
    if (!this.online) throw new LocalLoginClientError('UNAVAILABLE', '网络已断开，恢复后可继续使用账号功能');
    let account = this.state.account;
    if (!this.alive || !this.state.enabled || !this.state.wanted || account?.state !== 'logged-in') throw cancelled();
    const uid = account.uid, media = this.mediaEpoch;
    if (this.requiresVerification) {
      const next = await this.sync(false, true);
      if (!next) throw this.lastFailure ?? new LocalLoginClientError('UNAVAILABLE', '本机账号正在恢复，请稍后重试');
      account = this.state.account;
      if (!this.state.enabled || account?.state !== 'logged-in' || account.uid !== uid || this.mediaEpoch !== media) throw cancelled();
    }
    return this.recovery.run({
      scope: media, account, signal, currentAccount: () => this.state.account,
      active: () => this.alive && this.state.enabled && this.state.authorizationCurrent && this.mediaEpoch === media && this.state.account?.uid === uid,
      recoverable: failure => failure instanceof LocalLoginClientError && ['ACCOUNT_CHANGED', 'UNAVAILABLE', 'LOGGED_OUT', 'UNAUTHORIZED'].includes(failure.code),
      verify: async () => {
        this.requiresVerification = true;
        const next = await this.sync(false, true);
        if (!next) throw this.lastFailure ?? new LocalLoginClientError('UNAVAILABLE', '本机账号暂时无法验证');
        if (!this.state.enabled || !next.account) throw new LocalLoginClientError(next.reason === 'unauthorized' ? 'UNAUTHORIZED' :
          next.reason === 'logged-out' ? 'LOGGED_OUT' : 'ACCOUNT_CHANGED', '本机账号授权已停止');
        return next.account;
      }, adopt: () => {},
      resolve: epoch => run({ ...this.state.account!, authEpoch: epoch })
    });
  };
  accountFailed = async (failure: unknown): Promise<void> => {
    if (!this.alive || !this.state.authorizationCurrent || !(failure instanceof LocalLoginClientError) ||
      !['ACCOUNT_CHANGED', 'LOGGED_OUT', 'UNAUTHORIZED'].includes(failure.code)) return;
    this.requiresVerification = true;
    await this.sync(false, true);
  };
  resolvePlayback: LocalPlaybackResolver = request => this.readAccount(request.signal, account =>
    resolveLocalPlayback(this.client, request, account.authEpoch,
      () => this.state.enabled && !this.requiresVerification ? this.state.account?.authEpoch : undefined));
}
