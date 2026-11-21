import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Activity, Check, ChevronLeft, ExternalLink, Focus, Headphones, LayoutGrid,
  Maximize2, MessageSquare, MessageSquareOff, Minimize2, Pause, Play, Plus, Radio, RefreshCw, Search, Settings2, Users, Video, Volume2, VolumeX, X } from 'lucide-react';
import type { MonitorRoomDescriptor } from '../../shared/types';
import type { PlaybackInfo, PlaybackMediaMode, PlaybackSource } from '../../shared/playback';
import { pagePlaybackRequestBudget, PlaybackRequestPool } from './playbackRequestPool';
import { PlaybackRouteCommitGuard } from './playbackRouteCommit';
import { supportsPlaybackSource } from './playbackAdapters';
import { LivePlayer, type PlayerStatus } from './LivePlayer';
import type { PlaybackOptionsState } from './playbackSession';
import { LiveDuration } from './LiveDuration';
import { useLocalLogin, useLocalLoginTransport } from './useLocalLogin';
import { createLocalAudioResolver, invalidateLocalAudioCapability } from './localAudioProvider';
import { useLocalChat } from './useLocalChat';
import { LocalLoginIndicator, LocalLoginSettings, localAccountSetupContext, type LocalAccountSetupFeature, type LocalAccountSetupRequest } from './LocalLoginSettings';
import { useModalLayer } from '../modalLayer';
import { PROJECT_NAME } from '../../shared/site';
import { AnimatedCollapse, RollingNumber, UiSelect, UiSlider } from '../ui';
import { findLayout, layoutForCount, layoutGridStyle, normalizeSlotRoomIds, resetSlotRoomIds, swapRoomSlots, MULTIVIEW_LAYOUTS, SLOT_AREAS, visibleWindow, type MultiviewLayout, type RoomSlot } from './layouts';
import { getAdaptiveGridLayout, adaptiveGridStyle, type AdaptiveGridLayout } from './adaptiveGrid';
import { defaultRoomPreference, MAX_MULTIVIEW_ROOMS, MAX_ADAPTIVE_GRID_ROOMS, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH, normalizeSidebarWidth, readMultiviewPreferences, retainAllowedRooms, writeMultiviewPreferences,
  type MultiviewPreferences, type RoomPlaybackPreference } from './preferences';
import { usePanelMotion } from './usePanelMotion';
import { useTileReorder } from './useTileReorder';
import { PlayerVolumeControl } from './PlayerVolumeControl';
import { PlayerBackdrop } from './PlayerBackdrop';
import { AudioOnlyPresentation } from './AudioOnlyPresentation';
import { RoomPlaybackMenu } from './RoomPlaybackMenu';
import { MonitorRoomCandidate } from './MonitorRoomCandidate';
import { planRoomPlacement } from './roomPlacement';
import { useSidebarRoomDrag } from './useSidebarRoomDrag';
import { RoomPlacementSurface, PlacementUndoToast, placementDescription, type PlacementDraft } from './RoomPlacementSurface';
import { AdaptiveGridDetails, LayoutModeControl, MonitorSettings } from './MonitorSettings';
import { ShortcutAudioControl } from './ShortcutAudioControl';
import { ShortcutRoomRail } from './ShortcutRoomRail';
import { MixerRoomAudio } from './RoomAudioBalance';
import { preparePlaybackAudio } from './playbackAudioBalance';
import { setRoomAudioBalance, setRoomAudioVolume, toggleRoomAudio } from './audio';
import { useIdleControls } from './useIdleControls';
import { useDanmaku } from './danmaku/useDanmaku';
import { DanmakuOverlay } from './danmaku/DanmakuOverlay';
import { DanmakuSidebar } from './danmaku/DanmakuSidebar';
import { roomDanmakuStyle, type DanmakuPreferences, type RoomDanmakuPreference } from './danmaku/displayPreferences';
import { BilibiliRoomMetadataAdapter, mergeCustomRoom, type CustomRoomRecord } from './customRooms';
import { CustomRoomRefreshScheduler } from './customRoomRefresh';
import { readRoomLibrary, writeRoomLibrary, upsertLibraryRoom, saveLibraryRoom, removeSavedRoom,
  pruneRoomLibrary, mergeLibraryMetadata, type RoomLibrary } from './roomLibrary';
import { RoomLibraryPicker } from './RoomLibraryPicker';
import { useFollowingRooms } from './useFollowingRooms';
import { mergeFollowingMetadata } from './followingMetadata';
import './multiview.css';

type SidebarTab = 'rooms' | 'layouts' | 'audio' | 'danmaku' | 'settings';
type ScreenMode = 'desktop' | 'portrait' | 'landscape';
type PlaybackState = { status: PlayerStatus; message?: string };
type RemovedRoomConfig = { room: RoomPlaybackPreference; danmaku: RoomDanmakuPreference; paused: boolean; route: string | null };
type PlacementUndo = { id: number; kind: 'replace' | 'layout' | 'adaptive'; layoutId: string; roomIds: string[]; slotRoomIds: RoomSlot[];
  viewOffset: number; focusId: string | null; activeId: string | null; removedRooms: Record<string, RemovedRoomConfig>;
  message: string; expectedKey: string; revision: string | undefined; adaptiveGridEnabled?: boolean };
const placementStructure = (layoutId: string, ids: readonly string[], slots: readonly RoomSlot[], offset: number, focus: string | null, mode: ScreenMode) =>
  JSON.stringify([layoutId, ids, slots, offset, focus, mode]);
const selectionStructure = (layoutId: string, ids: readonly string[], slots: readonly RoomSlot[]) => JSON.stringify([layoutId, ids, slots]);
const statusLabel: Record<PlayerStatus, string> = { loading: '正在连接', playing: '播放中', stalled: '播放停滞', 'autoplay-blocked': '等待点击播放', paused: '已暂停', offline: '未开播', restricted: '暂不可播放', retrying: '正在重连', error: '播放失败', unsupported: '浏览器暂不支持' };
function currentScreenMode(): ScreenMode {
  if (typeof window === 'undefined') return 'desktop';
  const small = window.innerWidth <= 760 || (window.innerHeight <= 520 && window.innerWidth <= 1024)
    || (window.innerWidth <= 1024 && window.matchMedia('(pointer: coarse)').matches);
  return small ? (window.innerWidth > window.innerHeight ? 'landscape' : 'portrait') : 'desktop';
}
function currentScreenProfile() {
  return {
    mode: currentScreenMode(),
    touchOnly: typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches
      && !window.matchMedia('(any-pointer: fine)').matches,
  };
}
function useScreenMode(adaptiveGridEnabled: boolean) {
  const [profile, setProfile] = useState(currentScreenProfile);
  useEffect(() => {
    const coarse = window.matchMedia('(pointer: coarse)');
    const fine = window.matchMedia('(any-pointer: fine)');
    const update = () => {
      const next = currentScreenProfile();
      setProfile(previous => previous.mode === next.mode && previous.touchOnly === next.touchOnly ? previous : next);
    };
    window.addEventListener('resize', update);
    coarse.addEventListener('change', update);
    fine.addEventListener('change', update);
    return () => {
      window.removeEventListener('resize', update);
      coarse.removeEventListener('change', update);
      fine.removeEventListener('change', update);
    };
  }, []);
  // A narrow desktop window is still a full adaptive grid. Only touch-first
  // devices without a fine pointer retain the one/two-player mobile window.
  // Derive this during render so mode switches cannot briefly hide players.
  return adaptiveGridEnabled && !profile.touchOnly ? 'desktop' : profile.mode;
}
function LayoutPreview({ layout }: { layout: MultiviewLayout }) {
  return <span className="mv-layout-preview" style={layoutGridStyle(layout)} aria-hidden="true">{SLOT_AREAS.slice(0, layout.count).map(area => <i key={area} style={{ gridArea: area }} />)}</span>;
}
export function MultiviewPanel() {
  const localLogin = useLocalLogin();
  const localTransport = useLocalLoginTransport();
  const resolveAudioPlayback = useMemo(() => createLocalAudioResolver(localTransport), [localTransport]);
  const audioCapabilityKey = localLogin.capabilities?.includes('audio-playback') ? localLogin.bridgeReadyId : undefined;
  useLayoutEffect(() => {
    if (audioCapabilityKey) invalidateLocalAudioCapability(localTransport());
  }, [audioCapabilityKey, localTransport]);
  const resolverRef = useRef(localLogin.resolvePlayback);
  resolverRef.current = localLogin.resolvePlayback;
  const requestBudget = pagePlaybackRequestBudget;
  const requestPool = useMemo(() => new PlaybackRequestPool(async request => {
    if (!resolverRef.current) throw new Error('请先安装并连接浏览器扩展');
    return resolverRef.current(request);
  }, 2, requestBudget), [localLogin.authSessionKey, requestBudget]);
  useLayoutEffect(() => () => requestPool.dispose(), [requestPool]);
  const formatProbe = useMemo(() => typeof document === 'undefined' ? null : document.createElement('video'), []);
  const supportsBranch = useCallback((source: Pick<PlaybackSource, 'protocol' | 'format'>) =>
    !formatProbe || supportsPlaybackSource(formatProbe, source), [formatProbe]);
  useLayoutEffect(() => {
    const existing = document.head.querySelector<HTMLMetaElement>('meta[name="referrer"]');
    const meta = existing ?? document.createElement('meta');
    const original = existing?.getAttribute('content');
    meta.name = 'referrer';
    meta.content = 'no-referrer';
    if (!existing) document.head.appendChild(meta);
    return () => {
      if (!existing) meta.remove();
      else if (original === null) meta.removeAttribute('content');
      else meta.content = original!;
    };
  }, []);
  const [preferences, setPreferences] = useState(() => readMultiviewPreferences());
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('rooms');
  const [followingBrowse, setFollowingBrowse] = useState(false);
  const [loginSetupRequest, setLoginSetupRequest] = useState<LocalAccountSetupRequest | null>(null);
  const loginSetupSequence = useRef(0);
  const [chatHasDrafts, setChatHasDrafts] = useState(false);
  const [danmakuPublishedView, setDanmakuPublishedView] = useState<'danmaku' | 'sc' | 'none'>('danmaku');
  const [library, setLibrary] = useState<RoomLibrary>(() => readRoomLibrary());
  const libraryRef = useRef(library);
  libraryRef.current = library;
  const [saveUndo, setSaveUndo] = useState<{ id: number; room: MonitorRoomDescriptor; binding: 'custom'; message: string } | null>(null);
  const customAdapterRef = useRef<BilibiliRoomMetadataAdapter | null>(null);
  const customRefreshRef = useRef<CustomRoomRefreshScheduler | null>(null);
  const [focusedRoomId, setFocusedRoomId] = useState<string | null>(null);
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const [viewOffset, setViewOffset] = useState(0);
  const [pausedRooms, setPausedRooms] = useState<Record<string, boolean>>({});
  const [refreshTokens, setRefreshTokens] = useState<Record<string, number>>({});
  const [playbackInfos, setPlaybackInfos] = useState<Record<string, PlaybackInfo>>({});
  const [playbackInfoScopes, setPlaybackInfoScopes] = useState<Record<string, string>>({});
  const [mediaOptionsStates, setMediaOptionsStates] = useState<Record<string, PlaybackOptionsState>>({});
  const [playbackSources, setPlaybackSources] = useState<Record<string, PlaybackSource>>({});
  const [playbackSourceScopes, setPlaybackSourceScopes] = useState<Record<string, string>>({});
  const [pendingSources, setPendingSources] = useState<Record<string, PlaybackSource | null>>({});
  const [routeSelections, setRouteSelections] = useState<Record<string, { key: string | null; info: PlaybackInfo; token: number }>>({});
  const [preferredRoutes, setPreferredRoutes] = useState<Record<string, string | null>>({});
  const [playbackStates, setPlaybackStates] = useState<Record<string, PlaybackState>>({});
  const [audioDeliveries, setAudioDeliveries] = useState<Record<string, 'audio-only' | 'full-stream' | null>>({});
  const [balanceUnavailableRooms, setBalanceUnavailableRooms] = useState<ReadonlySet<string>>(new Set());
  const [autoplayResumers, setAutoplayResumers] = useState<Record<string, () => void>>({});
  const mediaIdentity = JSON.stringify(['local']);
  const [mediaStateIdentity, setMediaStateIdentity] = useState(mediaIdentity);
  useLayoutEffect(() => {
    setPlaybackInfos({}); setPlaybackInfoScopes({}); setMediaOptionsStates({}); setPlaybackSources({}); setPlaybackSourceScopes({});
    setPendingSources({}); setRouteSelections({}); setPreferredRoutes({}); setPlaybackStates({});
    setAutoplayResumers({}); setAudioDeliveries({}); setBalanceUnavailableRooms(new Set()); setMediaStateIdentity(mediaIdentity);
  }, ['local']);
  useLayoutEffect(() => {
    const allowed = (scope?: string) => scope === 'anonymous' || scope === localLogin.authSessionKey;
    setPlaybackInfos(value => Object.fromEntries(Object.entries(value).filter(([id]) => allowed(playbackInfoScopes[id]))));
    setPlaybackSources(value => Object.fromEntries(Object.entries(value).filter(([id]) => allowed(playbackSourceScopes[id]))));
    setPlaybackStates(value => Object.fromEntries(Object.entries(value).filter(([id]) => allowed(playbackSourceScopes[id]))));
    setAutoplayResumers(value => Object.fromEntries(Object.entries(value).filter(([id]) => allowed(playbackSourceScopes[id]))));
    setPendingSources({}); setRouteSelections({}); setMediaOptionsStates({});
  }, [localLogin.authSessionKey]);
  const [fullscreen, setFullscreen] = useState(false);
  const [pageVisible, setPageVisible] = useState(() => !document.hidden);
  const following = useFollowingRooms(followingBrowse && preferences.sidebarOpen && sidebarTab === 'rooms' && pageVisible);
  const followingRef = useRef(following);
  followingRef.current = following;
  const [notice, setNoticeState] = useState<{ text: string; visible: boolean } | null>(null);
  const setNotice = useCallback((text: string) => setNoticeState({ text, visible: true }), []);
  const [storageError, setStorageError] = useState(false);
  const [previewSlots, setPreviewSlots] = useState<RoomSlot[] | null>(null);
  const [resizingSidebar, setResizingSidebar] = useState(false);
  const [danmakuRoomId, setDanmakuRoomId] = useState<string | null>(null);
  const [placementDraft, setPlacementDraft] = useState<PlacementDraft | null>(null);
  const placementDraftRef = useRef<PlacementDraft | null>(null);
  const [placementUndo, setPlacementUndo] = useState<PlacementUndo | null>(null);
  const [placementAnnouncement, setPlacementAnnouncement] = useState('');
  const [ghostRoomId, setGhostRoomId] = useState<string | null>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const ghostAnimation = useRef<Animation | null>(null);
  const finishGeometry = useRef<{ target: DOMRect | null; source: DOMRect } | null>(null);
  const screenMode = useScreenMode(preferences.adaptiveGridEnabled);
  const rootRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const tileRefs = useRef(new Map<string, HTMLElement>());
  const savedViewOffset = useRef(0);
  const sidebarResize = useRef<{ x: number; width: number; direction: number } | null>(null);
  const observedLiveRooms = useRef(new Map<string, boolean>());
  const [gridSize, setGridSize] = useState({ width: 0, height: 0 });
  useModalLayer(fullscreen, rootRef);
  const ready = true;
  const followingById = useMemo(() => new Map(following.rooms.map(room => [room.roomId, room])), [following.rooms]);
  const followingTrustedIds = useMemo(() => new Set(following.trustedRoomIds), [following.trustedRoomIds]);
  const savedIds = useMemo(() => new Set(library.savedRoomIds), [library.savedRoomIds]);
  const customRooms = useMemo(() => Object.values(library.roomsById)
    .filter(entry => entry.binding === 'custom'
      && (savedIds.has(entry.room.roomId) || preferences.roomIds.includes(entry.room.roomId)))
    .map(entry => mergeFollowingMetadata(entry.room, followingById.get(entry.room.roomId), followingTrustedIds.has(entry.room.roomId))), [library, savedIds, preferences.roomIds, followingById, followingTrustedIds]);
  // Undo retains identities, not polling/media demand. An unsaved custom room
  // removed by replacement must remain eligible for the bounded undo action.
  const undoRooms = useMemo(() => (placementUndo?.roomIds ?? [])
    .filter(id => library.roomsById[id]?.binding === 'custom' && !customRooms.some(room => room.roomId === id))
    .map(id => mergeFollowingMetadata(library.roomsById[id].room, followingById.get(id), followingTrustedIds.has(id))), [placementUndo, library.roomsById, customRooms, followingById, followingTrustedIds]);
  const followingDisplayRooms = useMemo(() => {
    const known = new Map([...customRooms].map(room => [room.roomId, room]));
    return following.rooms.map(room => mergeFollowingMetadata(room, known.get(room.roomId), 'public-room'));
  }, [following.rooms, customRooms]);
  const followingView = useMemo(() => ({ ...following, rooms: followingDisplayRooms }), [following, followingDisplayRooms]);
  const allowedRooms = useMemo<MonitorRoomDescriptor[]>(() => {
    const rooms = [...customRooms, ...undoRooms];
    const existing = new Set(rooms.map(room => room.roomId));
    // Browsing does not save the account's follow graph. Only an explicit
    // watch/save/drop stores a public room snapshot through the existing path.
    return [...rooms, ...followingDisplayRooms.filter(room => !existing.has(room.roomId))];
  }, [customRooms, undoRooms, followingDisplayRooms, library.roomsById]);
  const roomById = useMemo(() => new Map(allowedRooms.map(room => [room.roomId, room])), [allowedRooms]);
  const allowedIds = useMemo(() => new Set(allowedRooms.map(room => room.roomId)), [allowedRooms]);
  const savedRooms = library.savedRoomIds.map(id => roomById.get(id) ?? library.roomsById[id]?.room)
    .filter((room): room is MonitorRoomDescriptor => Boolean(room));
  const unavailableIds = new Set(Object.keys(library.roomsById).filter(id => !allowedIds.has(id)));
  const selectedIds = ready ? preferences.roomIds.filter(id => allowedIds.has(id)) : [];
  const selectedRef = useRef(selectedIds);
  selectedRef.current = selectedIds;
  const refreshPlan = useMemo(() => {
    const rooms = new Map(customRooms.map(room => [room.roomId, room]));
    const baseDemand = new Set(rooms.keys());
    const browseDemand = new Set<string>();
    const visibleFollowing = new Set(following.visibleRoomIds.slice(0, 32));
    for (const room of followingDisplayRooms) {
      // Keep directory entries in the scheduler while scrolling, preserving
      // per-room cooldown. Only current demand creates network work.
      if (following.roomInfoAvailable) {
        if (!rooms.has(room.roomId)) rooms.set(room.roomId, { ...room, source: 'custom', input: room.input ?? room.roomId });
        if (selectedIds.includes(room.roomId)) baseDemand.add(room.roomId);
        else if (followingBrowse && preferences.sidebarOpen && sidebarTab === 'rooms' && visibleFollowing.has(room.roomId)
          && (room.status === 'live' || (!room.cover && !followingTrustedIds.has(room.roomId)))) browseDemand.add(room.roomId);
      }
    }
    return { rooms: [...rooms.values()], baseDemand, browseDemand, selectedIds: new Set(selectedIds) };
  }, [customRooms, followingDisplayRooms, following.visibleRoomIds, following.roomInfoAvailable, followingTrustedIds,
    library.roomsById, selectedIds.join(','), followingBrowse, preferences.sidebarOpen, sidebarTab]);
  const refreshPlanRef = useRef(refreshPlan);
  refreshPlanRef.current = refreshPlan;
  const routeCommitGuard = useMemo(() => new PlaybackRouteCommitGuard(), []);
  routeCommitGuard.update(JSON.stringify([localLogin.authSessionKey, localLogin.resolutionScope, 'local']), selectedIds, roomById);
  const selectedKey = selectedIds.join(',');
  const bindingKey = selectedIds.map(id => `${id}:${roomById.get(id)?.source ?? 'custom'}`).join(',');
  const playbackBindings = useRef(new Map<string, string>());
  useLayoutEffect(() => {
    const changed = new Set(selectedIds.filter(id => playbackBindings.current.has(id)
      && playbackBindings.current.get(id) !== roomById.get(id)?.source));
    playbackBindings.current = new Map(selectedIds.map(id => [id, roomById.get(id)?.source ?? 'custom']));
    if (!changed.size) return;
    const retain = <T,>(values: Record<string, T>) => Object.fromEntries(Object.entries(values).filter(([id]) => !changed.has(id)));
    setPlaybackInfos(retain); setPlaybackInfoScopes(retain); setMediaOptionsStates(retain); setPlaybackSources(retain); setPlaybackSourceScopes(retain);
    setPendingSources(retain); setRouteSelections(retain); setPreferredRoutes(retain); setAutoplayResumers(retain);
  }, [bindingKey]);
  const selectedSet = new Set(selectedIds);
  const commitLibrary = (next: RoomLibrary, retainRuntimeOnFailure = false) => {
    if (next === libraryRef.current) return true;
    if (!writeRoomLibrary(next)) {
      // Directory authority must take effect even when browser storage is full.
      // User save/remove operations still leave their original state intact.
      if (retainRuntimeOnFailure) { libraryRef.current = next; setLibrary(next); }
      setStorageError(true); setNotice('本地房间记录写入失败，请重试；当前观看不受影响'); return false;
    }
    libraryRef.current = next; setLibrary(next); return true;
  };
  const activeId = activeRoomId && selectedSet.has(activeRoomId) ? activeRoomId : selectedIds[0] ?? null;
  const focusId = focusedRoomId && selectedSet.has(focusedRoomId) ? focusedRoomId : null;
  const layout = findLayout(preferences.layoutId);
  const adaptiveGridActive = preferences.adaptiveGridEnabled && screenMode === 'desktop' && !focusId;
  const baseSlots = normalizeSlotRoomIds(preferences.slotRoomIds, selectedIds, layout.count);
  const previewIds = previewSlots?.filter((id): id is string => id !== null);
  const validPreview = previewIds?.length === selectedIds.length
    && new Set(previewIds).size === selectedIds.length && previewIds.every(id => selectedSet.has(id));
  const slotRoomIds = adaptiveGridActive
    ? (previewSlots && validPreview ? previewSlots : selectedIds)
    : (previewSlots && previewSlots.length === baseSlots.length && validPreview ? previewSlots : baseSlots);
  const adaptiveLayout: AdaptiveGridLayout | null = adaptiveGridActive
    ? getAdaptiveGridLayout(selectedIds.length, gridSize.width, gridSize.height, preferences.gridGap) : null;
  const capacity = screenMode === 'portrait' ? 1 : screenMode === 'landscape' ? 2 : layout.count;
  const visibleSlots = adaptiveGridActive ? slotRoomIds : focusId ? [focusId] : screenMode === 'desktop' ? visibleWindow(slotRoomIds, capacity, viewOffset)
    : visibleWindow(selectedIds, capacity, Math.max(0, selectedIds.indexOf(activeId ?? '')));
  const visibleIds = visibleSlots.filter((id): id is string => id !== null);
  const visibleSet = new Set(visibleIds);
  const tileRenderIds = selectedIds;
  const displayLayout = focusId || screenMode === 'portrait' ? layoutForCount(1) : screenMode === 'landscape' ? findLayout('two-wide') : layout;
  const motionKey = `${selectedKey}|${visibleSlots.join(',')}|${displayLayout.id}|${adaptiveGridActive ? 'adaptive' : 'fixed'}|${focusId ?? ''}|${screenMode}|${fullscreen}|${preferences.switchbarTop}|${preferences.sidebarSide}|${preferences.gridGap}|${previewSlots?.join(',') ?? ''}`;
  const { captureLayout } = usePanelMotion(rootRef, motionKey, adaptiveLayout?.signature ?? '');
  useLayoutEffect(() => {
    const element = gridRef.current;
    // Fixed layouts need no adaptive calculation or panel-wide React updates
    // as the sidebar/window resizes. Native grid tracks stay exactly aligned.
    if (!element || !adaptiveGridActive) return;
    let frame: number | null = null;
    let measured = gridSize.width > 0 && gridSize.height > 0;
    let topology = adaptiveLayout ? `${adaptiveLayout.columns}x${adaptiveLayout.rows}` : '';
    const measure = () => {
      frame = null;
      const next = { width: element.clientWidth, height: element.clientHeight };
      const layout = getAdaptiveGridLayout(selectedIds.length, next.width, next.height, preferences.gridGap);
      const nextTopology = `${layout.columns}x${layout.rows}`;
      if (nextTopology === topology && measured) return;
      topology = nextTopology;
      measured = true;
      // A canvas resize may change the row/column topology, but it must not
      // replay a slot-exchange animation. The geometry key only synchronizes
      // the motion baseline; intentional watching/layout actions still FLIP.
      setGridSize(next);
    };
    const schedule = () => { if (frame === null) frame = window.requestAnimationFrame(measure); };
    measure();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
    observer?.observe(element);
    return () => { observer?.disconnect(); if (frame !== null) window.cancelAnimationFrame(frame); };
  }, [adaptiveGridActive, selectedIds.length, preferences.gridGap]);
  const { dragVisual, onPointerDown: startTilePointer, suppressClick, shouldSuppressClick, cancelDrag, isDragging } = useTileReorder({
    roomIds: selectedIds, slotRoomIds: adaptiveGridActive ? selectedIds : baseSlots, visibleSlots, windowOffset: viewOffset,
    adaptive: adaptiveGridActive,
    contextKey: `${layout.id}|${adaptiveLayout?.signature ?? ''}|${focusId ?? ''}|${screenMode}|${fullscreen}|${preferences.playbackMode}|${preferences.stopHidden}|${preferences.sidebarSide}|${preferences.sidebarOpen}|${preferences.switchbarTop}|${preferences.gridGap}|${'local'}|${ready}`,
    enabled: !placementDraft && !resizingSidebar && screenMode === 'desktop' && !focusId && visibleIds.length > 0 && (adaptiveGridActive || layout.count > 1) && (!document.fullscreenElement || document.fullscreenElement === rootRef.current),
    tileRefs, gridRef, captureLayout, onPreview: setPreviewSlots,
    onCommit: slots => setPreferences(value => {
      const ids = slots.filter((id): id is string => id !== null);
      if (ids.length !== value.roomIds.length || new Set(ids).size !== ids.length || !ids.every(id => value.roomIds.includes(id))) return value;
      return { ...value, slotRoomIds: normalizeSlotRoomIds(slots, value.roomIds, findLayout(value.layoutId).count) };
    }),
    onCommitOrder: roomIds => setPreferences(value => ({ ...value, roomIds })),
  });
  const structureKey = placementStructure(adaptiveLayout ? `${layout.id}|${adaptiveLayout.signature}` : layout.id,
    selectedIds, baseSlots, viewOffset, focusId, screenMode);
  const undoStructureKey = placementUndo?.kind === 'layout' || placementUndo?.kind === 'adaptive' ? selectionStructure(layout.id, selectedIds, baseSlots) : structureKey;
  const placementContextKey = `${structureKey}|${preferences.adaptiveGridEnabled}|${'local'}|${ready}|${fullscreen}|${preferences.sidebarSide}|${preferences.switchbarTop}|${preferences.sidebarOpen}|${preferences.playbackMode}|${preferences.stopHidden}|${preferences.gridGap}`;
  const placementOffset = focusId ? savedViewOffset.current : viewOffset;
  const placementSlots = visibleWindow(baseSlots, layout.count, placementOffset);
  const placementPlan = (index: number) => planRoomPlacement({ roomIds: selectedIds, slotRoomIds: baseSlots, capacity: layout.count,
    viewOffset: placementOffset, roomId: placementDraftRef.current?.roomId ?? '', targetIndex: index });
  const setDraft = (draft: PlacementDraft | null) => { placementDraftRef.current = draft; setPlacementDraft(draft); };
  const settleGhost = (accepted: boolean) => {
    const node = ghostRef.current, geometry = finishGeometry.current;
    finishGeometry.current = null;
    ghostAnimation.current?.cancel(); ghostAnimation.current = null;
    if (!node) { setGhostRoomId(null); return; }
    node.dataset.dragging = 'false';
    const clear = () => { delete node.dataset.settling; setGhostRoomId(null); };
    if (document.hidden || window.matchMedia('(prefers-reduced-motion: reduce)').matches || !node.getBoundingClientRect().width) { clear(); return; }
    const destination = accepted ? geometry?.target : geometry?.source;
    const from = node.style.transform, width = node.offsetWidth, height = node.offsetHeight;
    const scale = destination?.width && destination.height ? Math.min(destination.width / width, destination.height / height, 1.3) : .9;
    const to = destination?.width && destination.height
      ? `translate3d(${destination.left + (destination.width - width * scale) / 2}px, ${destination.top + (destination.height - height * scale) / 2}px, 0) scale(${scale})` : `${from} scale(.9)`;
    node.dataset.settling = 'true';
    const animation = node.animate([{ transform: from, opacity: 1 }, { transform: to, opacity: 0 }],
      { duration: accepted ? 280 : 180, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'both' });
    ghostAnimation.current = animation;
    void animation.finished.then(() => { if (ghostAnimation.current !== animation) return; ghostAnimation.current = null; animation.cancel(); clear(); }, () => {});
  };
  const cancelPlacement = () => { settleGhost(false); setDraft(null); };
  const beginPlacement = (roomId: string) => {
    if (!ready || !allowedIds.has(roomId) || document.fullscreenElement && document.fullscreenElement !== rootRef.current) return;
    ghostAnimation.current?.cancel(); ghostAnimation.current = null;
    if (ghostRef.current) { delete ghostRef.current.dataset.settling; ghostRef.current.dataset.dragging = 'false'; }
    finishGeometry.current = null;
    setGhostRoomId(roomId);
    setDraft({ roomId, targetIndex: null, contextKey: placementContextKey });
  };
  const commitPlacement = (index: number) => {
    const draft = placementDraftRef.current;
    if (!draft || draft.contextKey !== placementContextKey || !ready || !allowedIds.has(draft.roomId)) { cancelPlacement(); return; }
    if (adaptiveGridActive) {
      const sourceId = draft.roomId;
      const currentIds = [...selectedIds];
      const sourceIndex = currentIds.indexOf(sourceId);
      const added = sourceIndex < 0;
      if (added && currentIds.length >= MAX_ADAPTIVE_GRID_ROOMS) {
        setNotice(`平均网格最多同时观看 ${MAX_ADAPTIVE_GRID_ROOMS} 个直播间`);
        settleGhost(false); setDraft(null); return;
      }
      const targetIndex = Number.isInteger(index) && index >= 0 ? Math.min(index, currentIds.length) : currentIds.length;
      let nextIds = [...currentIds];
      if (added) nextIds.splice(targetIndex, 0, sourceId);
      else if (sourceIndex !== targetIndex && targetIndex < currentIds.length) nextIds = swapRoomSlots(currentIds, sourceIndex, targetIndex).filter((id): id is string => id !== null);
      if (nextIds.join(',') === currentIds.join(',')) {
        settleGhost(false); setDraft(null); setPlacementAnnouncement('房间已经位于此处，布局未改变'); return;
      }
      captureLayout();
      const sourceRoom = roomById.get(sourceId);
      if (added && sourceRoom && !commitLibrary(upsertLibraryRoom(libraryRef.current, sourceRoom))) {
        settleGhost(false); setDraft(null); return;
      }
      setPreferences(value => {
        const retained = retainAllowedRooms(value, new Set(nextIds));
        return { ...retained, roomIds: nextIds,
          rooms: added ? { ...retained.rooms, [sourceId]: defaultRoomPreference() } : retained.rooms,
          danmaku: added ? { ...retained.danmaku, rooms: { ...retained.danmaku.rooms,
            [sourceId]: { enabled: sourceRoom?.status === 'live' } } } : retained.danmaku };
      });
      setActiveRoomId(sourceId);
      setPlacementAnnouncement(`${sourceRoom?.anchorName || sourceId}${added ? '已加入平均网格' : '已与第 ' + (targetIndex + 1) + ' 格交换'}`);
      settleGhost(true); setDraft(null); return;
    }
    const result = placementPlan(index);
    if (!result.ok) { setNotice(placementDescription(result, roomById)); settleGhost(false); setDraft(null); return; }
    if (result.action === 'noop') { settleGhost(false); setDraft(null); setPlacementAnnouncement('房间已经位于此处，布局未改变'); return; }
    captureLayout();
    const oldId = result.replacedRoomId;
    setPlacementUndo(oldId ? { id: performance.now(), kind: 'replace', layoutId: layout.id,
      roomIds: [...selectedIds], slotRoomIds: [...baseSlots], viewOffset, focusId, activeId,
      removedRooms: { [oldId]: { room: preferences.rooms[oldId] ?? defaultRoomPreference(), danmaku: preferences.danmaku.rooms[oldId] ?? { enabled: false },
        paused: Boolean(pausedRooms[oldId]), route: preferredRoutes[oldId] ?? null } }, revision: 'local',
      message: `已替换${roomById.get(oldId)?.anchorName || oldId}`,
      expectedKey: placementStructure(layout.id, result.roomIds, result.slotRoomIds, result.viewOffset, null, screenMode) } : null);
    const added = !selectedSet.has(draft.roomId);
    setPreferences(value => {
      const retained = retainAllowedRooms(value, new Set(result.roomIds));
      return { ...retained, roomIds: result.roomIds, slotRoomIds: result.slotRoomIds,
        sidebarOpen: screenMode === 'desktop' ? value.sidebarOpen : false,
        rooms: added ? { ...retained.rooms, [draft.roomId]: defaultRoomPreference() } : retained.rooms,
        danmaku: added ? { ...retained.danmaku, rooms: { ...retained.danmaku.rooms,
          [draft.roomId]: { enabled: roomById.get(draft.roomId)?.status === 'live' } } } : retained.danmaku };
    });
    setViewOffset(result.viewOffset); savedViewOffset.current = result.viewOffset;
    setFocusedRoomId(null); setActiveRoomId(draft.roomId);
    setPlacementAnnouncement(`${roomById.get(draft.roomId)?.anchorName || draft.roomId}已放置到第 ${index + 1} 格，${placementDescription(result, roomById)}`);
    settleGhost(true); setDraft(null);
  };
  const sidebarDrag = useSidebarRoomDrag({ enabled: ready && screenMode === 'desktop' && !resizingSidebar,
    contextKey: placementContextKey, gridRef, ghostRef, onStart: beginPlacement,
    onTarget: index => { const draft = placementDraftRef.current; if (draft) setDraft({ ...draft, targetIndex: index }); },
    onDrop: commitPlacement, onCancel: cancelPlacement, allowBackgroundDrop: adaptiveGridActive,
    onFinish: (_outcome, target, source) => { finishGeometry.current = { target, source }; },
  });
  const undoPlacement = () => {
    const undo = placementUndo;
    if (!undo || undo.expectedKey !== undoStructureKey || undo.revision !== 'local' || !undo.roomIds.every(id => allowedIds.has(id))) { setPlacementUndo(null); return; }
    sidebarDrag.cancelDrag(); cancelPlacement(); captureLayout();
    setPreferences(value => {
      const retained = retainAllowedRooms(value, new Set(undo.roomIds));
      return { ...retained, layoutId: undo.layoutId, roomIds: undo.roomIds, slotRoomIds: undo.slotRoomIds,
        adaptiveGridEnabled: undo.adaptiveGridEnabled ?? retained.adaptiveGridEnabled,
        rooms: { ...retained.rooms, ...Object.fromEntries(Object.entries(undo.removedRooms).map(([id, config]) => [id, config.room])) },
        danmaku: { ...retained.danmaku, rooms: { ...retained.danmaku.rooms,
          ...Object.fromEntries(Object.entries(undo.removedRooms).map(([id, config]) => [id, config.danmaku])) } } };
    });
    setPausedRooms(value => ({ ...value, ...Object.fromEntries(Object.entries(undo.removedRooms).map(([id, config]) => [id, config.paused])) }));
    setPreferredRoutes(value => ({ ...value, ...Object.fromEntries(Object.entries(undo.removedRooms).map(([id, config]) => [id, config.route])) }));
    setViewOffset(undo.viewOffset); savedViewOffset.current = undo.viewOffset;
    setFocusedRoomId(undo.focusId); setActiveRoomId(undo.activeId); setPlacementUndo(null);
    setPlacementAnnouncement(undo.kind === 'layout' ? '已撤销布局切换，恢复原布局和移除的直播间' : undo.kind === 'adaptive' ? '已撤销平均网格关闭，恢复移除的直播间' : '已撤销替换，恢复原房间和位置');
  };
  useLayoutEffect(() => {
    if (placementDraftRef.current && placementDraftRef.current.contextKey !== placementContextKey) {
      sidebarDrag.cancelDrag(); cancelPlacement();
    }
    if (placementUndo && (placementUndo.expectedKey !== undoStructureKey || placementUndo.revision !== 'local')) setPlacementUndo(null);
  }, [placementContextKey]);
  useEffect(() => {
    const stop = () => { sidebarDrag.cancelDrag(); ghostAnimation.current?.cancel(); ghostAnimation.current = null;
      if (ghostRef.current) { delete ghostRef.current.dataset.settling; ghostRef.current.dataset.dragging = 'false'; }
      setGhostRoomId(null);
      setDraft(null);
    };
    const visibility = () => { if (document.hidden) stop(); };
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const reduce = () => { if (reduced.matches) stop(); };
    window.addEventListener('blur', stop); document.addEventListener('visibilitychange', visibility); document.addEventListener('fullscreenchange', stop); reduced.addEventListener('change', reduce);
    return () => { ghostAnimation.current?.cancel(); window.removeEventListener('blur', stop); document.removeEventListener('visibilitychange', visibility); document.removeEventListener('fullscreenchange', stop); reduced.removeEventListener('change', reduce); };
  }, []);
  const roomPreference = (id: string) => preferences.rooms[id] ?? defaultRoomPreference();
  const blockedRoomIds = mediaStateIdentity === mediaIdentity ? selectedIds.filter(id => {
    const active = roomPreference(id).mediaMode === 'audio' || visibleSet.has(id) || (screenMode === 'desktop' && !preferences.stopHidden);
    return active && !pausedRooms[id] && roomById.get(id)?.status === 'live'
      && playbackStates[id]?.status === 'autoplay-blocked' && Boolean(autoplayResumers[id]);
  }) : [];
  const loginStreamReady = localLogin.enabled && localLogin.connected && localLogin.authorizationCurrent
    && mediaStateIdentity === mediaIdentity && selectedIds.some(id => roomById.get(id)?.status === 'live'
      && !pausedRooms[id] && !pendingSources[id] && Boolean(playbackSources[id]) && playbackInfos[id]?.status === 'live'
      && playbackSourceScopes[id] === localLogin.authSessionKey
      && ['playing', 'stalled'].includes(playbackStates[id]?.status ?? ''));
  const controlsHidden = useIdleControls(rootRef, preferences.autoHideControls, isDragging || resizingSidebar || Boolean(placementDraft) || blockedRoomIds.length > 0);
  const currentDanmakuRoom = danmakuRoomId && selectedSet.has(danmakuRoomId) ? danmakuRoomId : activeId;
  const danmakuRoomIds = visibleIds.filter(id => preferences.danmaku.rooms[id]?.enabled && !pausedRooms[id] && roomById.get(id)?.status === 'live');
  if (preferences.sidebarOpen && sidebarTab === 'danmaku' && currentDanmakuRoom && !danmakuRoomIds.includes(currentDanmakuRoom)) danmakuRoomIds.push(currentDanmakuRoom);
  const roomSources = Object.fromEntries(selectedIds.map(id => [id, roomById.get(id)?.source ?? 'custom'])) as Record<string, 'custom'>;
  const localChat = useLocalChat(roomSources, currentDanmakuRoom, {
    autoWearRoomMedal: preferences.danmaku.autoWearRoomMedal === true,
    active: preferences.sidebarOpen && sidebarTab === 'danmaku' && !controlsHidden && pageVisible,
  });
  const openAccountSetup = (feature: LocalAccountSetupFeature) => {
    setLoginSetupRequest({ id: ++loginSetupSequence.current, feature, context: localAccountSetupContext(localLogin) });
    setSidebarTab('settings'); setPreferences(value => ({ ...value, sidebarOpen: true }));
  };
  const completeAccountSetupRequest = useCallback((id: number) => {
    setLoginSetupRequest(current => current?.id === id ? null : current);
  }, []);
  const openChatSetup = () => openAccountSetup('chat');
  const chatAdapter = { ...localChat.chat, openSetup: openChatSetup, enable: openChatSetup, openMedalSetup: () => openAccountSetup('medals'), onDraftPresenceChange: setChatHasDrafts };
  const danmaku = useDanmaku({ roomIds: danmakuRoomIds, retainedRoomIds: ready ? selectedIds : [], roomSources, visibilityRevision: 'local',
    identityScope: localChat.scope, bootstrapReady: localChat.ready, resolveBootstrap: localChat.local ? localChat.bootstrap : undefined,
    publishedRoomId: currentDanmakuRoom,
    publishedView: preferences.sidebarOpen && sidebarTab === 'danmaku' && !controlsHidden ? danmakuPublishedView : 'none',
    currentChatRoomId: preferences.sidebarOpen && sidebarTab === 'danmaku' ? currentDanmakuRoom : null, priorityRoomId: focusId });

  useEffect(() => { if (ready) setPreferences(value => retainAllowedRooms(value, allowedIds)); }, [allowedIds, ready]);
  useEffect(() => {
    const update = () => setPageVisible(!document.hidden);
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  useEffect(() => {
    if (!ready) return;
    const previous = observedLiveRooms.current, next = new Map<string, boolean>(), started: string[] = [];
    for (const id of selectedIds) {
      const status = roomById.get(id)?.status;
      if (status === 'live') {
        if (previous.get(id) === false) started.push(id);
        next.set(id, true);
      } else next.set(id, status === 'offline' ? false : previous.get(id) ?? false);
    }
    observedLiveRooms.current = next;
    if (!started.length) return;
    setPreferences(value => {
      const ids = started.filter(id => value.roomIds.includes(id) && !value.danmaku.rooms[id]?.enabled);
      if (!ids.length) return value;
      return { ...value, danmaku: { ...value.danmaku, rooms: { ...value.danmaku.rooms,
        ...Object.fromEntries(ids.map(id => [id, { ...value.danmaku.rooms[id], enabled: true }])) } } };
    });
    // Unknown refreshes retain the last live state, so transient API failures
    // cannot override a deliberate manual disable in the current broadcast.
  }, [ready, selectedKey, roomById]);
  useEffect(() => {
    const undoIds = [...(placementUndo?.roomIds ?? []), ...(saveUndo ? [saveUndo.room.roomId] : [])];
    commitLibrary(pruneRoomLibrary(libraryRef.current, preferences.roomIds, undoIds), true);
  }, [preferences.roomIds, placementUndo, saveUndo]);
  useEffect(() => {
    const start = () => {
      customRefreshRef.current?.destroy();
      const adapter = customAdapterRef.current ?? (customAdapterRef.current = new BilibiliRoomMetadataAdapter({ resolve: (roomId, signal) => localTransport().publicRoom(roomId, signal) }));
      const scheduler = new CustomRoomRefreshScheduler({
        resolve: (input, signal) => {
          const account = followingRef.current;
          if (account.roomInfoAvailable && account.rooms.some(room => room.roomId === input)) return account.resolveRoomInfo(input, signal);
          const current = libraryRef.current;
          if (current.roomsById[input]?.binding === 'custom'
            && (current.savedRoomIds.includes(input) || selectedRef.current.includes(input))) return adapter.resolve(input, signal);
          // A browse-only follow must never fall through to the site's custom API.
          return Promise.reject(new DOMException('Aborted', 'AbortError'));
        },
        onResult: (roomId, room) => {
          const current = libraryRef.current;
          if (room.roomId !== roomId) return;
          const entry = current.roomsById[roomId];
          if (entry?.room.uid !== null && entry?.room.uid !== undefined && room.uid !== null && entry.room.uid !== room.uid) return;
          const merged = mergeCustomRoom(entry?.binding === 'custom' ? entry.room as CustomRoomRecord : undefined, room);
          if (entry?.binding === 'custom' && (current.savedRoomIds.includes(roomId) || selectedRef.current.includes(roomId))) {
            commitLibrary(mergeLibraryMetadata(current, merged));
          }
          followingRef.current.applyRoomInfo(roomId, merged);
        },
      });
      customRefreshRef.current = scheduler;
      scheduler.setHidden(document.hidden);
      scheduler.setOnline(navigator.onLine);
      const plan = refreshPlanRef.current;
      scheduler.sync(plan.rooms, plan.selectedIds, new Set([...plan.baseDemand, ...(!document.hidden ? plan.browseDemand : [])]));
    };
    const stop = () => {
      customRefreshRef.current?.destroy(); customRefreshRef.current = null;
    };
    const onVisibility = () => {
      const scheduler = customRefreshRef.current, plan = refreshPlanRef.current;
      scheduler?.setHidden(document.hidden);
      scheduler?.sync(plan.rooms, plan.selectedIds, new Set([...plan.baseDemand, ...(!document.hidden ? plan.browseDemand : [])]));
    };
    const onNetwork = () => customRefreshRef.current?.setOnline(navigator.onLine);
    const onShow = (event: PageTransitionEvent) => { if (event.persisted) start(); };
    start();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onNetwork); window.addEventListener('offline', onNetwork);
    window.addEventListener('pagehide', stop);
    window.addEventListener('pageshow', onShow);
    return () => {
      stop(); document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onNetwork); window.removeEventListener('offline', onNetwork);
      window.removeEventListener('pagehide', stop); window.removeEventListener('pageshow', onShow);
    };
  }, []);
  useEffect(() => {
    customRefreshRef.current?.sync(refreshPlan.rooms, refreshPlan.selectedIds,
      new Set([...refreshPlan.baseDemand, ...(!document.hidden ? refreshPlan.browseDemand : [])]));
  }, [refreshPlan, pageVisible]);
  useEffect(() => { if (ready) setStorageError(!writeMultiviewPreferences(preferences)); }, [preferences, ready]);
  useEffect(() => {
    if (!notice?.visible) return;
    const timer = window.setTimeout(() => setNoticeState(current => current === notice ? { ...notice, visible: false } : current), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    const update = () => setFullscreen(Boolean(document.fullscreenElement && rootRef.current?.contains(document.fullscreenElement)));
    document.addEventListener('fullscreenchange', update); return () => document.removeEventListener('fullscreenchange', update);
  }, []);
  useEffect(() => {
    const ids = new Set(selectedKey ? selectedKey.split(',') : []);
    const keep = <T,>(values: Record<string, T>) => Object.fromEntries(Object.entries(values).filter(([id]) => ids.has(id)));
    setPlaybackInfos(keep); setPlaybackInfoScopes(keep); setMediaOptionsStates(keep); setPlaybackSources(keep); setPlaybackSourceScopes(keep);
    setPendingSources(keep); setRouteSelections(keep);
    setPlaybackStates(keep); setPausedRooms(keep); setRefreshTokens(keep); setPreferredRoutes(keep); setAutoplayResumers(keep);
    if (focusedRoomId && !ids.has(focusedRoomId)) setFocusedRoomId(null);
  }, [selectedKey]); // Metadata/signature references are released with a removed room.

  const updatePreferences = (patch: Partial<MultiviewPreferences>) => {
    if (patch.layoutId !== undefined || patch.roomIds !== undefined || patch.switchbarTop !== undefined || patch.sidebarSide !== undefined || patch.gridGap !== undefined) captureLayout();
    setPreferences(value => {
      const next = { ...value, ...patch };
      if (patch.layoutId !== undefined) next.slotRoomIds = resetSlotRoomIds(next.roomIds, findLayout(next.layoutId).count);
      else if (patch.roomIds !== undefined && !next.adaptiveGridEnabled) next.slotRoomIds = normalizeSlotRoomIds(next.slotRoomIds, next.roomIds, findLayout(next.layoutId).count);
      return next;
    });
  };
  const resolveCustomRoom = (input: string, signal: AbortSignal) => {
    const adapter = customAdapterRef.current ?? (customAdapterRef.current = new BilibiliRoomMetadataAdapter({ resolve: (roomId, signal) => localTransport().publicRoom(roomId, signal) }));
    return adapter.resolve(input, signal);
  };
  const saveRoom = (room: MonitorRoomDescriptor) => {
    const descriptor = room;
    const result = saveLibraryRoom(libraryRef.current, descriptor);
    if (result.error) { setNotice(result.error); return false; }
    if (!commitLibrary(result.library)) return false;
    setSaveUndo(null); setNotice(`已保存${descriptor.anchorName}到我的房间`); return true;
  };
  const removeSaved = (id: string) => {
    const entry = libraryRef.current.roomsById[id];
    if (!entry || !libraryRef.current.savedRoomIds.includes(id)) return;
    if (!commitLibrary(removeSavedRoom(libraryRef.current, id))) return;
    setSaveUndo({ id: performance.now(), room: entry.room, binding: entry.binding,
      message: selectedRef.current.includes(id) ? '已从我的房间移除，当前播放继续' : '已从我的房间移除' });
  };
  const undoSave = () => {
    if (!saveUndo) return;
    const current = libraryRef.current.roomsById[saveUndo.room.roomId];
    const result = saveLibraryRoom(libraryRef.current, current?.room ?? saveUndo.room, current?.binding ?? saveUndo.binding);
    if (result.error) { setNotice(result.error); return; }
    if (commitLibrary(result.library)) setSaveUndo(null);
  };
  const changeLayout = (layoutId: string) => {
    if (!ready) return;
    if (preferences.adaptiveGridEnabled) {
      setNotice('完全自适应布局模式下无需选择固定布局，请先关闭该模式');
      return;
    }
    const nextLayout = findLayout(layoutId);
    const roomIds = selectedIds.slice(0, nextLayout.count);
    const removedIds = selectedIds.slice(nextLayout.count);
    const slotRoomIds = resetSlotRoomIds(roomIds, nextLayout.count);
    sidebarDrag.cancelDrag(); cancelPlacement(); cancelDrag(); setPreviewSlots(null); captureLayout();
    setPlacementUndo(removedIds.length ? { id: performance.now(), kind: 'layout', layoutId: layout.id,
      roomIds: [...selectedIds], slotRoomIds: [...baseSlots], viewOffset, focusId, activeId,
      removedRooms: Object.fromEntries(removedIds.map(id => [id, { room: preferences.rooms[id] ?? defaultRoomPreference(),
        danmaku: preferences.danmaku.rooms[id] ?? { enabled: false }, paused: Boolean(pausedRooms[id]), route: preferredRoutes[id] ?? null }])),
      message: `已切换为${nextLayout.name}，移除 ${removedIds.length} 个直播间`, revision: 'local',
      expectedKey: selectionStructure(nextLayout.id, roomIds, slotRoomIds) } : null);
    setPreferences(value => ({ ...retainAllowedRooms(value, new Set(roomIds)), layoutId: nextLayout.id, roomIds, slotRoomIds }));
    setViewOffset(0); savedViewOffset.current = 0;
    setFocusedRoomId(null); setActiveRoomId(activeId && roomIds.includes(activeId) ? activeId : roomIds[0] ?? null);
    setPlacementAnnouncement(removedIds.length ? `已切换为${nextLayout.name}，按选择顺序移除 ${removedIds.length} 个直播间，可撤销` : `已切换为${nextLayout.name}`);
  };
  const toggleAdaptiveGrid = (enabled: boolean) => {
    if (!ready || enabled === preferences.adaptiveGridEnabled) return;
    if (enabled) {
      captureLayout();
      setPlacementUndo(null);
      setPreferences(value => ({ ...value, adaptiveGridEnabled: true }));
      setPlacementAnnouncement('已启用完全自适应布局，当前观看全部使用平均网格');
      return;
    }
    if (selectedIds.length <= MAX_MULTIVIEW_ROOMS) {
      captureLayout();
      const nextLayout = selectedIds.length ? layoutForCount(selectedIds.length, layout.id) : layout;
      setPreferences(value => ({ ...value, adaptiveGridEnabled: false, layoutId: nextLayout.id,
        slotRoomIds: resetSlotRoomIds(value.roomIds, nextLayout.count) }));
      setPlacementAnnouncement(`已切换回固定布局${nextLayout.name}`);
      return;
    }
    const keptIds = selectedIds.slice(0, MAX_MULTIVIEW_ROOMS);
    const removedIds = selectedIds.slice(MAX_MULTIVIEW_ROOMS);
    captureLayout();
    setPlacementUndo({ id: performance.now(), kind: 'adaptive', adaptiveGridEnabled: true, layoutId: 'twelve',
      roomIds: [...selectedIds], slotRoomIds: [...baseSlots], viewOffset, focusId, activeId,
      removedRooms: Object.fromEntries(removedIds.map(id => [id, { room: preferences.rooms[id] ?? defaultRoomPreference(),
        danmaku: preferences.danmaku.rooms[id] ?? { enabled: false }, paused: Boolean(pausedRooms[id]), route: preferredRoutes[id] ?? null }])),
      message: `已关闭平均网格，移除 ${removedIds.length} 个直播间`,
      expectedKey: selectionStructure('twelve', keptIds, resetSlotRoomIds(keptIds, findLayout('twelve').count)), revision: 'local' });
    setPreferences(value => ({ ...retainAllowedRooms(value, new Set(keptIds)), adaptiveGridEnabled: false, layoutId: 'twelve',
      roomIds: keptIds, slotRoomIds: resetSlotRoomIds(keptIds, findLayout('twelve').count) }));
    setViewOffset(0); savedViewOffset.current = 0;
    setFocusedRoomId(null); setActiveRoomId(keptIds.includes(activeId ?? '') ? activeId : keptIds[0] ?? null);
    setPlacementAnnouncement(`已关闭平均网格，保留前 12 路并移除 ${removedIds.length} 路，可撤销`);
  };
  const updateRoom = (id: string, patch: Partial<RoomPlaybackPreference>) => setPreferences(value => ({ ...value,
    rooms: { ...value.rooms, [id]: { ...defaultRoomPreference(), ...value.rooms[id], ...patch } } }));
  const setMediaMode = (id: string, mediaMode: PlaybackMediaMode) => setPreferences(value => value.roomIds.includes(id)
    ? { ...value, rooms: { ...value.rooms, [id]: { ...defaultRoomPreference(), ...value.rooms[id], mediaMode } } } : value);
  const rejectMediaMode = (id: string, mediaMode: PlaybackMediaMode, message: string) => {
    if (!selectedRef.current.includes(id)) return;
    setMediaMode(id, mediaMode); setNotice(message);
  };
  const updateDanmaku = (value: DanmakuPreferences) => setPreferences(preferences => ({ ...preferences, danmaku: value }));
  const toggleDanmaku = (id: string) => setPreferences(value => ({ ...value, danmaku: { ...value.danmaku,
    rooms: { ...value.danmaku.rooms, [id]: { ...value.danmaku.rooms[id], enabled: !value.danmaku.rooms[id]?.enabled } } } }));
  const masterSilenced = preferences.masterMuted || preferences.masterVolume === 0;
  const toggleMasterAudio = () => updatePreferences(masterSilenced
    ? { masterMuted: false, masterVolume: preferences.masterVolume || 1 } : { masterMuted: true });
  const changeMasterVolume = (masterVolume: number) => updatePreferences({ masterVolume, masterMuted: masterVolume === 0 });
  const effectiveMuted = (id: string) => preferences.masterMuted || roomPreference(id).muted || roomPreference(id).volume === 0 || preferences.masterVolume === 0;
  const toggleAudio = (id: string) => setPreferences(value => toggleRoomAudio(value, id));
  const changeVolume = (id: string, volume: number) => setPreferences(value => setRoomAudioVolume(value, id, volume));
  const changeBalance = (id: string, balance: number) => {
    if (balance !== 0) preparePlaybackAudio();
    setPreferences(value => setRoomAudioBalance(value, id, balance));
  };
  const ensureWatching = (input: MonitorRoomDescriptor) => {
    const id = input.roomId;
    if (!ready) return false;
    if (preferencesRef.current.roomIds.includes(id) && allowedIds.has(id)) return true;
    const adaptiveEnabled = preferencesRef.current.adaptiveGridEnabled;
    const roomLimit = adaptiveEnabled ? MAX_ADAPTIVE_GRID_ROOMS : MAX_MULTIVIEW_ROOMS;
    if (preferencesRef.current.roomIds.length >= roomLimit) { setNotice(adaptiveEnabled ? `平均网格最多同时观看 ${MAX_ADAPTIVE_GRID_ROOMS} 个直播间` : '最多同时观看 12 个直播间，请先移出一路，或拖入已有画面替换'); return false; }
    const room = input;
    if (!commitLibrary(upsertLibraryRoom(libraryRef.current, room))) return false;
    captureLayout();
    setPreferences(value => {
      if (value.roomIds.includes(id)) return value;
      const roomIds = [...value.roomIds, id];
      const dynamic = value.adaptiveGridEnabled;
      const layoutId = dynamic ? value.layoutId : roomIds.length > findLayout(value.layoutId).count ? layoutForCount(roomIds.length).id : value.layoutId;
      return { ...value, roomIds, rooms: { ...value.rooms, [id]: defaultRoomPreference() },
        danmaku: { ...value.danmaku, rooms: { ...value.danmaku.rooms, [id]: { ...value.danmaku.rooms[id], enabled: room.status === 'live' } } },
        layoutId, slotRoomIds: dynamic ? value.slotRoomIds : layoutId !== value.layoutId ? resetSlotRoomIds(roomIds, findLayout(layoutId).count)
          : normalizeSlotRoomIds(value.slotRoomIds, roomIds, findLayout(layoutId).count) };
    });
    setActiveRoomId(id);
    if (screenMode !== 'desktop') updatePreferences({ sidebarOpen: false });
    return true;
  };
  const toggleRoom = (id: string) => {
    if (!allowedIds.has(id)) return;
    if (!selectedSet.has(id)) { ensureWatching(roomById.get(id)!); return; }
    captureLayout();
    setPreferences(value => retainAllowedRooms(value, new Set(value.roomIds.filter(item => item !== id))));
  };
  const addLiveRooms = (rooms: MonitorRoomDescriptor[]) => {
    const ids = rooms.filter(room => allowedIds.has(room.roomId) && room.status === 'live' && !selectedSet.has(room.roomId)).map(room => room.roomId);
    const roomLimit = preferences.adaptiveGridEnabled ? MAX_ADAPTIVE_GRID_ROOMS : MAX_MULTIVIEW_ROOMS;
    const additions = ids.slice(0, roomLimit - selectedIds.length);
    if (!additions.length) { setNotice(selectedIds.length >= roomLimit ? `已达到 ${roomLimit} 个直播间上限` : '当前范围没有可加入的开播直播间'); return; }
    let nextLibrary = libraryRef.current;
    for (const id of additions) nextLibrary = upsertLibraryRoom(nextLibrary, roomById.get(id)!);
    if (!commitLibrary(nextLibrary)) return;
    captureLayout();
    setPreferences(value => {
      const roomIds = [...value.roomIds, ...additions];
      const dynamic = value.adaptiveGridEnabled;
      const layoutId = dynamic ? value.layoutId : roomIds.length > findLayout(value.layoutId).count ? layoutForCount(roomIds.length).id : value.layoutId;
      return { ...value, roomIds, layoutId,
        danmaku: { ...value.danmaku, rooms: { ...value.danmaku.rooms,
          ...Object.fromEntries(additions.map(id => [id, { ...value.danmaku.rooms[id], enabled: true }])) } },
        slotRoomIds: dynamic ? value.slotRoomIds : layoutId !== value.layoutId ? resetSlotRoomIds(roomIds, findLayout(layoutId).count)
          : normalizeSlotRoomIds(value.slotRoomIds, roomIds, findLayout(layoutId).count),
        rooms: { ...value.rooms, ...Object.fromEntries(additions.map(id => [id, defaultRoomPreference()])) } };
    });
    setNotice(`已加入 ${additions.length} 个开播直播间${ids.length > additions.length ? `，其余超过 ${roomLimit} 路上限` : ''}`);
  };
  const selectRoom = (id: string) => {
    if (focusId || screenMode !== 'desktop' || !visibleSet.has(id)) captureLayout();
    setActiveRoomId(id);
    if (focusId) setFocusedRoomId(id);
    else if (screenMode === 'desktop' && !visibleSet.has(id)) setViewOffset(Math.max(0, slotRoomIds.indexOf(id)));
  };
  const toggleFocus = (id: string) => {
    captureLayout();
    if (focusId === id) { setFocusedRoomId(null); setViewOffset(savedViewOffset.current); }
    else { if (!focusId) savedViewOffset.current = viewOffset; setFocusedRoomId(id); setActiveRoomId(id); }
  };
  const requestFullscreen = async (target: HTMLElement | null) => {
    try {
      if (document.fullscreenElement === target) { captureLayout(); await document.exitFullscreen(); return; }
      if (!target?.requestFullscreen) { setNotice('当前浏览器不支持原生全屏'); return; }
      captureLayout();
      await target.requestFullscreen();
    } catch { setNotice('浏览器未允许全屏，请重试'); }
  };
  const reconnect = (id: string) => { setPausedRooms(values => ({ ...values, [id]: false })); setRefreshTokens(values => ({ ...values, [id]: (values[id] ?? 0) + 1 })); };
  const onPlaybackInfo = useCallback((info: PlaybackInfo, scope = 'anonymous') => {
    if (!selectedRef.current.includes(info.roomId)) return;
    setPlaybackInfos(values => ({ ...values, [info.roomId]: info }));
    setPlaybackInfoScopes(values => ({ ...values, [info.roomId]: scope }));
  }, []);
  const rootKeyboard = (event: React.KeyboardEvent) => {
    if (placementDraftRef.current) return;
    if ((event.target as HTMLElement).closest('input,select,textarea,[contenteditable=true],[role="combobox"],[role="listbox"],[role="option"],.ui-select-content') || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'Escape' && !document.fullscreenElement) {
      if (focusId) { captureLayout(); setFocusedRoomId(null); setViewOffset(savedViewOffset.current); event.preventDefault(); }
    }
  };
  useEffect(() => {
    const keyboardVolume = (event: KeyboardEvent) => {
      if (!['ArrowUp', 'ArrowDown'].includes(event.key) || event.defaultPrevented || event.isComposing
        || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || document.hidden
        || placementDraftRef.current || isDragging || sidebarDrag.isDragging) return;
      const target = event.target;
      if (target instanceof Element && target.closest('input,select,textarea,[contenteditable]:not([contenteditable="false"]),[role="slider"],[role="separator"],[role="combobox"],[role="listbox"],[role="option"],[role="menu"],[role="menuitem"],[role="menuitemradio"],[role="dialog"],[role="alertdialog"],.mv-danmaku-messages,.mv-player-state-content')) return;
      if (document.querySelector('[role="dialog"],[role="alertdialog"],[role="listbox"],.mv-playback-quality-menu[data-open="true"]')) return;
      event.preventDefault();
      setPreferences(value => {
        const currentVolume = value.masterMuted ? 0 : value.masterVolume;
        const masterVolume = Math.max(0, Math.min(1, Math.round((currentVolume + (event.key === 'ArrowUp' ? 0.05 : -0.05)) * 100) / 100));
        return { ...value, masterVolume, masterMuted: masterVolume === 0 };
      });
    };
    window.addEventListener('keydown', keyboardVolume);
    return () => window.removeEventListener('keydown', keyboardVolume);
  }, [isDragging, sidebarDrag.isDragging]);
  const openSidebar = (tab: SidebarTab) => { setSidebarTab(tab); updatePreferences({ sidebarOpen: true }); };
  const toggleSidebarTab = (tab: SidebarTab) => { setSidebarTab(tab); updatePreferences({ sidebarOpen: !(preferences.sidebarOpen && sidebarTab === tab) }); };

  return <div ref={rootRef} className={`mv-shell${preferences.sidebarOpen ? '' : ' mv-sidebar-collapsed'}${resizingSidebar ? ' mv-sidebar-resizing' : ''}${isDragging ? ' mv-reordering' : ''}${sidebarDrag.isDragging ? ' mv-sidebar-dragging' : ''} mv-screen-${screenMode}`}
    style={{ '--mv-sidebar-width': `${preferences.sidebarWidth}px`, '--mv-grid-gap': `${preferences.gridGap}px` } as React.CSSProperties} tabIndex={-1} onKeyDown={rootKeyboard} data-testid="multiview-panel" data-controls-hidden={controlsHidden} data-sidebar-side={preferences.sidebarSide}>
    <div className="mv-body">
      <aside className="mv-sidebar" data-mv-motion="sidebar" aria-label="多视角控制栏" inert={controlsHidden} aria-hidden={controlsHidden}>
        <span className="mv-workspace-link" title={PROJECT_NAME}>
          <span className="mv-workspace-mark" aria-hidden="true"><Activity size={22} strokeWidth={2.5} /></span>
          <span className="mv-workspace-label">Monitor</span>
        </span>
        <nav className="mv-sidebar-tabs" aria-label="多视角设置分类">
          {([{ id: 'rooms', label: '直播间', icon: Video }, { id: 'danmaku', label: '弹幕', icon: MessageSquare }, { id: 'layouts', label: '布局', icon: LayoutGrid }, { id: 'audio', label: '混音器', icon: Volume2 }, { id: 'settings', label: '设置', icon: Settings2 }] as const).map((tab, index) => <button key={tab.id}
            style={{ '--mv-tab-index': index } as React.CSSProperties} aria-expanded={preferences.sidebarOpen && sidebarTab === tab.id}
            className={sidebarTab === tab.id ? 'mv-selected' : ''} aria-label={`打开${tab.label}`} aria-pressed={preferences.sidebarOpen && sidebarTab === tab.id} title={tab.label}
            onClick={() => toggleSidebarTab(tab.id)}><tab.icon size={17} /><span>{tab.label}</span>{tab.id === 'settings' && <LocalLoginIndicator login={localLogin} streamReady={loginStreamReady} />}</button>)}
          <button className="mv-collapse" aria-expanded={preferences.sidebarOpen} aria-label={preferences.sidebarOpen ? '收起控制栏' : '展开控制栏'} title={preferences.sidebarOpen ? '收起控制栏' : '展开控制栏'} onClick={() => updatePreferences({ sidebarOpen: !preferences.sidebarOpen })}><ChevronLeft size={17} /></button>
        </nav>
        <div className={`mv-sidebar-content${sidebarTab === 'rooms' ? ' mv-sidebar-room-picker' : ''}${sidebarTab === 'danmaku' ? ' mv-sidebar-danmaku' : ''}${sidebarTab === 'layouts' ? ' mv-sidebar-layouts' : ''}${sidebarTab === 'audio' || sidebarTab === 'settings' ? ' ui-scrollbar' : ''}`} inert={!preferences.sidebarOpen} aria-hidden={!preferences.sidebarOpen}>
          <RoomLibraryPicker active={sidebarTab === 'rooms' && preferences.sidebarOpen && !controlsHidden} savedRooms={savedRooms}
            following={followingView} onFollowingActiveChange={setFollowingBrowse}
            onOpenFollowingSetup={() => openAccountSetup('following')}
            selectedRooms={selectedIds.map(id => roomById.get(id)!)} savedIds={savedIds} unavailableIds={unavailableIds}
            roomPreferences={preferences.rooms} onRestoreVideo={id => setMediaMode(id, 'video')}
            playbackStatuses={Object.fromEntries(selectedIds.map(id => [id, pausedRooms[id] ? 'paused' : playbackStates[id]?.status ?? 'loading']))}
            adaptiveGridEnabled={preferences.adaptiveGridEnabled} maxWatchingRooms={preferences.adaptiveGridEnabled ? MAX_ADAPTIVE_GRID_ROOMS : MAX_MULTIVIEW_ROOMS}
            ready={ready}
            draggingId={placementDraft?.roomId ?? null} resolveRoom={resolveCustomRoom}
            onSave={saveRoom} onRemoveSaved={removeSaved} onWatch={ensureWatching} onToggle={toggleRoom}
            onLocate={id => { selectRoom(id); tileRefs.current.get(id)?.focus({ preventScroll: true }); }}
            onRevalidate={async (id, signal) => {
              const entry = libraryRef.current.roomsById[id];
              if (!entry) return;
              const room = await resolveCustomRoom(id, signal);
              if (signal.aborted || (!libraryRef.current.savedRoomIds.includes(id) && !selectedRef.current.includes(id))) return;
              if (room.roomId !== id) throw new Error('房间号解析结果已变化，请重新添加');
              if (!commitLibrary(upsertLibraryRoom(libraryRef.current, room, 'custom'))) throw new Error('本地记录写入失败，请重试');
            }}
            onAddLive={addLiveRooms} onClearWatching={() => { captureLayout(); setPreferences(value => retainAllowedRooms(value, new Set())); setFocusedRoomId(null); }}
            onDragStart={(event, id) => sidebarDrag.onPointerDown(event, id)}
            onClickCapture={event => { if (event.detail > 0 && sidebarDrag.shouldSuppressClick()) { event.preventDefault(); event.stopPropagation(); } }} />
          {sidebarTab === 'layouts' && <section className="mv-layout-panel ui-inset-scroll-frame">
            <div className="mv-sidebar-heading"><strong>画面布局</strong></div>
            <LayoutModeControl enabled={preferences.adaptiveGridEnabled} onChange={toggleAdaptiveGrid} />
            <div className="mv-layout-list-scroll ui-inset-scroll" aria-label="布局选项">
              <AnimatedCollapse open={preferences.adaptiveGridEnabled}>
                <AdaptiveGridDetails roomCount={selectedIds.length} maxRooms={MAX_ADAPTIVE_GRID_ROOMS} />
              </AnimatedCollapse>
              <AnimatedCollapse open={!preferences.adaptiveGridEnabled}>
              <div className="mv-layout-options" aria-label="多视角布局模板">{MULTIVIEW_LAYOUTS.map(item => <button key={item.id} className={item.id === layout.id ? 'mv-selected' : ''}
                aria-label={`选择${item.name}`} aria-pressed={item.id === layout.id} onClick={() => changeLayout(item.id)}><LayoutPreview layout={item} /><span>{item.name}</span></button>)}</div>
              <p className="mv-note">26 种固定模板，最多 12 路。新增直播间时自动扩展布局；切换到更小模板时保留前面的直播间，其余移除并可撤销。</p>
              </AnimatedCollapse>
            </div>
          </section>}
          {sidebarTab === 'audio' && <>
            <div className="mv-sidebar-heading"><strong>混音器</strong><small>多路混音</small></div>
            <div className={`mv-mixer-master${masterSilenced ? '' : ' mv-audible'}`}>
              <button type="button" className="mv-icon-button" aria-label={masterSilenced ? '混音器取消全部静音' : '混音器全部静音'}
                aria-pressed={masterSilenced} onClick={toggleMasterAudio}>{masterSilenced ? <VolumeX /> : <Volume2 />}</button>
              <UiSlider label="总音量" min={0} max={1} step={0.01} value={preferences.masterVolume}
                formatValue={value => `${Math.round(value * 100)}%`} onChange={changeMasterVolume} />
            </div>
            <div className="mv-mixer-rooms">{selectedIds.map(id => {
              const room = roomById.get(id)!, pref = roomPreference(id), muted = effectiveMuted(id);
              const uid = room.uid != null && Number.isSafeInteger(room.uid) && room.uid > 0 ? String(room.uid) : undefined;
              const resolveProfile = localChat.chat.profile;
              return <MixerRoomAudio key={id} name={room.anchorName} uid={uid} volume={pref.volume} muted={muted}
                avatarScope={`${uid ?? ''}:${localChat.scope}:${resolveProfile ? 'profile' : ''}`}
                active={preferences.sidebarOpen && !controlsHidden && pageVisible} resolveProfile={resolveProfile}
                balance={pref.balance} balanceUnavailable={balanceUnavailableRooms.has(id)}
                onSelect={() => selectRoom(id)} onToggle={() => toggleAudio(id)}
                onVolumeChange={volume => changeVolume(id, volume)} onBalanceChange={balance => changeBalance(id, balance)} />;
            })}</div>
            {!selectedIds.length && <p className="mv-note">先选择直播间，再调节每路声音</p>}
          </>}
          {sidebarTab === 'settings' && <><MonitorSettings preferences={preferences} onChange={updatePreferences} />
            <LocalLoginSettings login={localLogin} active={preferences.sidebarOpen && !controlsHidden && pageVisible} streamReady={loginStreamReady} setupRequest={loginSetupRequest} onSetupRequestHandled={completeAccountSetupRequest} hasDrafts={chatHasDrafts} /></>}
          <div hidden={sidebarTab !== 'danmaku'} inert={sidebarTab !== 'danmaku'} style={{ display: sidebarTab === 'danmaku' ? 'contents' : 'none' }}><DanmakuSidebar roomIds={selectedIds} visibleIds={visibleIds} roomName={id => roomById.get(id)?.anchorName || id}
            currentRoomId={currentDanmakuRoom} onRoomChange={setDanmakuRoomId} rooms={danmaku.rooms} preferences={preferences.danmaku}
            onChange={updateDanmaku} onReconnect={danmaku.reconnect} onViewChange={setDanmakuPublishedView} chat={chatAdapter}
            active={preferences.sidebarOpen && sidebarTab === 'danmaku' && !controlsHidden} /></div>
        </div>
      </aside>
      {screenMode === 'desktop' && <div className="mv-sidebar-resizer" data-mv-motion="sidebar-resizer" role="separator" aria-label="调整多视角控制栏宽度" aria-orientation="vertical" tabIndex={preferences.sidebarOpen && !controlsHidden ? 0 : -1} aria-hidden={!preferences.sidebarOpen || controlsHidden} inert={controlsHidden}
        aria-valuemin={MIN_SIDEBAR_WIDTH} aria-valuemax={MAX_SIDEBAR_WIDTH} aria-valuenow={preferences.sidebarWidth}
        onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); const direction = preferences.sidebarSide === 'right' ? -1 : 1; updatePreferences({ sidebarWidth: normalizeSidebarWidth(preferences.sidebarWidth + direction * (event.key === 'ArrowRight' ? 10 : -10)) }); } }}
        onPointerDown={event => { setResizingSidebar(true); sidebarResize.current = { x: event.clientX, width: preferences.sidebarWidth, direction: preferences.sidebarSide === 'right' ? -1 : 1 }; event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={event => { if (sidebarResize.current) updatePreferences({ sidebarWidth: normalizeSidebarWidth(sidebarResize.current.width + sidebarResize.current.direction * (event.clientX - sidebarResize.current.x)) }); }}
        onPointerUp={event => { sidebarResize.current = null; setResizingSidebar(false); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { sidebarResize.current = null; setResizingSidebar(false); }} onLostPointerCapture={() => { sidebarResize.current = null; setResizingSidebar(false); }} />}
      <section className={`mv-stage${preferences.switchbarTop ? ' mv-switch-top' : ''}`} data-mv-motion="stage" aria-label="直播多视角画面">
        <div ref={gridRef} className={`mv-grid${focusId ? ' mv-focused' : ''}${adaptiveGridActive ? ' mv-adaptive-grid' : ''}`} style={adaptiveLayout ? adaptiveGridStyle(adaptiveLayout) : layoutGridStyle(displayLayout)} data-testid="multiview-grid" onLostPointerCapture={cancelDrag}>
          {tileRenderIds.map(id => {
            const room = roomById.get(id)!, pref = roomPreference(id), index = visibleSlots.indexOf(id), isVisible = index >= 0;
            const canCommitRoute = routeCommitGuard.capture(id, room.source ?? 'custom');
            const adaptiveColumn = adaptiveGridActive && adaptiveLayout && isVisible ? (index % adaptiveLayout.columns) + 1 : undefined;
            const adaptiveRow = adaptiveGridActive && adaptiveLayout && isVisible ? Math.floor(index / adaptiveLayout.columns) + 1 : undefined;
            const audioOnly = pref.mediaMode === 'audio';
            const active = audioOnly || isVisible || (screenMode === 'desktop' && !preferences.stopHidden);
            const sameIdentity = mediaStateIdentity === mediaIdentity;
            const sourceAllowed = playbackSourceScopes[id] === 'anonymous' || playbackSourceScopes[id] === localLogin.authSessionKey;
            const infoAllowed = playbackInfoScopes[id] === 'anonymous' || playbackInfoScopes[id] === localLogin.authSessionKey;
            const info = sameIdentity && infoAllowed ? playbackInfos[id] : undefined, actualSource = sameIdentity && sourceAllowed ? playbackSources[id] : undefined,
              playback = sameIdentity && (!playbackSources[id] || sourceAllowed) ? playbackStates[id] : undefined;
            const requestedQuality = pref.quality || 250;
            const muted = effectiveMuted(id), paused = Boolean(pausedRooms[id]);
            const pendingSource = sameIdentity && !paused && active ? pendingSources[id] : null;
            const preferredRoute = sameIdentity ? preferredRoutes[id] ?? '' : '';
            const qualityMismatch = Boolean(actualSource && actualSource.mediaKind !== 'audio-only' && actualSource.actualQuality !== requestedQuality);
            const online = room.status === 'live' && typeof room.online === 'number' && Number.isFinite(room.online) && room.online >= 0 ? room.online : null;
            const staleOnline = online !== null && room.onlineStale;
            const state = room.status === 'offline' ? 'offline' : paused ? 'paused' : playback?.status ?? 'loading';
            const showBackdrop = state !== 'playing' && state !== 'paused' && state !== 'stalled';
            const dragged = dragVisual?.roomId === id ? dragVisual : null;
            return <article key={id} ref={node => { if (node) tileRefs.current.set(id, node); else tileRefs.current.delete(id); }} tabIndex={-1} className={`mv-tile${dragged ? ' mv-tile-dragging' : ''}`}
              data-room-id={id} data-media-mode={audioOnly ? 'audio' : 'video'} data-visible={isVisible} data-slot-index={isVisible ? index : undefined}
              data-placement-slot={adaptiveGridActive && isVisible ? index : undefined} data-mv-motion={id} data-mv-dragging={Boolean(dragged)}
              style={{ gridArea: isVisible ? adaptiveGridActive ? `${adaptiveRow} / ${adaptiveColumn} / span 1 / span 1` : SLOT_AREAS[index] : undefined, display: isVisible ? undefined : 'none',
                ...(dragged ? { left: dragged.rect.left, top: dragged.rect.top, width: dragged.rect.width, height: dragged.rect.height } : {}) }} aria-hidden={!isVisible} inert={!isVisible}
              onPointerDown={event => startTilePointer(event, id)} onClickCapture={suppressClick} onDragStart={event => event.preventDefault()}
              onDoubleClick={event => { if (!shouldSuppressClick() && !(event.target as HTMLElement).closest('button,input,select,a,.mv-tile-controls,[role="combobox"],[role="listbox"],[role="option"],.ui-select-content')) toggleFocus(id); }}>
              <div className="mv-video"><LivePlayer roomId={id} source={room.source ?? 'custom'} requestedQuality={requestedQuality} muted={muted} volume={pref.volume * preferences.masterVolume} paused={paused}
                balance={pref.balance} onBalanceUnavailable={unavailable => {
                  if (unavailable && !selectedRef.current.includes(id)) return;
                  setBalanceUnavailableRooms(rooms => {
                    if (rooms.has(id) === unavailable) return rooms;
                    const next = new Set(rooms);
                    if (unavailable) next.add(id); else next.delete(id);
                    return next;
                  });
                }}
                resolvePlayback={request => requestPool.resolve(request, localLogin.resolutionScope)} authSessionKey={localLogin.authSessionKey}
                resolveAudioPlayback={resolveAudioPlayback} audioCapabilityKey={audioCapabilityKey}
                onAudioDeliveryChange={delivery => { if (selectedRef.current.includes(id)) setAudioDeliveries(values => values[id] === delivery ? values : { ...values, [id]: delivery }); }}
                mediaMode={audioOnly ? 'audio' : 'video'} onMediaModeRejected={(mode, message) => rejectMediaMode(id, mode, message)}
                active={ready && localLogin.initialReady && active && room.status !== 'offline'} visible={isVisible} refreshToken={refreshTokens[id] ?? 0} onPlaybackInfo={onPlaybackInfo}
                onOptionsStateChange={state => { if (selectedRef.current.includes(id)) setMediaOptionsStates(values => values[id] === state ? values : { ...values, [id]: state }); }}
                playbackMode={preferences.playbackMode} preferredRoute={preferredRoute || null} autoReconnect={preferences.autoReconnect}
                routeSelection={sameIdentity ? routeSelections[id] : undefined} onCooldown={seconds => requestPool.block(seconds)}
                onAutoplayBlockedChange={resume => setAutoplayResumers(values => {
                  if ((resume && !selectedRef.current.includes(id)) || values[id] === resume || (!resume && !values[id])) return values;
                  if (resume) return { ...values, [id]: resume };
                  const next = { ...values }; delete next[id]; return next;
                })}
                onPendingSourceChange={source => { if (selectedRef.current.includes(id)) setPendingSources(values => values[id] === source ? values : { ...values, [id]: source }); }}
                onSourceChange={(source, scope = 'anonymous') => {
                  if (!selectedRef.current.includes(id)) return;
                  if (source) {
                    setPlaybackSources(values => ({ ...values, [id]: source }));
                    setPlaybackSourceScopes(values => ({ ...values, [id]: scope }));
                  } else {
                    setPlaybackSources(values => Object.fromEntries(Object.entries(values).filter(([roomId]) => roomId !== id)));
                    setPlaybackSourceScopes(values => Object.fromEntries(Object.entries(values).filter(([roomId]) => roomId !== id)));
                    setPlaybackInfos(values => Object.fromEntries(Object.entries(values).filter(([roomId]) => roomId !== id)));
                    setPlaybackInfoScopes(values => Object.fromEntries(Object.entries(values).filter(([roomId]) => roomId !== id)));
                  }
                }}
                onStatusChange={(status, message) => {
                  if (!selectedRef.current.includes(id)) return;
                  setPlaybackStates(values => values[id]?.status === status && values[id]?.message === message
                    ? values : { ...values, [id]: { status, message } });
                  if (status === 'restricted' || status === 'offline') {
                    setPlaybackSources(values => Object.fromEntries(Object.entries(values).filter(([roomId]) => roomId !== id)));
                    setPendingSources(values => ({ ...values, [id]: null }));
                  }
                }} />
                <PlayerBackdrop visible={audioOnly || showBackdrop} cover={room.cover} />
                {audioOnly && (state === 'playing' || state === 'stalled') && <AudioOnlyPresentation name={room.anchorName}
                  delivery={audioDeliveries[id]} animated={state === 'playing' && !muted && !paused && isVisible && pageVisible} onRestore={() => setMediaMode(id, 'video')} />}
                <DanmakuOverlay roomId={id} active={isVisible && room.status === 'live' && !paused && Boolean(preferences.danmaku.rooms[id]?.enabled)}
                  style={roomDanmakuStyle(preferences.danmaku, id)} subscribe={danmaku.subscribe} accountUid={localChat.chat.accountUid} /></div>
              <header className="mv-tile-header">
                <button className="mv-tile-title" aria-label={room.anchorName || id} aria-description="按住画面移动位置"
                  onClick={() => selectRoom(id)} onDoubleClick={event => { event.stopPropagation(); if (!shouldSuppressClick()) toggleFocus(id); }} title={room.title}><i className={room.status === 'live' ? 'mv-live-dot' : 'mv-offline-dot'} /><strong>{room.anchorName || id}</strong>
                  <span className="mv-tile-online" data-stale={staleOnline} title={online === null ? room.onlineError || '暂无有效在线人数' : staleOnline ? `上次成功获取的在线人数${room.onlineError ? `；${room.onlineError}` : ''}` : '当前在线人数'}>
                    <Users size={11} aria-hidden="true" /><RollingNumber value={online} />{staleOnline && <sup>旧</sup>}
                  </span></button>
                <a className="mv-icon-button mv-room-link" href={`https://live.bilibili.com/${id}`} target="_blank" rel="noopener noreferrer"
                  aria-label={`${room.anchorName}进入直播间`} title="进入 B站直播间"><ExternalLink size={17} /></a>
                <button className="mv-icon-button" aria-label={`移除${room.anchorName}画面`} title="移除画面" onClick={() => toggleRoom(id)}><X size={14} /></button>
              </header>
              {preferences.onlineCountPosition !== 'hidden' && room.status === 'live' && state === 'playing' && <div className="mv-tile-online-badge" data-stale={staleOnline} data-position={preferences.onlineCountPosition}
                aria-label={`${room.anchorName || id}在线人数${online === null ? '暂不可用' : online}${staleOnline ? '，上次成功获取值' : ''}`}
                title={online === null ? room.onlineError || '暂无有效在线人数' : staleOnline ? `上次成功获取的在线人数${room.onlineError ? `；${room.onlineError}` : ''}` : '当前在线人数'}>
                <Users size={12} aria-hidden="true" /><RollingNumber value={online} />{staleOnline && <sup>旧</sup>}
              </div>}
              {state === 'stalled' && <div className="mv-player-health" role="status">
                <span title={playback?.message}>{audioOnly ? '声音播放停滞' : '播放停滞'} · {preferences.autoReconnect ? '正在恢复' : '自动恢复已关闭'}</span>
                <button className="mv-icon-button" aria-label={`${room.anchorName}恢复停滞播放`} title="重新连接此路" onClick={() => reconnect(id)}><RefreshCw size={13} /></button>
              </div>}
              {state !== 'playing' && state !== 'stalled' && <div className={`mv-player-state mv-player-state-${state}`} data-backdrop={showBackdrop} aria-live="polite">
                <div className={`mv-player-state-content${state === 'autoplay-blocked' ? '' : ' ui-scrollbar-padded'}`} tabIndex={state === 'autoplay-blocked' ? -1 : 0} aria-label={`${room.anchorName || id}播放状态详情`}
                  onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
                  {showBackdrop && state !== 'autoplay-blocked' && <strong className="mv-player-state-anchor">{room.anchorName || '未知主播'}</strong>}
                  <span aria-hidden="true">{state === 'loading' || state === 'retrying' ? <RefreshCw className="mv-spin" size={22} /> : state === 'paused' ? <Pause size={23} /> : state === 'autoplay-blocked' ? <Play size={23} /> : <Radio size={23} />}</span>
                  <strong>{state === 'autoplay-blocked' ? '浏览器已阻止自动播放' : !active && !paused && room.status !== 'offline' ? '隐藏画面已停止' : statusLabel[state]}</strong>
                  {playback?.message && room.status !== 'offline' && state !== 'autoplay-blocked' && <small>{playback.message}</small>}
                </div>
                {(state === 'error' || (state === 'autoplay-blocked' && autoplayResumers[id]) || audioOnly) && <div className="mv-player-state-actions ui-scrollbar-padded">
                  {state === 'error' && <button onClick={() => reconnect(id)} aria-label={`${room.anchorName}重新连接`}>重新连接</button>}
                  {state === 'autoplay-blocked' && autoplayResumers[id] && <button onClick={() => autoplayResumers[id]?.()} aria-label={`${room.anchorName}恢复播放`}><Play size={14} />恢复播放</button>}
                  {audioOnly && state !== 'autoplay-blocked' && <button type="button" className="mv-audio-only-restore" aria-label={`${room.anchorName}播放画面`} onClick={() => setMediaMode(id, 'video')}><Video size={15} />播放画面</button>}
                </div>}
              </div>}
              <div className="mv-tile-controls">
                <div className="mv-controls-primary">
                  <button className="mv-icon-button" aria-label={`${room.anchorName}${paused ? '继续播放' : '暂停播放'}`} title={paused ? '继续直播，重新连接到当前画面' : '暂停并停止拉流'} onClick={() => setPausedRooms(values => ({ ...values, [id]: !paused }))}>{paused ? <Play /> : <Pause />}</button>
                  <button className="mv-icon-button mv-refresh-playback" aria-label={`${room.anchorName}刷新播放`} title="刷新播放，回到直播位置" onClick={() => reconnect(id)}><RefreshCw /></button>
                  <PlayerVolumeControl name={room.anchorName} muted={muted} volume={pref.volume} onToggle={() => toggleAudio(id)} onChange={volume => changeVolume(id, volume)} />
                  <LiveDuration name={room.anchorName} status={room.status} startTime={room.liveStartTime} />
                </div>
                <div className="mv-controls-secondary">
                  {!(audioOnly && actualSource?.mediaKind === 'audio-only') && <RoomPlaybackMenu
                    key={JSON.stringify([localLogin.authSessionKey, 'local', room.source, id, pref.mediaMode])}
                    identityScope={JSON.stringify([localLogin.authSessionKey, 'local', room.source, id, pref.mediaMode])}
                    rpcScope={localLogin.resolutionScope} anonymous={!localLogin.enabled} pool={requestPool}
                    roomId={id} source={room.source ?? 'custom'} name={room.anchorName} quality={pref.quality}
                    mediaInfo={info} mediaInfoIdentityScope={playbackInfoScopes[id]} currentMediaIdentityScope={localLogin.authSessionKey}
                    mediaOptionsState={mediaOptionsStates[id]} actualSource={actualSource} pendingSource={pendingSource} status={state}
                    audioOnly={audioOnly} visible={isVisible && localLogin.initialReady} supportsSource={supportsBranch} preferredRoute={preferredRoute}
                    onQualityChange={quality => {
                      if (pref.quality === quality && qualityMismatch && !paused) reconnect(id);
                      else updateRoom(id, { quality });
                    }}
                    onRouteChange={(key, fresh) => {
                      if (!canCommitRoute()) return;
                      setPreferredRoutes(values => ({ ...values, [id]: key || null }));
                      setRouteSelections(values => ({ ...values, [id]: { key: key || null, info: fresh, token: (values[id]?.token ?? 0) + 1 } }));
                    }} />}
                  <button className="mv-icon-button mv-danmaku-toggle" aria-label={`${room.anchorName}${preferences.danmaku.rooms[id]?.enabled ? '关闭弹幕' : '开启弹幕'}`} aria-pressed={Boolean(preferences.danmaku.rooms[id]?.enabled)} title="画面弹幕" onClick={() => toggleDanmaku(id)}>{preferences.danmaku.rooms[id]?.enabled ? <MessageSquare /> : <MessageSquareOff />}</button>
                  <button className="mv-icon-button mv-audio-only-toggle" aria-label={`${room.anchorName}${audioOnly ? '切换到播放画面' : '仅听声音'}`} aria-pressed={audioOnly}
                    title={audioOnly ? '播放画面' : '仅听声音：优先使用纯音频，无法使用时保留声音播放'} onClick={() => setMediaMode(id, audioOnly ? 'video' : 'audio')}><Headphones /></button>
                  <button className="mv-icon-button" aria-label={`${room.anchorName}${focusId === id ? '还原布局' : '聚焦放大'}`} title={focusId === id ? '还原布局' : '聚焦放大'} onClick={() => toggleFocus(id)}>{focusId === id ? <Minimize2 /> : <Focus />}</button>
                  <button className="mv-icon-button" aria-label={`${room.anchorName}画面原生全屏`} title="画面全屏" onClick={() => void requestFullscreen(tileRefs.current.get(id) ?? null)}><Maximize2 /></button>
                </div>
              </div>
            </article>;
          })}
          {adaptiveGridActive && adaptiveLayout && selectedIds.map((_, index) => <div key={`target-${index}`} className="mv-slot-target"
            data-mv-slot-index={index} style={{ gridArea: `${Math.floor(index / adaptiveLayout.columns) + 1} / ${(index % adaptiveLayout.columns) + 1} / span 1 / span 1` }} aria-hidden="true" />)}
          {adaptiveGridActive && dragVisual && adaptiveLayout && slotRoomIds.indexOf(dragVisual.roomId) >= 0
            && <div className="mv-adaptive-drag-placeholder"
              style={{ gridArea: `${Math.floor(slotRoomIds.indexOf(dragVisual.roomId) / adaptiveLayout.columns) + 1} / ${(slotRoomIds.indexOf(dragVisual.roomId) % adaptiveLayout.columns) + 1} / span 1 / span 1` }}
              aria-hidden="true"><span>{slotRoomIds.indexOf(dragVisual.roomId) === selectedIds.indexOf(dragVisual.roomId) ? '原位置' : '松开交换'}</span></div>}
          {!adaptiveGridActive && SLOT_AREAS.slice(0, displayLayout.count).map((area, index) => <div key={`target-${area}`} className="mv-slot-target" data-mv-slot-index={index} style={{ gridArea: area }} aria-hidden="true" />)}
          {!adaptiveGridActive && dragVisual && <div className="mv-drag-placeholder" data-mv-motion="drop-preview" style={{ gridArea: SLOT_AREAS[visibleSlots.indexOf(dragVisual.roomId)] }} aria-hidden="true"><span>松开放置</span></div>}
          {!adaptiveGridActive && SLOT_AREAS.slice(0, displayLayout.count).filter((_, index) => !visibleSlots[index]).map(area => <button key={`empty-${area}`} className="mv-empty-slot" data-mv-motion={`empty-${area}`} style={{ gridArea: area }} aria-label={`添加直播间到${area}画面`} onClick={() => openSidebar('rooms')}><Plus size={24} /><span>添加直播间</span></button>)}
          {adaptiveGridActive && !selectedIds.length && <button className="mv-empty-slot mv-adaptive-empty" data-mv-motion="adaptive-empty" aria-label="添加直播间" onClick={() => openSidebar('rooms')}><Plus size={24} /><span>添加直播间</span></button>}
          {!ready && <div className="mv-stage-placeholder"><RefreshCw className="mv-spin" /><span>正在验证直播间目录…</span></div>}
          {!adaptiveGridActive && <RoomPlacementSurface draft={placementDraft} layout={layout} slots={placementSlots} rooms={roomById}
            staticMap={Boolean(focusId)} plan={placementPlan} />}
        </div>
        <div className="mv-switchbar" data-mv-motion="switchbar" role="group" aria-label="快捷控制栏" inert={controlsHidden} aria-hidden={controlsHidden}>
          {blockedRoomIds.length > 0 && <button className="mv-autoplay-resume-all" aria-label="恢复全部播放"
            title="恢复所有被浏览器阻止的直播，保留原音量与暂停选择" onClick={() => {
              // Every play() must run inside this click, before any asynchronous work.
              for (const id of blockedRoomIds) autoplayResumers[id]?.();
            }}><Play size={14} aria-hidden="true" /><span>恢复全部播放（{blockedRoomIds.length}）</span></button>}
          <ShortcutAudioControl name="总音量" variant="master" volume={preferences.masterVolume} muted={masterSilenced} idleHidden={controlsHidden}
            onToggle={toggleMasterAudio} onChange={changeMasterVolume} popupSide={preferences.switchbarTop ? 'bottom' : 'top'} />
          <ShortcutRoomRail hidden={controlsHidden}>{selectedIds.map(id => {
          const name = roomById.get(id)?.anchorName || id, muted = effectiveMuted(id), pref = roomPreference(id);
          return <span key={id} data-mv-motion={`switch-${id}`} data-audio-room-id={id} className="mv-audio-shortcut"><ShortcutAudioControl name={name} volume={pref.volume} muted={muted} idleHidden={controlsHidden}
            roomBalance={{ balance: pref.balance, balanceUnavailable: balanceUnavailableRooms.has(id), onBalanceChange: balance => changeBalance(id, balance) }}
            onToggle={() => toggleAudio(id)} onChange={volume => changeVolume(id, volume)} popupSide={preferences.switchbarTop ? 'bottom' : 'top'} /></span>;
          })}</ShortcutRoomRail>
          {selectedIds.length > 1 && (focusId || screenMode !== 'desktop') && <UiSelect className="mv-view-select" label="当前观看直播间" value={focusId ?? (activeId && visibleSet.has(activeId) ? activeId : visibleIds[0]) ?? ''} onChange={selectRoom}
            options={selectedIds.map(id => ({ value: id, label: roomById.get(id)?.anchorName || id }))} />}
          {focusId && <button className="mv-icon-button mv-restore-layout" onClick={() => toggleFocus(focusId)} aria-label="还原多视角布局" title="还原多视角布局"><Minimize2 size={15} /></button>}
          <button className="mv-icon-button mv-fullscreen-shortcut" aria-label={fullscreen ? '退出原生全屏' : '多视角面板全屏'} title={fullscreen ? '退出原生全屏' : '面板全屏'} onClick={() => void requestFullscreen(rootRef.current)}>{fullscreen ? <Minimize2 /> : <Maximize2 />}</button>
          <button className="mv-icon-button mv-layout-shortcut" aria-label="切换布局" aria-expanded={preferences.sidebarOpen && sidebarTab === 'layouts'} title={preferences.sidebarOpen && sidebarTab === 'layouts' ? '收起布局侧栏' : '切换布局'} onClick={() => toggleSidebarTab('layouts')}><LayoutGrid size={15} /></button>
        </div>
      </section>
    </div>
    <div ref={ghostRef} className="mv-placement-ghost" aria-hidden="true">{ghostRoomId && roomById.has(ghostRoomId) && <>
      {roomById.get(ghostRoomId)?.cover && <img src={roomById.get(ghostRoomId)!.cover} alt="" referrerPolicy="no-referrer" draggable={false} />}
      <span><Video size={15} />{roomById.get(ghostRoomId)?.anchorName || ghostRoomId}</span></>}</div>
    {placementUndo && placementUndo.expectedKey === undoStructureKey && placementUndo.revision === 'local'
      && <PlacementUndoToast key={placementUndo.id} message={placementUndo.message} onUndo={undoPlacement} onDismiss={() => setPlacementUndo(null)} />}
    {saveUndo && <div className="mv-library-undo"><PlacementUndoToast key={saveUndo.id} message={saveUndo.message} onUndo={undoSave} onDismiss={() => setSaveUndo(null)} /></div>}
    <span className="mv-placement-announcement" role="status" aria-live="polite">{placementAnnouncement}</span>
    <div className="mv-notice" role="status" data-visible={Boolean(notice?.visible || storageError)}
      aria-hidden={!notice?.visible && !storageError}>
      {notice?.visible || !storageError ? notice?.text : '浏览器未能保存观看偏好，本次操作仍然生效'}
    </div>
  </div>;
}
