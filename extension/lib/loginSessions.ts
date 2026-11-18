import type { LocalAccount, LocalLoginPreferences, LocalLoginSession, LocalLoginSessionReason, LocalLoginSessionUpdate } from '../../shared/localLogin';
import type { PlaybackInfo } from '../../shared/playback';
import { AccountVerificationRequired, BrokerError, LocalLoginBroker } from './broker';

export const LOGIN_PREFERENCES_KEY = 'bwatchMonitorLoginPreferences';
type Storage = { get(keys: string[]): Promise<Record<string, unknown>>; set(values: Record<string, unknown>): Promise<void> };
type ChangeReason = 'preferences-changed' | 'playback-disabled' | 'revoked' | 'permission-removed' | 'logged-out' | 'account-changed';
interface Options {
  storage: Storage;
  broker: LocalLoginBroker;
  allowedOrigin(origin: string): boolean;
  onChange?(origin: string, revision: number, reason: ChangeReason): void;
  now?: () => number;
}
const uid = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const fresh = (): LocalLoginPreferences => ({ schemaVersion: 1, revision: 0, granted: false, connectionWanted: false, playbackWanted: false, chatWanted: false });
const conflict = () => new BrokerError('STATE_CONFLICT', '本机账号设置已在其他页面更新，请同步后重试');
const unavailable = () => new BrokerError('UNAVAILABLE', '本机设置保存失败，已停止个人取流，请重试');
const cancelled = () => new DOMException('请求已取消', 'AbortError');

/** Authoritative per-origin intent, with runtime-only evidence and serialized CAS writes. */
export class LoginSessions {
  private readonly preferences = new Map<string, LocalLoginPreferences>();
  private readonly verified = new Map<string, { account: LocalAccount; verifiedAt: number }>();
  private readonly blocked = new Set<string>();
  private readonly generations = new Map<string, number>();
  private serial: Promise<unknown> = Promise.resolve();
  private settling?: Promise<void>;
  private settleTimer?: ReturnType<typeof setTimeout>;
  private finishSettling?: () => void;
  readonly ready: Promise<void>;
  constructor(private readonly options: Options) { this.ready = this.restore(); }
  private get now(): number { return (this.options.now ?? Date.now)(); }
  private async restore(): Promise<void> {
    const stored = await this.options.storage.get([LOGIN_PREFERENCES_KEY, 'bwatchMonitorAuthorizedOrigins']);
    const root = record(stored[LOGIN_PREFERENCES_KEY]);
    if (root.schemaVersion === 1) {
      for (const [origin, value] of Object.entries(record(root.origins))) {
        const item = record(value);
        if (!this.options.allowedOrigin(origin) || item.schemaVersion !== 1 || !Number.isSafeInteger(item.revision) || Number(item.revision) < 0 ||
          typeof item.granted !== 'boolean' || typeof item.connectionWanted !== 'boolean' || typeof item.playbackWanted !== 'boolean' ||
          (item.expectedUid !== undefined && !uid(item.expectedUid))) continue;
        const granted = item.granted;
        const connectionWanted = granted && item.connectionWanted;
        this.preferences.set(origin, { schemaVersion: 1, revision: Number(item.revision), granted, connectionWanted,
          ...(item.authorizationVersion === 2 ? { authorizationVersion: 2 as const } : {}),
          playbackWanted: connectionWanted && item.playbackWanted && uid(item.expectedUid),
          chatWanted: connectionWanted && item.chatWanted === true && uid(item.expectedUid),
          ...(granted && uid(item.expectedUid) ? { expectedUid: item.expectedUid } : {}) });
      }
    } else if (stored[LOGIN_PREFERENCES_KEY] === undefined && Array.isArray(stored.bwatchMonitorAuthorizedOrigins)) {
      // An old website grant never proves that automatic connection or playback was chosen.
      for (const origin of stored.bwatchMonitorAuthorizedOrigins) if (typeof origin === 'string' && this.options.allowedOrigin(origin))
        this.preferences.set(origin, { ...fresh(), revision: 1, granted: true });
      await this.persist();
    }
    for (const [origin, item] of this.preferences) if (item.granted) this.options.broker.authorize(origin, true, false);
  }
  private persist(): Promise<void> {
    return this.options.storage.set({ [LOGIN_PREFERENCES_KEY]: { schemaVersion: 1, origins: Object.fromEntries(this.preferences) }, bwatchMonitorAuthorizedOrigins: [] });
  }
  private queue<T>(action: () => Promise<T>): Promise<T> {
    const task = this.serial.then(action, action);
    this.serial = task.catch(() => {});
    return task;
  }
  private current(origin: string): LocalLoginPreferences { return this.preferences.get(origin) ?? fresh(); }
  private generation(origin: string): number { return this.generations.get(origin) ?? 0; }
  private stop(origin: string): void {
    this.generations.set(origin, this.generation(origin) + 1);
    this.verified.delete(origin);
  }
  private check(origin: string): void { if (!this.options.allowedOrigin(origin)) throw new BrokerError('UNAUTHORIZED', '来源不受支持'); }
  read(origin: string): LocalLoginPreferences { this.check(origin); return structuredClone(this.current(origin)); }
  connectedOrigins(): string[] { return [...this.preferences].filter(([, value]) => value.granted && value.connectionWanted).map(([origin]) => origin); }
  private async commit(origin: string, next: LocalLoginPreferences, reason: ChangeReason): Promise<void> {
    const previous = this.current(origin);
    this.stop(origin);
    this.preferences.set(origin, next);
    this.options.broker.authorize(origin, next.granted, false);
    try { await this.persist(); this.blocked.delete(origin); }
    catch {
      // A later write for another origin must never serialize an enable that was reported as failed.
      this.preferences.set(origin, { ...fresh(), revision: next.revision, granted: previous.granted && next.granted,
        connectionWanted: previous.connectionWanted && next.connectionWanted,
        ...(previous.granted && next.granted && previous.expectedUid ? { expectedUid: previous.expectedUid } : {}) });
      this.blocked.add(origin); this.options.onChange?.(origin, next.revision, reason); throw unavailable();
    }
    this.options.onChange?.(origin, next.revision, reason);
  }
  async grant(origin: string, granted: boolean, reason: ChangeReason = granted ? 'preferences-changed' : 'revoked', expectedRevision?: number): Promise<LocalLoginPreferences> {
    this.check(origin);
    if (expectedRevision !== undefined) {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new BrokerError('INVALID_REQUEST', '设置版本无效');
      await this.ready;
      if (this.current(origin).revision !== expectedRevision) throw conflict();
    }
    if (!granted) { this.blocked.add(origin); this.stop(origin); this.options.broker.authorize(origin, false, false); }
    return this.queue(async () => {
      await this.ready;
      const before = this.current(origin);
      if (expectedRevision !== undefined && before.revision !== expectedRevision) throw conflict();
      if (granted && before.granted && !this.blocked.has(origin)) return this.read(origin);
      await this.commit(origin, { ...fresh(), revision: before.revision + 1, granted }, reason);
      return this.read(origin);
    });
  }
  async revokeAll(): Promise<void> {
    await this.ready;
    await Promise.all([...this.preferences.keys()].map(origin => this.grant(origin, false, 'permission-removed')));
  }
  /** Cookie events invalidate old work immediately; an isolated cookie deletion is not a logout. */
  credentialsChanged(delay = 500): void {
    for (const origin of this.preferences.keys()) this.stop(origin);
    if (!this.settling) this.settling = new Promise(resolve => { this.finishSettling = resolve; });
    clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this.settleTimer = undefined; this.settling = undefined;
      this.finishSettling?.(); this.finishSettling = undefined;
    }, delay);
  }
  private async settle(signal?: AbortSignal): Promise<void> {
    while (this.settling) {
      if (signal?.aborted) throw cancelled();
      await this.settling;
    }
    if (signal?.aborted) throw cancelled();
  }
  private snapshot(origin: string, account?: LocalAccount, verifiedAt?: number): LocalLoginSession {
    if (account?.authEpoch !== this.options.broker.authEpoch) { account = undefined; verifiedAt = undefined; }
    const preferences = this.read(origin);
    let reason: LocalLoginSessionReason = !preferences.granted ? 'unauthorized' : !preferences.connectionWanted ? 'not-connected' : 'unverified';
    if (preferences.granted && preferences.connectionWanted && account) {
      reason = account.state === 'logged-out' ? 'logged-out' : account.state === 'unauthorized' ? 'unauthorized'
        : preferences.expectedUid && preferences.expectedUid !== account.uid ? 'account-changed' : 'ready';
    }
    const unified = preferences.authorizationVersion === 2 && preferences.playbackWanted && preferences.chatWanted === true;
    const playbackAllowed = unified && !this.blocked.has(origin) && reason === 'ready' && preferences.playbackWanted &&
      account?.state === 'logged-in' && account.uid === preferences.expectedUid;
    const chatAllowed = unified && !this.blocked.has(origin) && reason === 'ready' && preferences.chatWanted === true &&
      account?.state === 'logged-in' && account.uid === preferences.expectedUid;
    const danmakuAllowed = unified && !this.blocked.has(origin) && reason === 'ready' && preferences.granted && preferences.connectionWanted &&
      account?.state === 'logged-in' && account.uid === preferences.expectedUid;
    return { preferences, ...(account ? { account: structuredClone(account) } : {}),
      ...(verifiedAt !== undefined ? { verifiedAt } : {}), playbackAllowed, chatAllowed, danmakuAllowed, reason };
  }
  async get(origin: string, signal?: AbortSignal, force = false): Promise<LocalLoginSession> {
    this.check(origin); await this.ready;
    // Retry only the current fail-closed state. The failed enable/confirmation is never replayed.
    // This precedes the unauthorized/unconnected fast path so a failed revoke can converge too.
    await this.queue(async () => {
      if (signal?.aborted) throw cancelled();
      if (!this.blocked.has(origin)) return;
      try { await this.persist(); }
      catch { throw unavailable(); }
      const safe = this.current(origin);
      this.blocked.delete(origin);
      this.options.broker.authorize(origin, safe.granted, false);
      this.options.onChange?.(origin, safe.revision, safe.granted ? 'playback-disabled' : 'revoked');
    });
    await this.settle(signal);
    const before = this.current(origin);
    if (!before.granted || !before.connectionWanted) return this.snapshot(origin);
    if (this.blocked.has(origin)) throw unavailable();
    const generation = this.generation(origin), revision = before.revision;
    const account = await this.options.broker.account(origin, signal, force);
    if (signal?.aborted) throw cancelled();
    if (generation !== this.generation(origin) || revision !== this.current(origin).revision) throw conflict();
    const verifiedAt = this.options.broker.accountVerifiedAt;
    // Only verified upstream logout or a different UID may clear the enabled intent.
    if (account.state !== 'logged-in' || (before.expectedUid && before.expectedUid !== account.uid)) {
      await this.queue(async () => {
        if (revision !== this.current(origin).revision || generation !== this.generation(origin)) throw conflict();
        const { expectedUid: previousUid, ...unbound } = before;
        if (before.playbackWanted || before.chatWanted || (account.state !== 'logged-in' && previousUid)) await this.commit(origin,
          { ...(account.state !== 'logged-in' ? unbound : before), revision: revision + 1, playbackWanted: false, chatWanted: false },
          account.state === 'logged-out' ? 'logged-out' : account.state === 'unauthorized' ? 'revoked' : 'account-changed');
      });
    }
    this.verified.set(origin, { account, verifiedAt });
    return this.snapshot(origin, account, verifiedAt);
  }
  async update(origin: string, input: LocalLoginSessionUpdate, signal?: AbortSignal, trustedChatEnable = false, expectedEpoch?: string): Promise<LocalLoginSession> {
    this.check(origin); await this.ready;
    if (!Number.isSafeInteger(input.revision) || input.revision < 0 ||
      (input.connectionWanted !== undefined && typeof input.connectionWanted !== 'boolean') ||
      (input.playbackWanted !== undefined && typeof input.playbackWanted !== 'boolean') ||
      (input.chatWanted !== undefined && typeof input.chatWanted !== 'boolean') ||
      (input.chatWanted === true && !trustedChatEnable) ||
      (input.confirmUid !== undefined && !uid(input.confirmUid)) ||
      (input.connectionWanted === undefined && input.playbackWanted === undefined && input.chatWanted === undefined && input.confirmUid === undefined)) throw new BrokerError('INVALID_REQUEST', '设置参数无效');
    const previousEvidence = this.verified.get(origin);
    if (input.connectionWanted === false || input.playbackWanted === false || input.chatWanted === false) this.stop(origin);
    // Prepare fresh evidence outside the storage mutex; never hold it over the network.
    let account: LocalAccount | undefined;
    if (input.connectionWanted === true || input.playbackWanted === true || input.chatWanted === true || input.confirmUid !== undefined) {
      const before = this.current(origin);
      if (before.revision !== input.revision) throw conflict();
      if (!before.granted) throw new BrokerError('UNAUTHORIZED', '请先在扩展中授权本站');
      await this.settle(signal);
      account = await this.options.broker.account(origin, signal, true);
    }
    return this.queue(async () => {
      if (signal?.aborted) throw cancelled();
      const before = this.current(origin);
      if (before.revision !== input.revision) throw conflict();
      if (!before.granted) throw new BrokerError('UNAUTHORIZED', '请先在扩展中授权本站');
      const connectionWanted = input.connectionWanted ?? before.connectionWanted;
      let playbackWanted = connectionWanted && (input.playbackWanted ?? before.playbackWanted);
      let chatWanted = connectionWanted && (input.chatWanted ?? before.chatWanted ?? false);
      let expectedUid = before.expectedUid ?? (account?.state === 'logged-in' ? account.uid : undefined);
      if (account && account.authEpoch !== this.options.broker.authEpoch) throw conflict();
      if (expectedEpoch !== undefined && (account?.authEpoch !== expectedEpoch || expectedEpoch !== this.options.broker.authEpoch)) throw conflict();
      if (input.confirmUid !== undefined) {
        if (!account || account.state !== 'logged-in' || account.uid !== input.confirmUid) throw new BrokerError('ACCOUNT_CHANGED', '当前B站账号已变化，请重新确认');
        expectedUid = account.uid;
      }
      if (before.expectedUid && expectedUid !== before.expectedUid) {
        // Confirming a replacement account for playback cannot grant it the old account's write capability.
        chatWanted = input.chatWanted === true && trustedChatEnable;
        playbackWanted = input.playbackWanted === true;
      }
      if (input.playbackWanted === true && (!account || account.state !== 'logged-in' || account.uid !== expectedUid || input.confirmUid !== account.uid))
        throw new BrokerError('ACCOUNT_CHANGED', '请确认当前B站账号后开启登录取流');
      if (input.chatWanted === true && (!account || account.state !== 'logged-in' || account.uid !== expectedUid || input.confirmUid !== account.uid))
        throw new BrokerError('ACCOUNT_CHANGED', '请在扩展中确认当前B站账号后开启弹幕互动');
      if (account?.state === 'logged-out') { playbackWanted = false; chatWanted = false; expectedUid = undefined; }
      const next: LocalLoginPreferences = { schemaVersion: 1, revision: before.revision + 1, granted: true, connectionWanted, playbackWanted,
        chatWanted,
        ...(expectedUid ? { expectedUid } : {}) };
      await this.commit(origin, next, input.playbackWanted === false || input.connectionWanted === false ? 'playback-disabled' : 'preferences-changed');
      if (account?.authEpoch === this.options.broker.authEpoch) this.verified.set(origin, { account, verifiedAt: this.options.broker.accountVerifiedAt });
      else if (connectionWanted && previousEvidence?.account.authEpoch === this.options.broker.authEpoch) this.verified.set(origin, previousEvidence);
      const evidence = this.verified.get(origin);
      return this.snapshot(origin, account ?? evidence?.account, account ? this.options.broker.accountVerifiedAt : evidence?.verifiedAt);
    });
  }
  async requireChat(origin: string, authEpoch: unknown, signal?: AbortSignal): Promise<LocalLoginSession> {
    const session = await this.get(origin, signal);
    if (!session.chatAllowed || session.account?.state !== 'logged-in')
      throw new BrokerError('UNAUTHORIZED', '请先连接并授权本机 B站账号');
    this.assertChatCurrent(origin, authEpoch, session.account.uid!);
    return session;
  }
  assertChatCurrent(origin: string, authEpoch: unknown, accountUid: string): void {
    const state = this.read(origin);
    if (this.blocked.has(origin) || state.authorizationVersion !== 2 || !state.granted || !state.connectionWanted || !state.playbackWanted || !state.chatWanted ||
      state.expectedUid !== accountUid || authEpoch !== this.options.broker.authEpoch)
      throw new BrokerError('ACCOUNT_CHANGED', '弹幕账号或授权已变化，请重新同步');
  }
  async requireDanmaku(origin: string, authEpoch: unknown, signal?: AbortSignal): Promise<LocalLoginSession> {
    const session = await this.get(origin, signal);
    if (!session.danmakuAllowed || session.account?.state !== 'logged-in')
      throw new BrokerError('UNAUTHORIZED', '请先连接并确认本机 B站账号');
    this.assertDanmakuCurrent(origin, authEpoch, session.account.uid!);
    return session;
  }
  assertDanmakuCurrent(origin: string, authEpoch: unknown, accountUid: string): void {
    const state = this.read(origin);
    if (this.blocked.has(origin) || state.authorizationVersion !== 2 || !state.granted || !state.connectionWanted || !state.playbackWanted || !state.chatWanted || state.expectedUid !== accountUid ||
      authEpoch !== this.options.broker.authEpoch) throw new BrokerError('ACCOUNT_CHANGED', '弹幕账号或授权已变化，请重新同步');
  }
  async verifyAccountRejection(origin: string, authEpoch: string): Promise<void> {
    if (authEpoch !== this.options.broker.authEpoch) return;
    const before = this.current(origin);
    if (!before.granted || !before.connectionWanted) return;
    // Only NAV's explicit logout/different UID may change the durable intent.
    // get() merges the verification and applies its normal generation/CAS checks.
    await this.get(origin, undefined, true);
  }
  async enableChat(origin: string, binding?: { uid: string; revision: number; authEpoch: string }, signal?: AbortSignal): Promise<LocalLoginSession> {
    const before = this.read(origin);
    if (!before.granted) throw new BrokerError('UNAUTHORIZED', '请先授权当前 monitor 页面');
    if (binding && (binding.revision !== before.revision || binding.authEpoch !== this.options.broker.authEpoch)) throw conflict();
    const account = await this.options.broker.account(origin, signal, true);
    if (account.state !== 'logged-in') throw new BrokerError('LOGGED_OUT', '请先在同一浏览器登录 B站');
    if (binding && (account.uid !== binding.uid || account.authEpoch !== binding.authEpoch)) throw new BrokerError('ACCOUNT_CHANGED', '当前B站账号已变化，请重新确认');
    return this.update(origin, { revision: before.revision, connectionWanted: true, chatWanted: true, confirmUid: account.uid }, signal, true, binding?.authEpoch);
  }
  /** Only extension-owned user confirmation may establish the complete v2 authorization. */
  async authorize(origin: string, binding: { revision: number; uid?: string; authEpoch?: string }, signal?: AbortSignal,
    current?: () => Promise<boolean>): Promise<LocalLoginSession> {
    this.check(origin); await this.ready;
    const before = this.current(origin), generation = this.generation(origin);
    if (!Number.isSafeInteger(binding.revision) || binding.revision !== before.revision) throw conflict();
    if (binding.uid !== undefined && !uid(binding.uid)) throw new BrokerError('INVALID_REQUEST', '账号无效');
    if (binding.authEpoch !== undefined && binding.authEpoch !== this.options.broker.authEpoch) throw conflict();
    // The user is in trusted extension UI. This temporary broker permission only permits NAV;
    // no page capability is granted until the verified complete preference is committed below.
    this.options.broker.authorize(origin, true, false);
    try {
      await this.settle(signal);
      const account = await this.options.broker.account(origin, signal, true);
      if (account.state !== 'logged-in') throw new BrokerError('LOGGED_OUT', '请先在同一浏览器登录 B站，再连接并授权');
      if ((binding.uid !== undefined && account.uid !== binding.uid) || (binding.authEpoch !== undefined && account.authEpoch !== binding.authEpoch))
        throw new BrokerError('ACCOUNT_CHANGED', 'B站账号已变化，请重新确认当前账号');
      if (current && !await current()) throw cancelled();
      return await this.queue(async () => {
        if (signal?.aborted) throw cancelled();
        if (generation !== this.generation(origin) || before.revision !== this.current(origin).revision || account.authEpoch !== this.options.broker.authEpoch) throw conflict();
        await this.commit(origin, { schemaVersion: 1, authorizationVersion: 2, revision: before.revision + 1,
          granted: true, connectionWanted: true, playbackWanted: true, chatWanted: true, expectedUid: account.uid }, 'preferences-changed');
        // A source document can leave while storage.set is pending. Converge to a safe
        // tombstone before releasing the queue; no waiting page request sees that consent.
        if (signal?.aborted || (current && !await current())) {
          await this.commit(origin, { ...fresh(), revision: this.current(origin).revision + 1 }, 'revoked');
          throw cancelled();
        }
        this.verified.set(origin, { account, verifiedAt: this.options.broker.accountVerifiedAt });
        return this.snapshot(origin, account, this.options.broker.accountVerifiedAt);
      });
    } catch (failure) {
      this.options.broker.authorize(origin, this.current(origin).granted, false);
      throw failure;
    }
  }
  async resolve(origin: string, input: { roomId?: string; qn?: number; force?: boolean; authEpoch?: string }, signal: AbortSignal): Promise<PlaybackInfo> {
    const session = await this.get(origin, signal);
    if (!session.preferences.granted) throw new BrokerError('UNAUTHORIZED', '本站授权已撤销');
    if (!session.playbackAllowed) throw new BrokerError(session.reason === 'logged-out' ? 'LOGGED_OUT' : 'ACCOUNT_CHANGED', '本机登录取流未启用或账号待确认');
    const revision = session.preferences.revision, generation = this.generation(origin);
    let info: PlaybackInfo;
    try { info = await this.options.broker.resolve(origin, input, signal); }
    catch (failure) {
      if (failure instanceof AccountVerificationRequired) await this.verifyAccountRejection(origin, input.authEpoch!);
      throw failure;
    }
    if (generation !== this.generation(origin) || revision !== this.current(origin).revision || this.blocked.has(origin)) throw conflict();
    return info;
  }
}
