import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { MonitorRoomDescriptor } from '../../shared/types';
import { FollowingRoomsStore, readFollowingRoomsPage, readFollowingStatusBatch } from './followingRooms';
import { useLocalLogin, useLocalLoginTransport } from './useLocalLogin';
import { readFollowingRoomInfo } from './followingRoomInfo';
import type { CustomRoomRecord } from './customRooms';
import { LocalLoginClientError } from './localLoginClient';

export interface FollowingRoomsView {
  rooms: MonitorRoomDescriptor[];
  status: 'idle' | 'loading' | 'ready' | 'error' | 'not-installed' | 'update-required' | 'login-required' | 'restoring';
  loading: boolean;
  hasMore: boolean;
  total: number | null;
  unmappedCount: number;
  liveCount: number | null;
  complete: boolean;
  indexing: boolean;
  refreshing: boolean;
  refreshKind: 'directory' | 'status' | null;
  loadedCount: number;
  scannedPages: number;
  incompleteReason: string;
  error: string;
  loadMore: () => void;
  reload: () => void;
  visibleRoomIds: string[];
  trustedRoomIds: string[];
  roomInfoAvailable: boolean;
  setVisibleRoomIds: (ids: string[]) => void;
  resolveRoomInfo: (roomId: string, signal: AbortSignal) => Promise<CustomRoomRecord>;
  applyRoomInfo: (roomId: string, room: CustomRoomRecord) => void;
}

export function useFollowingRooms(active: boolean): FollowingRoomsView {
  const login = useLocalLogin(), getClient = useLocalLoginTransport();
  const current = useRef(login); current.current = login;
  const [foreground, setForeground] = useState(() => !document.hidden && navigator.onLine);
  const [visibleRoomIds, setVisible] = useState<string[]>([]);
  const setVisibleRoomIds = useCallback((ids: string[]) => {
    const next = [...new Set(ids.filter(id => /^[1-9]\d{0,19}$/.test(id)))].slice(0, 32);
    setVisible(previous => previous.join(',') === next.join(',') ? previous : next);
  }, []);
  const store = useMemo(() => new FollowingRoomsStore((page, signal) => current.current.readAccount(signal, async account => {
    const result = await getClient().request('GET_FOLLOWING_ROOMS', { page, authEpoch: account.authEpoch }, signal);
    return readFollowingRoomsPage(result, page, account.uid!, account.authEpoch);
  }), Date.now, undefined, (uids, signal) => current.current.readAccount(signal, async account => {
    const result = await getClient().request('GET_FOLLOWING_STATUS', { uids, authEpoch: account.authEpoch }, signal);
    return readFollowingStatusBatch(result, uids, account.uid!, account.authEpoch);
  })), [getClient]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const permitted = login.authorizationCurrent && login.connectionWanted && login.account?.state === 'logged-in';
  const scope = permitted ? `${login.authSessionKey}:${login.account!.uid}` : '';
  const available = login.capabilities?.includes('following') === true;
  const supportsStatus = login.capabilities?.includes('following-status') === true;
  const readable = available && permitted && login.enabled && login.connected;
  const roomInfoAvailable = readable && login.capabilities?.includes('following-room-info') === true;
  const resolveRoomInfo = useCallback((roomId: string, signal: AbortSignal) => {
    const expectedScope = scope, owner = store.getRoomUid(roomId);
    if (!owner || !roomInfoAvailable || !expectedScope) return Promise.reject(new LocalLoginClientError('UNAVAILABLE', '房间信息暂时无法更新'));
    return current.current.readAccount(signal, async account => {
      const result = await getClient().request('GET_FOLLOWING_ROOM_INFO', { roomId, uid: owner, authEpoch: account.authEpoch }, signal, 15000);
      if (store.getScope() !== expectedScope || store.getRoomUid(roomId) !== owner) throw new DOMException('Request cancelled', 'AbortError');
      return readFollowingRoomInfo(result, roomId, owner, account.uid!, account.authEpoch);
    });
  }, [store, getClient, scope, roomInfoAvailable]);
  const applyRoomInfo = useCallback((roomId: string, room: CustomRoomRecord) => store.applyRoomInfo(roomId, room, scope), [store, scope]);
  useLayoutEffect(() => { store.setContext(scope, active && foreground && readable, supportsStatus); }, [store, scope, active, foreground, readable, supportsStatus]);
  useEffect(() => {
    const update = () => {
      const available = !document.hidden && navigator.onLine;
      // Cancel in the visibility event itself: a response microtask can arrive
      // before React commits the new foreground state.
      if (!available) store.setContext(store.getScope(), false);
      setForeground(available);
    };
    const leave = () => { store.dispose(); setForeground(false); };
    window.addEventListener('online', update); window.addEventListener('offline', update); window.addEventListener('pageshow', update);
    window.addEventListener('pagehide', leave); document.addEventListener('visibilitychange', update);
    return () => { store.dispose(); window.removeEventListener('online', update); window.removeEventListener('offline', update);
      window.removeEventListener('pageshow', update); window.removeEventListener('pagehide', leave); document.removeEventListener('visibilitychange', update); };
  }, [store]);
  const status: FollowingRoomsView['status'] = !login.initialReady ? 'restoring' : !login.extensionVersion ? 'not-installed'
    : !available ? 'update-required' : !permitted ? 'login-required' : !readable ? 'restoring'
      : snapshot.indexing && !snapshot.rooms.length ? 'loading' : snapshot.error || snapshot.incompleteReason ? 'error' : snapshot.rooms.length || snapshot.complete ? 'ready' : 'idle';
  // Clear old account rows synchronously, before any passive effect or exit artwork.
  const visible = Boolean(scope) && store.getScope() === scope && permitted;
  return { ...(visible ? snapshot : { rooms: [], loading: false, hasMore: false, total: null, unmappedCount: 0, liveCount: null, complete: false,
    indexing: false, refreshing: false, refreshKind: null, loadedCount: 0, scannedPages: 0, incompleteReason: '', error: '' }),
    status, loadMore: store.loadMore, reload: store.reload,
    visibleRoomIds: visible && active && foreground ? visibleRoomIds : [],
    trustedRoomIds: visible ? store.getTrustedRoomIds() : [], roomInfoAvailable,
    setVisibleRoomIds, resolveRoomInfo, applyRoomInfo };
}
