import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import type { DanmakuBootstrap } from '../../shared/danmaku';
import { LOCAL_LOGIN_EXTENSION_NAME } from '../../shared/extensionBrand';
import { LocalChatBridge } from './localChatClient';
import { LocalLoginClientError } from './localLoginClient';
import { LocalMedalAccountCoordinator, LocalMedalNotDispatchedError, LocalMedalStore, readMedalPage, readMedalRoomContext, readMedalSelection } from './localMedalClient';
import { supportsMedalRoomContext, supportsMedalSelection } from './extensionUpdates';
import { useLocalLogin, useLocalLoginTransport } from './useLocalLogin';
import { AutoRoomMedal } from './autoRoomMedal';

type RoomSource = 'custom';
const cancelled = () => new DOMException('弹幕上下文已变化', 'AbortError');

/** Keep local cancellation and account boundaries around each operation. */
export async function withChatRoomAccess<T>(_roomId: string, _source: RoomSource, signal: AbortSignal,
  run: () => Promise<T>, current: () => boolean, postcheck = true): Promise<T> {
  if (signal.aborted || !current()) throw cancelled();
  const result = await run();
  if (postcheck && (signal.aborted || !current())) throw cancelled();
  return result;
}

export function useLocalChat(roomSources: Readonly<Record<string, RoomSource>>, medalRoomId: string | null = null,
  options: { autoWearRoomMedal: boolean; active: boolean } = { autoWearRoomMedal: false, active: false }) {
  const login = useLocalLogin();
  const getClient = useLocalLoginTransport();
  const current = useRef(login); current.current = login;
  const bridge = useMemo(() => new LocalChatBridge(getClient, () => Date.now(), failure => { void current.current.accountFailed(failure); }), [getClient]);
  const sources = useRef(roomSources); sources.current = roomSources;
  const local = login.capabilities?.includes('danmaku') === true;
  const available = login.capabilities?.includes('chat') === true;
  const authenticated = login.danmakuWanted === true;
  const accountUid = login.account?.state === 'logged-in' ? login.account.uid : undefined;
  const authEpoch = login.account?.authEpoch;
  const scope = !login.initialReady ? 'restoring' : local
    ? authenticated ? `local-chat:${login.authSessionKey}:${accountUid ?? 'unverified'}` : 'local-chat:anonymous'
    : 'extension-unavailable';
  const scopeRef = useRef(scope); scopeRef.current = scope;
  // Establish the new scope before visible child rows start their passive
  // profile effects; a later parent effect would cancel the fresh reads.
  useLayoutEffect(() => { bridge.invalidate(); return () => bridge.invalidate(); }, [bridge, scope]);
  const assertAccount = (epoch?: string) => {
    // Recovery can adopt an epoch before React commits its next render.
    const state = current.current.currentState();
    if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new LocalLoginClientError('UNAVAILABLE', '网络已断开，尚未发送');
    if (!state.chatEnabled || !state.connected || state.account?.state !== 'logged-in' || (epoch !== undefined && epoch !== state.account.authEpoch))
      throw new LocalLoginClientError('ACCOUNT_CHANGED', '账号尚未授权或正在恢复，请在设置中查看');
    return state.account;
  };
  const medalsSupported = supportsMedalSelection(login.extensionVersion, login.capabilities);
  const roomMedalsSupported = supportsMedalRoomContext(login.extensionVersion, login.capabilities);
  const medalScope = medalsSupported && login.authorizationCurrent && login.chatWanted && accountUid ? `${login.authSessionKey}:${accountUid}` : '';
  const medalStores = useMemo(() => new Map<string, LocalMedalStore>(), [getClient, medalScope]);
  const medalAccount = useMemo(() => new LocalMedalAccountCoordinator(), [getClient, medalScope]);
  const autoMedal = useMemo(() => new AutoRoomMedal(), [getClient, medalScope]);
  const medalRoomProofs = useMemo(() => new Map<string, { epoch: string; at: number }>(), [getClient, medalScope]);
  const medals = useMemo(() => {
    if (!medalScope || !medalRoomId) return;
    const existing = medalStores.get(medalRoomId);
    const roomId = medalRoomId;
    const catalogPages = new Map<number, { epoch: string; at: number }>();
    const readRoom = (signal: AbortSignal) => current.current.readAccount(signal, async account => {
      assertAccount(account.authEpoch);
      const value = readMedalRoomContext(await getClient().getRoomFanMedals(roomId, account.authEpoch, signal), account.uid!, account.authEpoch, roomId);
      medalRoomProofs.set(roomId, { epoch: account.authEpoch, at: Date.now() });
      return value;
    });
    if (existing) return existing;
    const store = new LocalMedalStore(`${medalScope}:${roomId}`, {
    ...(roomMedalsSupported ? { room: readRoom } : {}),
    page: (page, signal, force) => current.current.readAccount(signal, async account => {
      assertAccount(account.authEpoch);
      const value = readMedalPage(await getClient().request('GET_FAN_MEDALS', { roomId, page, authEpoch: account.authEpoch, ...(force ? { force: true } : {}) }, signal), account.uid!, account.authEpoch, roomId, page);
      catalogPages.set(page, { epoch: account.authEpoch, at: Date.now() });
      return value;
    }),
    select: async (medalId, signal, source, beforeDispatch) => {
      let dispatched = false;
      try {
        const previous = assertAccount(), expectedScope = current.current.currentState().authSessionKey;
        const account = await current.current.prepareAccount(signal);
        if (signal.aborted || current.current.currentState().authSessionKey !== expectedScope) throw cancelled();
        if (account.uid !== previous.uid) throw cancelled();
        assertAccount(account.authEpoch);
        // The worker's verified directory is memory-only. A cold worker or a
        // long-open picker needs this selected page verified before any POST.
        const proof = source.kind === 'room' ? medalRoomProofs.get(roomId) : catalogPages.get(source.page);
        if (medalId !== null && (!proof || proof.epoch !== account.authEpoch || Date.now() - proof.at >= 5 * 60_000)) {
          const value = source.kind === 'room' ? await readRoom(signal) : readMedalPage(await getClient().request('GET_FAN_MEDALS', { roomId, page: source.page, authEpoch: account.authEpoch }, signal), account.uid!, account.authEpoch, roomId, source.page);
          if (!value.items.some(item => item.id === medalId)) throw new LocalLoginClientError('INVALID_REQUEST', '勋章列表已变化，请刷新后再选择');
          if (source.kind === 'directory') catalogPages.set(source.page, { epoch: account.authEpoch, at: Date.now() });
          if (signal.aborted || current.current.currentState().authSessionKey !== expectedScope) throw cancelled();
          assertAccount(account.authEpoch);
        }
        // Only read-only preparation can be retried. The SET request itself
        // stays outside readAccount's recover-and-repeat path.
        beforeDispatch?.(); dispatched = true;
        return readMedalSelection(await getClient().request('SET_FAN_MEDAL', { roomId, medalId, authEpoch: account.authEpoch }, signal), account.uid!, account.authEpoch, roomId);
      } catch (error) {
        if (dispatched) throw error;
        throw new LocalMedalNotDispatchedError(error instanceof Error && error.name !== 'AbortError' ? error.message : '勋章尚未切换，账号或直播间已变化，请重试');
      }
    }
    }, Date.now, medalAccount);
    medalStores.set(roomId, store);
    if (medalStores.size > 16) {
      const oldest = [...medalStores].find(([id, cached]) => id !== roomId && !medalAccount.retains(cached))?.[0];
      if (oldest) { medalStores.get(oldest)?.dispose(); medalStores.delete(oldest); medalRoomProofs.delete(oldest); }
    }
    return store;
  }, [getClient, medalScope, medalRoomId, medalStores, medalAccount, medalRoomProofs, roomMedalsSupported]);
  useLayoutEffect(() => {
    if (!medals || !medalRoomId) return;
    if (!roomMedalsSupported) { medalRoomProofs.delete(medalRoomId); medals.configureRoom(); return; }
    medals.configureRoom(signal => current.current.readAccount(signal, async account => {
      assertAccount(account.authEpoch);
      const value = readMedalRoomContext(await getClient().getRoomFanMedals(medalRoomId, account.authEpoch, signal), account.uid!, account.authEpoch, medalRoomId);
      medalRoomProofs.set(medalRoomId, { epoch: account.authEpoch, at: Date.now() }); return value;
    }));
  }, [getClient, medals, medalRoomId, roomMedalsSupported, medalRoomProofs]);
  useLayoutEffect(() => {
    autoMedal.update(options.autoWearRoomMedal && roomMedalsSupported,
      options.active && login.initialReady && login.connected && login.chatEnabled === true && !document.hidden, medalRoomId, medals);
  }, [autoMedal, options.autoWearRoomMedal, options.active, roomMedalsSupported, medalRoomId, medals,
    login.initialReady, login.connected, login.chatEnabled]);
  useLayoutEffect(() => () => autoMedal.dispose(), [autoMedal]);
  useLayoutEffect(() => {
    if (!medalScope) return;
    const stop = getClient().onEvent(event => {
      const selection = event.medalSelection, state = current.current.currentState();
      if (event.event !== 'medal-changed' || !selection || selection.status !== 'applied' || state.account?.uid !== selection.accountUid ||
        state.account.authEpoch !== selection.authEpoch || `${state.authSessionKey}:${selection.accountUid}` !== medalScope) return;
      for (const [roomId, store] of medalStores) {
        store.acceptSelection(selection, roomId === selection.roomId);
        if (roomId !== selection.roomId) store.invalidate();
      }
    });
    return () => { stop(); medalAccount.dispose(); for (const store of medalStores.values()) store.dispose(); medalStores.clear(); medalRoomProofs.clear(); };
  }, [getClient, medalScope, medalStores, medalAccount, medalRoomProofs]);
  const bootstrap = useCallback(async (roomId: string, force: boolean, signal: AbortSignal, source: RoomSource): Promise<DanmakuBootstrap> => {
    const state = current.current, expectedScope = scopeRef.current;
    if (!state.capabilities?.includes('danmaku')) throw new LocalLoginClientError('UNAVAILABLE', '当前扩展不支持本机弹幕连接');
    const account = state.danmakuWanted ? state.account : undefined;
    if (state.danmakuWanted && (!state.danmakuEnabled || !state.connected || account?.state !== 'logged-in'))
      throw new LocalLoginClientError('ACCOUNT_CHANGED', '账号弹幕接收正在恢复');
    return withChatRoomAccess(roomId, source, signal,
      () => account ? current.current.readAccount(signal, verified =>
        bridge.bootstrap(roomId, 'authenticated', verified.authEpoch, verified.uid, force, signal)) :
        bridge.bootstrap(roomId, 'anonymous', undefined, undefined, force, signal),
      () => scopeRef.current === expectedScope);
  }, [bridge]);
  const profile = useCallback((uid: string, signal: AbortSignal) => bridge.profile(uid, signal), [bridge]);
  const chat = useMemo(() => ({
    available,
    enabled: login.chatEnabled === true && login.connected,
    accountUid: login.danmakuEnabled ? accountUid : undefined,
    authEpoch: login.chatEnabled ? authEpoch : undefined,
    draftScope: login.chatWanted && accountUid ? `chat-draft:${accountUid}` : undefined,
    sessionScope: login.chatWanted && accountUid ? login.authSessionKey : undefined,
    reason: !available ? `安装或更新 ${LOCAL_LOGIN_EXTENSION_NAME} 浏览器扩展后，可使用 B站账号发言` : login.chatWanted
      ? '暂时无法发送，请稍后重试' : '连接并授权账号后，即可使用 B站账号发言',
    async context(roomId: string, signal: AbortSignal, force = false) {
      assertAccount(); const expectedScope = scopeRef.current;
      return withChatRoomAccess(roomId, sources.current[roomId] ?? 'custom', signal,
        () => current.current.readAccount(signal, account => bridge.context(roomId, account.uid!, account.authEpoch, signal, force)),
        () => scopeRef.current === expectedScope);
    },
    async send(roomId: string, request: { operationId: string; authEpoch: string; text?: string; emoticonUnique?: string }, signal: AbortSignal) {
      let dispatched = false;
      let release: (() => void) | undefined;
      // Only preflight can cancel a not-yet-dispatched send. Never retry POST or discard its definitive result after submission.
      try {
        const previous = assertAccount(), expectedScope = scopeRef.current;
        const expectedAuthorization = current.current.currentState().authSessionKey;
        const authorized = () => scopeRef.current === expectedScope && current.current.currentState().authSessionKey === expectedAuthorization;
        release = await autoMedal.acquireSend(signal);
        if (assertAccount().uid !== previous.uid || !authorized()) throw cancelled();
        // A sleeping MV3 worker gets a new epoch. Resolve that read-only state
        // inside this click, before sending anything, and keep this operation ID.
        return await withChatRoomAccess(roomId, sources.current[roomId] ?? 'custom', signal, async () => {
          const account = await current.current.prepareAccount(signal);
          if (account.uid !== previous.uid || !authorized()) throw cancelled();
          assertAccount(account.authEpoch); dispatched = true;
          return bridge.send(roomId, account.authEpoch, request.operationId,
            { text: request.text, emoticonUnique: request.emoticonUnique }, signal);
        }, authorized, false);
      } catch (error) {
        if (dispatched) throw error;
        return { operationId: request.operationId, status: 'rejected' as const,
          message: error instanceof Error && error.name !== 'AbortError' ? error.message : '尚未发送，账号或直播间已变化，请重试' };
      } finally { release?.(); }
    },
    result: async (operationId: string, signal: AbortSignal) => {
      const previous = assertAccount(), expectedScope = scopeRef.current;
      const expectedAuthorization = current.current.currentState().authSessionKey;
      const release = await autoMedal.acquireSend(signal);
      try {
        if (assertAccount().uid !== previous.uid || scopeRef.current !== expectedScope ||
          current.current.currentState().authSessionKey !== expectedAuthorization) throw cancelled();
        return await bridge.result(operationId, signal);
      } finally { release(); }
    },
    profile: login.capabilities?.includes('profile') ? profile : undefined,
    rememberAvatar: (id: string, face: string) => bridge.rememberAvatar(id, face),
    rejectAvatar: (id: string, face: string) => bridge.rejectAvatar(id, face),
    medals,
  }), [bridge, profile, medals, autoMedal, available, login.chatEnabled, login.danmakuEnabled, login.connected, login.chatWanted, login.authSessionKey, login.capabilities, accountUid, authEpoch]);
  return { chat, local, scope, ready: login.initialReady, bootstrap };
}
