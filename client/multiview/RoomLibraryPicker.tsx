import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { AlertCircle, ArrowLeft, Bookmark, Check, ChevronRight, Plus, RefreshCw, Search, Video } from 'lucide-react';
import type { MonitorRoomDescriptor } from '../../shared/types';
import type { RoomPlaybackPreference } from './preferences';
import type { PlayerStatus } from './playbackSession';
import { ActionButton, InfoPopover, SegmentedControl, UiSelect } from '../ui';
import { RoomLookupDialog } from '../RoomLookupDialog';
import { MonitorRoomCandidate } from './MonitorRoomCandidate';
import type { CustomRoomRecord } from './customRooms';
import type { FollowingRoomsView } from './useFollowingRooms';
import './roomLibraryPicker.css';

type Collection = 'mine' | 'following';
type View = Collection | 'watching';
type Filters = { search: string; status: string; group: string };
const ROOM_COLLECTION_STORAGE_KEY = 'bwatch-monitor:room-collection:v1';
const emptyFilters = (): Filters => ({ search: '', status: 'all', group: 'all' });
const followingStatusOrder = { live: 0, unknown: 1, offline: 2 };
const trustedAudience = (room: MonitorRoomDescriptor) => !room.onlineStale && room.onlineLastSuccessAt !== undefined
  && room.onlineLastSuccessAt > 0 && room.online !== null && Number.isSafeInteger(room.online) && room.online >= 0 ? room.online : null;

function initialCollection(): Collection {
  try {
    const saved = localStorage.getItem(ROOM_COLLECTION_STORAGE_KEY);
    if (saved === 'mine' || saved === 'following') return saved;
  } catch { /* Browser storage can be unavailable. */ }
  return 'mine';
}

interface Props {
  active: boolean; savedRooms: MonitorRoomDescriptor[];
  following: FollowingRoomsView;
  onFollowingActiveChange: (active: boolean) => void;
  onOpenFollowingSetup: () => void;
  selectedRooms: MonitorRoomDescriptor[]; savedIds: ReadonlySet<string>; unavailableIds: ReadonlySet<string>;
  roomPreferences: Record<string, RoomPlaybackPreference>; onRestoreVideo?: (id: string) => void;
  playbackStatuses?: Record<string, PlayerStatus>;
  adaptiveGridEnabled: boolean; maxWatchingRooms: number;
  ready: boolean; draggingId: string | null;
  resolveRoom: (input: string, signal: AbortSignal) => Promise<CustomRoomRecord>;
  onSave: (room: MonitorRoomDescriptor) => boolean; onRemoveSaved: (id: string) => void;
  onWatch: (room: MonitorRoomDescriptor) => boolean; onToggle: (id: string) => void; onLocate: (id: string) => void;
  onRevalidate: (id: string, signal: AbortSignal) => Promise<void>;
  onAddLive: (rooms: MonitorRoomDescriptor[]) => void; onClearWatching: () => void;
  onDragStart: (event: React.PointerEvent<HTMLElement>, id: string) => void;
  onClickCapture: (event: React.MouseEvent<HTMLElement>) => void;
}

/** Directory browsing, personal saves and watching are separate views of the
 * same room identity. This component owns presentation, never media sessions. */
export function RoomLibraryPicker(props: Props) {
  const [collection, setCollection] = useState(initialCollection);
  const [watching, setWatching] = useState(false);
  const [filters, setFilters] = useState<Record<Collection, Filters>>({ mine: emptyFilters(), following: emptyFilters() });
  const [addOpen, setAddOpen] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [requestMessage, setRequestMessage] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const scrollPositions = useRef<Record<View, number>>({ mine: 0, following: 0, watching: 0 });
  const order = useRef<string[]>([]);
  const view: View = watching ? 'watching' : collection;
  const current = filters[collection];
  const selected = new Set(props.selectedRooms.map(room => room.roomId));
  const sourceRooms = watching ? props.selectedRooms : collection === 'following' ? props.following.rooms : props.savedRooms;
  const filtered = watching ? sourceRooms : sourceRooms.filter(room => {
    if (current.status === 'live' && room.status !== 'live') return false;
    if (current.status === 'selected' && !selected.has(room.roomId)) return false;
    const query = current.search.trim().toLocaleLowerCase();
    return !query || `${room.anchorName} ${room.title} ${room.roomId}`.toLocaleLowerCase().includes(query);
  });
  if (!watching && collection === 'following') {
    const positions = new Map(sourceRooms.map((room, index) => [room.roomId, index]));
    filtered.sort((a, b) => {
      const status = followingStatusOrder[a.status] - followingStatusOrder[b.status];
      if (status) return status;
      const left = trustedAudience(a), right = trustedAudience(b);
      if (left !== right) return left === null ? 1 : right === null ? -1 : right - left;
      return (positions.get(a.roomId) ?? 0) - (positions.get(b.roomId) ?? 0);
    });
  } else if (!watching) filtered.sort((a, b) => (b.online ?? 0) - (a.online ?? 0));
  if (!props.draggingId) order.current = filtered.map(room => room.roomId);
  else {
    const positions = new Map(order.current.map((id, index) => [id, index]));
    filtered.sort((a, b) => (positions.get(a.roomId) ?? Infinity) - (positions.get(b.roomId) ?? Infinity));
  }
  const updateFilters = (patch: Partial<Filters>) => setFilters(value => ({ ...value, [collection]: { ...value[collection], ...patch } }));
  const changeView = (next: View) => {
    if (props.draggingId) return;
    scrollPositions.current[view] = scroller.current?.scrollTop ?? 0;
    setWatching(next === 'watching');
    if (next !== 'watching' && next !== collection) {
      setCollection(next);
      try { localStorage.setItem(ROOM_COLLECTION_STORAGE_KEY, next); }
      catch { /* The selection still applies to the current page. */ }
    }
    setHighlight(null); setRequestMessage('');
  };
  useLayoutEffect(() => { if (scroller.current) scroller.current.scrollTop = scrollPositions.current[view]; }, [view]);
  const followingActive = props.active && view === 'following';
  useEffect(() => {
    props.onFollowingActiveChange(followingActive);
    return () => props.onFollowingActiveChange(false);
  }, [followingActive, props.onFollowingActiveChange]);
  useEffect(() => {
    const cancel = () => { request.current?.abort(); request.current = null; setBusyId(null); setAddOpen(false); };
    window.addEventListener('pagehide', cancel);
    return () => { cancel(); window.removeEventListener('pagehide', cancel); };
  }, []);
  useEffect(() => { if (!props.active) setAddOpen(false); }, [props.active]);
  useEffect(() => {
    if (!highlight || view !== 'mine') return;
    const frame = window.requestAnimationFrame(() => {
      const card = scroller.current?.querySelector<HTMLElement>(`[data-placement-source="${highlight}"]`);
      if (card && scroller.current) {
        scroller.current.scrollTop += card.getBoundingClientRect().top - scroller.current.getBoundingClientRect().top - 4;
        card.querySelector<HTMLElement>('.mv-candidate-toggle')?.focus({ preventScroll: true });
      }
    });
    const timer = window.setTimeout(() => setHighlight(null), 1600);
    return () => { window.cancelAnimationFrame(frame); window.clearTimeout(timer); };
  }, [highlight, view]);
  const revealSaved = (id: string) => {
    changeView('mine'); setFilters(value => ({ ...value, mine: emptyFilters() })); setHighlight(id);
  };
  const revalidateRoom = async (id: string) => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller; setBusyId(id); setRequestMessage('');
    try {
      await props.onRevalidate(id, controller.signal);
      if (!controller.signal.aborted) setRequestMessage('已重新验证公开房间，可以加入观看');
    } catch (error) {
      if (!controller.signal.aborted) setRequestMessage(error instanceof Error ? error.message : '信息更新失败，请稍后重试');
    } finally { if (request.current === controller) { request.current = null; setBusyId(null); } }
  };
  const searchLabel = collection === 'following' ? '筛选B站关注：主播、标题、房间号' : '筛选我的房间：主播、标题、房间号';
  const followingView = view === 'following';
  const loadedCount = sourceRooms.length, loadedLive = sourceRooms.filter(room => room.status === 'live').length;
  const totalCount = loadedCount, liveCount = loadedLive;
  const unknownCount = sourceRooms.filter(room => room.status === 'unknown').length;
  const unmappedCount = followingView ? props.following.unmappedCount : 0;
  const partialCount = followingView && !props.following.complete;
  const retainedPartial = partialCount && props.following.scannedPages === 0 && props.following.loadedCount === 0 && loadedCount > 0;
  const countDescription = retainedPartial ? `暂显示上次部分关注结果：${loadedCount} 个，列表尚未读取完整`
    : partialCount ? `已读取 ${props.following.loadedCount} 个关注直播间，结果尚未完整`
    : unmappedCount > 0 ? `开播 ${liveCount} / 已识别直播间 ${totalCount}+；部分关注账号暂未确认房间，后续会自动更新`
    : unknownCount ? `已确认开播 ${liveCount} / 总直播间 ${totalCount}，${unknownCount} 个房间状态暂未确认` : `开播 ${liveCount} / 总直播间 ${totalCount}`;
  const followingState = !followingView ? undefined : props.following.indexing ? 'loading'
    : props.following.status === 'error' ? 'error' : props.following.complete ? 'complete' : 'partial';
  const followingProgress = !followingView ? undefined : props.following.indexing
    ? `${props.following.refreshKind === 'status' ? '正在更新开播状态' : '正在同步关注'}${props.following.refreshing || retainedPartial ? '，暂显示上次结果' : ''}`
    : props.following.status === 'error' ? `${props.following.refreshKind === 'status' ? '开播状态更新未完成' : '关注同步未完成'}${loadedCount ? '，暂显示上次结果' : ''}`
      : partialCount ? '关注列表尚未读取完整' : '关注已同步';
  const renderRoom = (room: MonitorRoomDescriptor) => <MonitorRoomCandidate room={room} collection={watching ? 'watching' : collection} saved={props.savedIds.has(room.roomId)}
    selected={selected.has(room.roomId)} unavailable={props.unavailableIds.has(room.roomId)} refreshing={busyId === room.roomId}
    disabled={!props.ready || (!selected.has(room.roomId) && selected.size >= props.maxWatchingRooms)} dragging={props.draggingId === room.roomId}
    onToggle={() => props.onToggle(room.roomId)} onPointerDown={event => props.onDragStart(event, room.roomId)} onClickCapture={props.onClickCapture}
    mediaMode={props.roomPreferences[room.roomId]?.mediaMode} playbackStatus={props.playbackStatuses?.[room.roomId]} onRestoreVideo={props.onRestoreVideo ? () => props.onRestoreVideo!(room.roomId) : undefined}
    onSave={() => { if (props.onSave(room)) revealSaved(room.roomId); }} onRemoveSaved={() => props.onRemoveSaved(room.roomId)}
    onRevalidate={props.unavailableIds.has(room.roomId) ? () => void revalidateRoom(room.roomId) : undefined} />;

  return <div className="mv-library-picker" hidden={!props.active} data-keep-controls={addOpen ? 'true' : undefined}>
    <div className="mv-room-picker-controls">
      <div className="mv-sidebar-heading mv-library-heading"><strong className="mv-library-title">{watching ? <button className="mv-library-back" onClick={() => changeView(collection)}><ArrowLeft size={14} />观看列表</button> : '直播间'}
        {!watching && collection === 'mine' && <InfoPopover label="我的房间仅保存在当前浏览器">仅保存在当前浏览器，不会同步到其他设备。</InfoPopover>}</strong>
        <button className="mv-text-button mv-watching-entry" aria-pressed={watching} onClick={() => changeView(watching ? collection : 'watching')}>观看中 {props.selectedRooms.length}/{props.maxWatchingRooms}</button></div>
      {!watching && <>
        <SegmentedControl label="房间来源" value={collection} defaultValue="mine" onChange={value => changeView(value)}
          options={[{ value: 'mine', label: '我的房间', icon: <Bookmark size={14} /> },
            { value: 'following', label: 'B站关注', icon: <BilibiliTvIcon /> }]} className="mv-library-tabs" />
        <label className="mv-search"><Search size={15} /><input aria-label={searchLabel} placeholder={searchLabel} value={current.search} onChange={event => updateFilters({ search: event.target.value })} /></label>
        <div className="mv-filter-row"><UiSelect label="筛选直播状态" value={current.status} onChange={status => updateFilters({ status })}
          options={[{ value: 'all', label: '全部直播间' }, { value: 'live', label: '正在直播' }, { value: 'selected', label: '正在观看' }]} />
          {collection === 'following' ? <ActionButton className="mv-library-refresh-following" onClick={props.following.reload}
              busy={props.following.indexing} busyLabel="刷新关注" busyIcon={<RefreshCw size={14} className="spin" />}
              disabled={Boolean(props.draggingId) || !['ready', 'error'].includes(props.following.status)}><RefreshCw size={14} /><span>刷新关注</span></ActionButton>
              : <ActionButton className="mv-library-add-room" onClick={() => setAddOpen(true)}><Plus size={14} /><span>添加自定义直播间</span></ActionButton>}</div>
      </>}
      <div className="mv-quick-actions">{watching ? <span className="mv-library-caption">已加入当前布局</span>
        : <button onClick={() => props.onAddLive(filtered)} title={partialCount ? '全部读取完成后可批量加入，单个直播间可直接加入' : undefined}
          disabled={partialCount || !props.ready || selected.size >= props.maxWatchingRooms || !filtered.some(room => room.status === 'live' && !selected.has(room.roomId) && !props.unavailableIds.has(room.roomId))}>加入筛选内开播</button>}
        <span className="mv-library-room-count" aria-label={countDescription} aria-description={followingProgress}
          role={followingView ? 'status' : undefined} aria-busy={followingView ? props.following.indexing : undefined} data-following-state={followingState}
          title={followingProgress ? `${followingProgress}；${countDescription}` : countDescription}>
          {followingView && props.following.indexing ? <RefreshCw size={11} className="mv-spin" aria-hidden="true" />
            : followingView && props.following.status === 'error' ? <AlertCircle size={11} aria-hidden="true" /> : null}
          {retainedPartial ? <><small>已显示</small>{loadedCount}</>
          : partialCount ? <><small>已读取</small>{props.following.loadedCount}</> : <>{liveCount}{unknownCount > 0 && '+'}<span>/</span>{totalCount}{unmappedCount > 0 && '+'}</>}</span>
        <button disabled={!selected.size} onClick={props.onClearWatching}>清空观看</button></div>
      {(requestMessage || busyId) && <div className="mv-library-feedback" role="status">{busyId ? <><RefreshCw size={12} className="mv-spin" />正在获取房间信息…</> : requestMessage}</div>}
    </div>
    {followingView ? <FollowingCandidateList scroller={scroller} rooms={filtered} active={followingActive} dragging={Boolean(props.draggingId)}
      restoreTop={scrollPositions.current.following} onScroll={position => { scrollPositions.current.following = position; }} renderRoom={renderRoom}
      following={props.following} filtered={Boolean(current.search.trim() || current.status !== 'all')} onSetup={props.onOpenFollowingSetup}
      filterKey={`${current.search.trim()}|${current.status}`} onVisibleRoomIds={props.following.setVisibleRoomIds} />
      : <AnimatedCandidateList scroller={scroller} view={view} rooms={filtered} active={props.active} highlight={highlight} restoreTop={scrollPositions.current[view]}
      label={watching ? '正在观看的直播间' : '我的房间列表'}
      onScroll={position => { scrollPositions.current[view] = position; }}
      renderRoom={renderRoom}
      empty={!props.ready && !sourceRooms.length ? <p className="mv-note">正在连接浏览器扩展…</p> : <div className="mv-library-empty">
          {collection === 'mine' && !props.savedRooms.length && !watching ? <><Bookmark size={25} /><strong>收藏你想看的直播间</strong>
            <p className="mv-library-empty-intro">添加自定义直播间，或连接 B站账号查看关注直播间。</p>
            <div className="mv-library-start-actions">
              <button type="button" className="mv-library-start-custom" aria-label="添加自定义直播间" onClick={() => setAddOpen(true)}>
                <Plus size={18} /><span><strong>添加自定义直播间</strong><small>输入房间号或 B站直播链接</small></span><ChevronRight size={15} /></button>
              <button type="button" aria-label="查看B站关注" onClick={() => changeView('following')}>
                <BilibiliTvIcon /><span><strong>查看 B站关注</strong><small>连接本机账号，收藏关注的直播间</small></span><ChevronRight size={15} /></button>
            </div></>
            : watching ? <><Video size={24} /><strong>当前没有观看中的房间</strong><button className="mv-text-button" onClick={() => changeView('mine')}>浏览我的房间</button></>
              : <><Search size={24} /><strong>没有匹配的直播间</strong><button className="mv-text-button" onClick={() => updateFilters(emptyFilters())}>清除筛选</button></>}
        </div>} />}
    <AddRoomDialog open={addOpen} onClose={() => setAddOpen(false)} savedIds={props.savedIds} selectedIds={selected}
      adaptiveGridEnabled={props.adaptiveGridEnabled} maxWatchingRooms={props.maxWatchingRooms}
      resolveRoom={props.resolveRoom} onSave={props.onSave} onWatch={props.onWatch} onLocate={props.onLocate} onReveal={revealSaved} />
  </div>;
}

function BilibiliTvIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m8 3 3 3m5-3-3 3" /><rect x="3" y="6" width="18" height="14" rx="3" /><path d="M8 11v3m8-3v3m-6 3h4M7 21v-1m10 1v-1" />
  </svg>;
}

/** Only the visible following cards own image DOM. Paging never mounts the
 * complete account list or touches the media/dragging lifecycle. */
function FollowingCandidateList({ rooms, active, dragging, restoreTop, scroller, following, filtered, filterKey, onSetup, onScroll, renderRoom, onVisibleRoomIds }: {
  rooms: MonitorRoomDescriptor[]; active: boolean; dragging: boolean; restoreTop: number;
  scroller: React.RefObject<HTMLDivElement | null>; following: FollowingRoomsView; filtered: boolean; onSetup: () => void;
  filterKey: string;
  onScroll: (top: number) => void; renderRoom: (room: MonitorRoomDescriptor) => React.ReactNode;
  onVisibleRoomIds: (ids: string[]) => void;
}) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [foreground, setForeground] = useState(() => !document.hidden);
  const [, updateViewport] = useState(0);
  const previousOrder = useRef<{ ids: string[]; key: string; filter: string }>({ ids: [], key: '', filter: '' });
  const anchor = useRef<{ id: string; offset: number } | null>(null);
  const admitted = useRef<Set<string> | null>(null);
  const adjustedTop = useRef<number | null>(null);
  const published = useRef<{ key: string; callback: typeof onVisibleRoomIds } | null>(null);
  const publishVisible = useCallback((key: string) => {
    if (published.current?.key === key && published.current.callback === onVisibleRoomIds) return;
    published.current = { key, callback: onVisibleRoomIds };
    onVisibleRoomIds(key ? key.split(',') : []);
  }, [onVisibleRoomIds]);
  const attachScroller = useCallback((node: HTMLDivElement | null) => { scroller.current = node; setElement(node); }, [scroller]);
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({ count: rooms.length, getScrollElement: () => element,
    estimateSize: () => 90, getItemKey: index => rooms[index]?.roomId ?? index, overscan: 4, enabled: active,
    initialOffset: restoreTop,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const orderKey = rooms.map(room => room.roomId).join(',');
  const orderChanged = previousOrder.current.key !== orderKey || previousOrder.current.filter !== filterKey;
  // Rendering overscan is independent of HTTP demand. Fetch only intersecting
  // rows and one neighbor on either side, even if more artwork is mounted.
  const offset = virtualizer.scrollOffset ?? 0;
  const viewportHeight = virtualizer.scrollRect?.height ?? element?.clientHeight ?? 0;
  const visibleItems = viewportHeight > 0 ? virtualItems.filter(item => item.end > offset && item.start < offset + viewportHeight) : [];
  const firstIndex = visibleItems[0]?.index, lastIndex = visibleItems[visibleItems.length - 1]?.index;
  const nearbyIds = firstIndex === undefined || lastIndex === undefined ? []
    : rooms.slice(Math.max(0, firstIndex - 1), Math.min(rooms.length, lastIndex + 2)).map(room => room.roomId);
  // Metadata updates preserve this key and never restart the same demand.
  const visibleIdKey = active && foreground ? [...new Set(nearbyIds.filter(id => !admitted.current || admitted.current.has(id)))].slice(0, 32).join(',') : '';
  useLayoutEffect(() => {
    if (!orderChanged) return;
    const previous = previousOrder.current, ids = rooms.map(room => room.roomId), previousIds = new Set(previous.ids);
    const reordered = previous.filter === filterKey && previous.ids.length === ids.length && ids.every(id => previousIds.has(id));
    if (reordered) {
      // Count updates may reorder the same cards. Keep the reading anchor and
      // do not turn newly exposed rows into an automatic offscreen count scan.
      admitted.current ??= new Set(published.current?.key.split(',').filter(Boolean) ?? []);
      if (active && anchor.current) {
        const index = ids.indexOf(anchor.current.id), target = index >= 0 ? virtualizer.getOffsetForIndex(index, 'start') : undefined;
        if (target) { virtualizer.scrollToOffset(target[0] + anchor.current.offset, { align: 'start', behavior: 'auto' }); adjustedTop.current = element?.scrollTop ?? null; }
      }
    } else admitted.current = null;
    previousOrder.current = { ids, key: orderKey, filter: filterKey };
    updateViewport(value => value + 1);
  }, [orderKey, filterKey, orderChanged, active, element, virtualizer]);
  useLayoutEffect(() => {
    if (orderChanged) return;
    const first = visibleItems[0];
    anchor.current = first && rooms[first.index] ? { id: rooms[first.index].roomId, offset: offset - first.start } : null;
    publishVisible(visibleIdKey);
  }, [visibleIdKey, publishVisible, orderChanged, offset, orderKey]);
  useLayoutEffect(() => { if (active && foreground) { admitted.current = null; updateViewport(value => value + 1); } }, [active, foreground]);
  useEffect(() => {
    const update = () => {
      const visible = !document.hidden;
      if (!visible) publishVisible('');
      setForeground(visible);
    };
    const leave = () => { publishVisible(''); setForeground(false); };
    document.addEventListener('visibilitychange', update);
    window.addEventListener('pagehide', leave); window.addEventListener('pageshow', update);
    return () => { publishVisible(''); document.removeEventListener('visibilitychange', update);
      window.removeEventListener('pagehide', leave); window.removeEventListener('pageshow', update); };
  }, [publishVisible]);
  const unavailable = ['not-installed', 'update-required', 'login-required'].includes(following.status);
  const preparing = ['idle', 'loading', 'restoring'].includes(following.status) || following.indexing;
  const heading = following.status === 'not-installed' ? '安装扩展，查看B站关注'
    : following.status === 'update-required' ? '更新扩展，查看B站关注'
      : following.status === 'login-required' ? '连接B站账号，查看关注直播间'
        : preparing ? '正在同步关注…' : following.status === 'error' ? '暂时无法获取B站关注'
          : !following.complete ? '关注列表尚未读取完整' : filtered ? '没有匹配的关注直播间'
            : following.unmappedCount > 0 ? '暂未找到关注的直播间' : '暂无关注的直播间';
  return <div className="mv-library-list-frame mv-following-frame">
    <div ref={attachScroller} className="mv-room-candidates mv-library-list mv-following-list ui-scrollbar"
      aria-label="B站关注直播间列表" data-placement-scroll onScroll={event => {
        const top = event.currentTarget.scrollTop;
        if (adjustedTop.current !== null && Math.abs(adjustedTop.current - top) < 1) adjustedTop.current = null;
        else { adjustedTop.current = null; admitted.current = null; updateViewport(value => value + 1); }
        onScroll(top);
      }}>
      {rooms.length > 0 ? <div className="mv-following-virtual" style={{ height: virtualizer.getTotalSize() }}>
        {virtualItems.map(item => <div key={item.key} ref={virtualizer.measureElement} data-index={item.index}
          className="mv-following-virtual-row" style={{ transform: `translateY(${item.start}px)` }}>{renderRoom(rooms[item.index])}</div>)}
      </div> : <div className="mv-library-empty mv-following-empty" role={preparing ? 'status' : undefined}>
        {preparing ? <RefreshCw size={24} className="mv-spin" /> : <BilibiliTvIcon />}<strong>{heading}</strong>
        {unavailable && <><p>关注列表仅在当前浏览器读取。</p><div className="mv-library-start-actions">
          <button type="button" onClick={onSetup} aria-label={following.status === 'not-installed' ? '安装浏览器扩展' : following.status === 'update-required' ? '更新浏览器扩展' : '连接B站账号'}>
            {following.status === 'update-required' ? <RefreshCw size={18} /> : <BilibiliTvIcon />}<span>
              <strong>{following.status === 'not-installed' ? '安装浏览器扩展' : following.status === 'update-required' ? '更新浏览器扩展' : '连接B站账号'}</strong>
              <small>{following.status === 'not-installed' ? '安装 BWatch Companion，接入关注列表' : following.status === 'update-required' ? '更新 BWatch Companion，继续查看关注' : '登录并授权，查看关注的直播间'}</small>
            </span><ChevronRight size={15} /></button></div></>}
      </div>}
      {!unavailable && following.status === 'error' && <div className="mv-following-footer" role="status">
        <p>{following.error || following.incompleteReason || '获取失败，请稍后重试'}{following.refreshing ? '；暂显示上次结果' : '，当前筛选结果可能不全'}</p>
        <button className="mv-text-button" disabled={following.indexing || dragging} onClick={following.loadMore}>重试获取</button>
      </div>}
    </div>
  </div>;
}

type ExitCard = { key: string; room: MonitorRoomDescriptor; top: number; left: number; width: number; height: number };

/** Retain only visible, inert card artwork during exits. This list never owns
 * player sessions, subscriptions or a second scroll surface. */
function AnimatedCandidateList({ view, rooms, active, highlight, restoreTop, scroller, label, onScroll, renderRoom, empty }: {
  view: View; rooms: MonitorRoomDescriptor[]; active: boolean; highlight: string | null; restoreTop: number;
  scroller: React.RefObject<HTMLDivElement | null>; label: string; onScroll: (top: number) => void;
  renderRoom: (room: MonitorRoomDescriptor) => React.ReactNode; empty: React.ReactNode;
}) {
  const [displayed, setDisplayed] = useState({ view, rooms });
  const [exits, setExits] = useState<ExitCard[]>([]);
  const frame = useRef<HTMLDivElement>(null);
  const rows = useRef(new Map<string, HTMLDivElement>());
  const animations = useRef<Animation[]>([]);
  const removalTimer = useRef<number | undefined>(undefined);
  const pending = useRef<{ previousView: View; bounds: Map<string, DOMRect> } | null>(null);
  const renderedView = useRef(view);
  const desiredKey = JSON.stringify([view, rooms.map(room => room.roomId)]);
  const currentKey = JSON.stringify([displayed.view, displayed.rooms.map(room => room.roomId)]);
  const latest = new Map(rooms.map(room => [room.roomId, room]));
  const clearMotion = () => {
    animations.current.forEach(animation => animation.cancel()); animations.current = [];
    window.clearTimeout(removalTimer.current); removalTimer.current = undefined;
  };
  useLayoutEffect(() => {
    if (desiredKey === currentKey) return;
    const bounds = new Map([...rows.current].map(([id, node]) => [id, node.getBoundingClientRect()]));
    const boundary = frame.current?.getBoundingClientRect();
    const reduce = !active || document.hidden || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    clearMotion();
    const leaving = boundary && !reduce ? displayed.rooms.filter(room => displayed.view !== view || !latest.has(room.roomId))
      .flatMap(room => {
        const rect = bounds.get(room.roomId);
        return rect && rect.bottom > boundary.top && rect.top < boundary.bottom && rect.width
          ? [{ key: `${displayed.view}:${room.roomId}`, room, top: rect.top - boundary.top, left: rect.left - boundary.left, width: rect.width, height: rect.height }] : [];
      }).slice(0, 32) : [];
    setExits(leaving);
    pending.current = reduce ? null : { previousView: displayed.view, bounds };
    setDisplayed({ view, rooms });
    if (leaving.length) removalTimer.current = window.setTimeout(() => { setExits([]); removalTimer.current = undefined; }, 180);
  }, [desiredKey, currentKey, active]);
  useLayoutEffect(() => {
    if (renderedView.current !== displayed.view && scroller.current) scroller.current.scrollTop = restoreTop;
    renderedView.current = displayed.view;
    const motion = pending.current;
    pending.current = null;
    if (!motion || !active || document.hidden) return;
    for (const [id, node] of rows.current) {
      if (!node.animate) continue;
      const previous = motion.previousView === displayed.view ? motion.bounds.get(id) : undefined;
      const next = node.getBoundingClientRect();
      const dy = previous ? previous.top - next.top : 5;
      const dx = previous ? previous.left - next.left : 0;
      if (previous && Math.abs(dy) < .5 && Math.abs(dx) < .5) continue;
      const animation = node.animate([{ transform: `translate(${dx}px, ${dy}px)`, opacity: previous ? 1 : 0 },
        { transform: 'translate(0, 0)', opacity: 1 }], { duration: 180, easing: 'cubic-bezier(.22,1,.36,1)' });
      animations.current.push(animation);
      animation.onfinish = () => { animations.current = animations.current.filter(item => item !== animation); };
    }
  }, [displayed, active]);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const stop = () => { clearMotion(); pending.current = null; setExits([]); };
    const visibility = () => { if (document.hidden) stop(); };
    const reduce = () => { if (media.matches) stop(); };
    media.addEventListener('change', reduce); document.addEventListener('visibilitychange', visibility); document.addEventListener('fullscreenchange', stop); window.addEventListener('pagehide', stop);
    return () => { clearMotion(); media.removeEventListener('change', reduce); document.removeEventListener('visibilitychange', visibility); document.removeEventListener('fullscreenchange', stop); window.removeEventListener('pagehide', stop); };
  }, []);
  useEffect(() => { if (!active) { clearMotion(); pending.current = null; setExits([]); } }, [active]);
  return <div ref={frame} className="mv-library-list-frame">
    <div ref={scroller} className="mv-room-candidates mv-library-list ui-scrollbar" aria-label={label} data-placement-scroll onScroll={event => onScroll(event.currentTarget.scrollTop)}>
      <div className="mv-library-list-content">
        {displayed.rooms.length ? displayed.rooms.map(room => <div key={`${displayed.view}:${room.roomId}`} ref={node => { if (node) rows.current.set(room.roomId, node); else rows.current.delete(room.roomId); }}
          className="mv-library-card-wrap" data-highlighted={highlight === room.roomId}>{renderRoom(displayed.view === view ? latest.get(room.roomId) ?? room : room)}</div>) : empty}
      </div>
    </div>
    {exits.length > 0 && <div className="mv-library-exits" aria-hidden="true" inert>{exits.map(exit => <div key={exit.key} className="mv-library-exit-card"
      style={{ top: exit.top, left: exit.left, width: exit.width, height: exit.height }}>
      <div className="mv-library-exit-art"><span className="mv-candidate-cover">{exit.room.cover ? <img src={exit.room.cover} alt="" referrerPolicy="no-referrer" /> : <Video size={20} />}</span>
        <span><strong>{exit.room.anchorName}</strong><small>自定义</small><span>{exit.room.title}</span></span></div>
    </div>)}</div>}
  </div>;
}

function AddRoomDialog({ open, onClose, savedIds, selectedIds, adaptiveGridEnabled, maxWatchingRooms, resolveRoom, onSave, onWatch, onLocate, onReveal }: {
  open: boolean; onClose: () => void; savedIds: ReadonlySet<string>; selectedIds: ReadonlySet<string>;
  adaptiveGridEnabled: boolean; maxWatchingRooms: number;
  resolveRoom: Props['resolveRoom']; onSave: Props['onSave']; onWatch: Props['onWatch']; onLocate: Props['onLocate']; onReveal: (id: string) => void;
}) {
  return <RoomLookupDialog open={open} onClose={onClose} title="添加自定义直播间" knownRooms={[]} resolveRoom={resolveRoom}
    renderBadges={room => <>
      {savedIds.has(room.roomId) && <span><Check size={12} />已保存</span>}{selectedIds.has(room.roomId) && <span>正在观看</span>}</>}
    renderActions={(room, { complete, reportError }) => {
      const saved = savedIds.has(room.roomId), watching = selectedIds.has(room.roomId);
      const commit = (watch: boolean) => {
        if (!saved && !onSave(room)) { reportError('房间未能保存，请检查保存容量或浏览器存储后重试'); return; }
        if (watch && !onWatch(room)) { reportError('房间已保存，但尚未加入观看，请检查观看容量后重试'); return; }
        onReveal(room.roomId); complete();
      };
      return <><div className="ui-dialog-actions">{saved ? <button className="secondary" onClick={() => { onReveal(room.roomId); onClose(); }}>查看我的房间</button>
        : <button className="secondary" disabled={savedIds.size >= 256} onClick={() => commit(false)}>保存到我的房间</button>}
        {watching ? <button className="primary" onClick={() => { onClose(); onLocate(room.roomId); }}>定位画面</button>
          : <button className="primary" disabled={selectedIds.size >= maxWatchingRooms || (!saved && savedIds.size >= 256)} onClick={() => commit(true)}>{saved ? '加入观看' : '保存并观看'}</button>}</div>
        {selectedIds.size >= maxWatchingRooms && !watching && <p className="mv-library-limit">{adaptiveGridEnabled
          ? `已达 ${maxWatchingRooms} 路上限；请先移出正在观看的房间，再加入新的直播间。`
          : `已达 ${maxWatchingRooms} 路；仍可保存房间，再从卡片拖入已有画面进行替换。`}</p>}
        {savedIds.size >= 256 && !saved && <p className="mv-library-limit">已保存 256 个房间，请先从我的房间移除记录。</p>}</>;
    }} />;
}
