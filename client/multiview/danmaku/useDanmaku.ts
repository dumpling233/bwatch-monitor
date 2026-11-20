import { useCallback, useEffect, useRef, useState } from 'react';
import type { DanmakuBootstrap } from '../../../shared/danmaku';
import { DanmakuManager } from './manager';
import type { DanmakuMessage, DanmakuRoomState, DanmakuWorkerEvent } from './types';
import type { DanmakuHistoryView } from './store';

export function useDanmaku({ roomIds, retainedRoomIds = roomIds, roomSources, visibilityRevision, identityScope = 'anonymous', bootstrapReady = true,
  resolveBootstrap, currentChatRoomId, publishedRoomId = currentChatRoomId, publishedView = 'all', priorityRoomId }: {
  roomIds: readonly string[];
  /** Keep bounded history while a selected room is temporarily not receiving. */
  retainedRoomIds?: readonly string[];
  /** All room data comes from the independent app's public extension provider. */
  roomSources?: Readonly<Record<string, 'custom'>>;
  visibilityRevision?: string | number | null;
  identityScope?: string;
  bootstrapReady?: boolean;
  resolveBootstrap?: (roomId: string, force: boolean, signal: AbortSignal, source: 'custom') => Promise<DanmakuBootstrap>;
  currentChatRoomId?: string | null;
  publishedRoomId?: string | null;
  /** Omitted by legacy callers, which continue to receive both histories. */
  publishedView?: DanmakuHistoryView;
  priorityRoomId?: string | null;
}) {
  const [rooms, setRooms] = useState<Record<string, DanmakuRoomState>>({});
  const identityKey = JSON.stringify([identityScope, visibilityRevision]);
  const renderIdentity = useRef(identityKey); renderIdentity.current = identityKey;
  const stateIdentity = useRef(identityKey);
  const [workerEpoch, setWorkerEpoch] = useState(0);
  const managerRef = useRef<DanmakuManager | null>(null);
  const startWhenNeeded = useRef<(() => void) | null>(null);
  const pageHiddenRef = useRef(false);
  const neededRef = useRef(roomIds); neededRef.current = roomIds;
  const retainedRef = useRef(retainedRoomIds); retainedRef.current = retainedRoomIds;
  const sourcesRef = useRef(roomSources); sourcesRef.current = roomSources;
  const resolverRef = useRef(resolveBootstrap); resolverRef.current = resolveBootstrap;
  const chatRef = useRef(currentChatRoomId); chatRef.current = currentChatRoomId;
  const publishedRef = useRef(publishedRoomId); publishedRef.current = publishedRoomId;
  const publishedViewRef = useRef(publishedView); publishedViewRef.current = publishedView;
  const priorityRef = useRef(priorityRoomId); priorityRef.current = priorityRoomId;
  const hiddenAt = useRef<number | null>(null);
  const listeners = useRef(new Map<string, Set<(messages: DanmakuMessage[]) => void>>());
  const sourceKey = [...new Set([...roomIds, ...retainedRoomIds])].map(id => `${id}:${roomSources?.[id] ?? 'custom'}`).sort().join(',');
  const hasRooms = roomIds.length > 0 || retainedRoomIds.length > 0;
  useEffect(() => {
    stateIdentity.current = identityKey;
    setRooms({});
    let disposed = false;
    let failed = false;
    let worker: Worker | null = null;
    let manager: DanmakuManager | null = null;
    let shortTimer: ReturnType<typeof setTimeout> | undefined;
    let longTimer: ReturnType<typeof setTimeout> | undefined;
    const orderedRooms = () => [...neededRef.current].sort((a, b) =>
      (a === chatRef.current ? -2 : a === priorityRef.current ? -1 : 0) - (b === chatRef.current ? -2 : b === priorityRef.current ? -1 : 0));
    const activeRooms = () => hiddenAt.current === null ? orderedRooms() : Date.now() - hiddenAt.current >= 300_000 ? []
      : Date.now() - hiddenAt.current >= 30_000 ? orderedRooms().filter(id => id === chatRef.current) : orderedRooms();
    const clearTimers = () => { clearTimeout(shortTimer); clearTimeout(longTimer); shortTimer = longTimer = undefined; };
    const activity = () => {
      clearTimers();
      if (document.hidden) {
        hiddenAt.current ??= Date.now();
        manager?.setPublishing(false);
        manager?.setActiveRooms(activeRooms());
        const elapsed = Date.now() - hiddenAt.current;
        if (elapsed < 30_000) shortTimer = setTimeout(() => manager?.setActiveRooms(activeRooms()), 30_000 - elapsed);
        if (elapsed < 300_000) longTimer = setTimeout(() => manager?.setActiveRooms([]), 300_000 - elapsed);
      } else {
        hiddenAt.current = null;
        manager?.setActiveRooms(orderedRooms());
        manager?.setPublishing(true);
      }
    };
    const stop = () => {
      const previousManager = manager, previousWorker = worker;
      manager = null; worker = null;
      if (managerRef.current === previousManager) managerRef.current = null;
      if (previousWorker) { previousWorker.onmessage = null; previousWorker.onerror = null; }
      previousManager?.dispose(); previousWorker?.terminate();
    };
    const start = () => {
      if (disposed || failed || pageHiddenRef.current || manager || !neededRef.current.length || !bootstrapReady) return;
      setRooms({});
      let nextWorker: Worker;
      try { nextWorker = new Worker(new URL('./danmaku.worker.ts', import.meta.url), { type: 'module', name: 'bwatch-monitor-danmaku' }); }
      catch {
        failed = true;
        setRooms(Object.fromEntries(neededRef.current.map(id => [id, { status: 'error', error: '当前浏览器不支持弹幕工作线程', messages: [], superChats: [] }])));
        return;
      }
      const current = () => !disposed && !pageHiddenRef.current && manager === nextManager && renderIdentity.current === identityKey;
      const nextManager = new DanmakuManager({
        bootstrap: (roomId, refresh, signal, source) => {
          if (resolverRef.current) return resolverRef.current(roomId, refresh, signal, source ?? 'custom');
          return Promise.reject(new Error('请先安装并连接浏览器扩展'));
        },
        post: command => nextWorker.postMessage(command),
        changed: value => { if (current() && !document.hidden) setRooms(value); },
        messages: (roomId, messages) => { if (current() && !document.hidden) for (const listener of listeners.current.get(roomId) || []) listener(messages); },
      });
      manager = nextManager; worker = nextWorker; managerRef.current = nextManager;
      nextWorker.onmessage = (event: MessageEvent<DanmakuWorkerEvent>) => { if (current()) nextManager.receive(event.data); };
      nextWorker.onerror = () => {
        if (!current()) return;
        failed = true;
        stop();
        setRooms(Object.fromEntries(neededRef.current.map(id => [id, { status: 'error', error: '弹幕工作线程加载失败', messages: [], superChats: [] }])));
      };
      activity();
      nextManager.setRooms(orderedRooms(), sourcesRef.current, retainedRef.current);
      nextManager.setPublishedRooms(publishedRef.current ? [publishedRef.current] : [], publishedViewRef.current);
    };
    const hide = () => { pageHiddenRef.current = true; clearTimers(); stop(); setRooms({}); };
    const show = (event: PageTransitionEvent) => { if (event.persisted) { pageHiddenRef.current = false; failed = false; start(); } };
    const online = () => manager?.online();
    window.addEventListener('online', online);
    window.addEventListener('pagehide', hide); window.addEventListener('pageshow', show);
    document.addEventListener('visibilitychange', activity);
    startWhenNeeded.current = start;
    start();
    return () => {
      startWhenNeeded.current = null;
      disposed = true; clearTimers(); stop();
      window.removeEventListener('online', online);
      window.removeEventListener('pagehide', hide); window.removeEventListener('pageshow', show);
      document.removeEventListener('visibilitychange', activity);
    };
  // Create the worker on first demand and keep history through selected-room pauses.
  }, [visibilityRevision, hasRooms, workerEpoch, identityScope, bootstrapReady]);
  const key = [...roomIds].sort().join(',');
  const retainedKey = [...retainedRoomIds].sort().join(',');
  useEffect(() => {
    const manager = managerRef.current;
    if (!manager) { startWhenNeeded.current?.(); return; }
    const ordered = [...neededRef.current].sort((a, b) =>
      (a === chatRef.current ? -2 : a === priorityRef.current ? -1 : 0) - (b === chatRef.current ? -2 : b === priorityRef.current ? -1 : 0));
    const elapsed = hiddenAt.current === null ? 0 : Date.now() - hiddenAt.current;
    const active = elapsed >= 300_000 ? [] : elapsed >= 30_000 ? ordered.filter(id => id === chatRef.current) : ordered;
    manager.setRooms(ordered, sourcesRef.current, retainedRef.current, active);
    manager.setPublishedRooms(publishedRef.current ? [publishedRef.current] : [], publishedViewRef.current);
  }, [key, retainedKey, sourceKey, currentChatRoomId, publishedRoomId, publishedView, priorityRoomId]);
  const subscribe = useCallback((roomId: string, listener: (messages: DanmakuMessage[]) => void) => {
    let callbacks = listeners.current.get(roomId); if (!callbacks) listeners.current.set(roomId, callbacks = new Set());
    callbacks.add(listener);
    return () => { callbacks?.delete(listener); if (!callbacks?.size) listeners.current.delete(roomId); };
  }, []);
  const clear = useCallback((roomId: string) => managerRef.current?.clear(roomId), []);
  const reconnect = useCallback((roomId: string) => {
    if (managerRef.current) managerRef.current.reconnect(roomId);
    else if (neededRef.current.includes(roomId)) setWorkerEpoch(epoch => epoch + 1);
  }, []);
  return { rooms: stateIdentity.current === identityKey ? rooms : {}, clear, reconnect, subscribe };
}
