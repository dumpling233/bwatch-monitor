import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowLeft, Bold, Layers, MessageSquare, MessageSquareOff, Minus, RefreshCw, RotateCcw, ScrollText, SlidersHorizontal, Type } from 'lucide-react';
import { AnimatedCollapse, SegmentedControl, ToggleButton, UiSelect, UiSlider } from '../../ui';
import type { DanmakuMessage, DanmakuRoomState } from './types';
import { danmakuFonts, danmakuTextEffects, defaultDanmakuStyle, isDanmakuBlocked, roomDanmakuStyle, type DanmakuFontFamily, type DanmakuPreferences, type DanmakuStyle } from './displayPreferences';
import { DanmakuComposer, type DanmakuChatAdapter, type DanmakuComposerHandle } from './DanmakuComposer';
import { DanmakuMedalToggles, type DanmakuMedalToggleControls } from './DanmakuMedalToggles';
import type { DanmakuRepeatContent, DanmakuRepeatState } from './repeatMessage';
import { DanmakuVirtualList } from './DanmakuVirtualList';
import type { DanmakuHistoryView } from './store';
import './danmaku.css';

export interface DanmakuSidebarProps {
  active?: boolean;
  roomIds: readonly string[];
  visibleIds: readonly string[];
  roomName: (id: string) => string;
  currentRoomId: string | null;
  onRoomChange: (id: string) => void;
  rooms: Record<string, DanmakuRoomState>;
  preferences: DanmakuPreferences;
  onChange: (value: DanmakuPreferences) => void;
  onReconnect: (roomId: string) => void;
  onViewChange?: (view: Exclude<DanmakuHistoryView, 'all'>) => void;
  chat?: DanmakuChatAdapter;
}
const statusLabel: Record<DanmakuRoomState['status'], string> = { idle: '尚未连接', connecting: '正在连接', live: '已连接', retrying: '等待重连', error: '连接失败' };
const roomStatusLabel: Record<DanmakuRoomState['status'], string> = { idle: '未连接', connecting: '连接中', live: '已连接', retrying: '等待重连', error: '连接失败' };
const noMessages: DanmakuMessage[] = [];
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function StyleEditor({ value, onChange, label }: { value: DanmakuStyle; onChange: (style: DanmakuStyle) => void; label: string }) {
  const shadowColor = '#000000';
  const previewShadow = value.textEffect === 'heavy' ? `1px 0 1px ${shadowColor}, 0 1px 1px ${shadowColor}, 0 -1px 1px ${shadowColor}, -1px 0 1px ${shadowColor}`
    : value.textEffect === 'stroke' ? `0 0 1px ${shadowColor}, 0 0 1px ${shadowColor}, 0 0 1px ${shadowColor}`
    : value.textEffect === 'projection' ? `1px 1px 2px ${shadowColor}, 0 0 1px ${shadowColor}` : 'none';
  return <div className="mv-danmaku-style" aria-label={label}>
    <div className="mv-danmaku-settings-section mv-danmaku-basic-settings"><h4>画面显示</h4>
      <UiSlider label="显示区域" ariaLabel={`${label}显示区域`} layout="inline" min={0.25} max={1} value={value.area} snapToMarks
        marks={[0.25, 0.5, 0.75, 1].map(area => ({ value: area }))} formatValue={area => `${Math.round(area * 100)}%`} onChange={area => onChange({ ...value, area })} />
      <UiSlider label="不透明度" ariaLabel={`${label}不透明度`} layout="inline" min={0.1} max={1} step="any" value={value.opacity}
        formatValue={opacity => `${Math.round(opacity * 100)}%`} onChange={opacity => onChange({ ...value, opacity })} />
      <UiSlider label="字号" ariaLabel={`${label}字号`} layout="inline" min={12} max={56} step={1} value={value.fontSize}
        formatValue={fontSize => `${Math.round(fontSize)}px`} onChange={fontSize => onChange({ ...value, fontSize })} />
      <UiSlider label="滚动速度" ariaLabel={`${label}速度`} layout="inline" min={0.5} max={2} step="any" value={value.speed}
        formatValue={speed => `${Math.round(speed * 100)}%`} onChange={speed => onChange({ ...value, speed })} />
      <div className="mv-danmaku-font-mode"><ToggleButton active={value.fixedFontSize} label="固定弹幕大小" ariaLabel={`${label}固定弹幕大小`} onIcon={<Type size={14} />} offIcon={<Type size={14} />}
        onChange={() => onChange({ ...value, fixedFontSize: !value.fixedFontSize })} /><small>开启后使用设定字号，不随画面大小缩放</small></div>
    </div>
    <div className="mv-danmaku-settings-section"><h4>弹幕文字</h4>
      <div className="mv-danmaku-font-controls"><label><span>字体</span><UiSelect label={`${label}字体`} value={value.fontFamily}
        onChange={fontFamily => onChange({ ...value, fontFamily: fontFamily as DanmakuFontFamily })} options={danmakuFonts.map(font => ({ ...font }))} /></label>
        <ToggleButton active={value.bold} label="粗体" ariaLabel={`${label}粗体`} onIcon={<Bold size={14} />} offIcon={<Bold size={14} />}
          onChange={() => onChange({ ...value, bold: !value.bold })} /></div>
      <div className="mv-danmaku-effect-controls"><span>描边类型</span><SegmentedControl value={value.textEffect} defaultValue="heavy" label={`${label}描边类型`}
        options={danmakuTextEffects.map(effect => ({ ...effect }))} onChange={textEffect => onChange({ ...value, textEffect })} /></div>
      <div className="mv-danmaku-text-preview" aria-label={`${label}文字效果预览`}><span style={{ fontFamily: `"${value.fontFamily}", Arial, Helvetica, sans-serif`, fontWeight: value.bold ? 700 : 400, textShadow: previewShadow }}>弹幕效果预览 Aa</span></div>
    </div>
    <div className="mv-danmaku-settings-section"><h4>内容过滤</h4><label className="mv-danmaku-blocked"><span>屏蔽词 <small>每行一个，仅普通弹幕</small></span><textarea className="ui-scrollbar-padded" aria-label={`${label}屏蔽词`} rows={4} maxLength={6500} placeholder="输入要屏蔽的词语" value={value.blockedWords.join('\n')}
      onChange={event => onChange({ ...value, blockedWords: event.target.value.split('\n').slice(0, 100).map(word => word.slice(0, 64)) })} /></label></div>
  </div>;
}

type UserScrollIntent = { direction: 'older' | 'newer' | 'scrollbar'; until: number; version: number; height: number; viewport: number };

export function DanmakuSidebar(props: DanmakuSidebarProps) {
  const { roomIds, roomName, currentRoomId, onRoomChange, rooms, preferences, onChange, onReconnect, onViewChange, chat, active = true } = props;
  const medalToggles: DanmakuMedalToggleControls = { preferences, onToggle: (key, value) => onChange({ ...preferences, [key]: value }) };
  const [mode, setMode] = useState<'danmaku' | 'sc'>('danmaku');
  const [autoScroll, setAutoScroll] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [foreground, setForeground] = useState(!document.hidden);
  const composerRef = useRef<DanmakuComposerHandle>(null);
  const [repeatState, setRepeatState] = useState<DanmakuRepeatState | null>(null);
  const repeatMessage = useCallback((content: DanmakuRepeatContent, roomId: string) => composerRef.current?.repeat(content, roomId) ?? false, []);
  useLayoutEffect(() => { onViewChange?.(active && foreground && !showSettings ? mode : 'none'); },
    [onViewChange, active, foreground, showSettings, mode]);
  const [settingsTarget, setSettingsTarget] = useState('global');
  const [unseen, setUnseen] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const [listElement, setListElement] = useState<HTMLDivElement | null>(null);
  const attachList = useCallback((element: HTMLDivElement | null) => {
    listRef.current = element;
    setListElement(element);
  }, []);
  const settingsRef = useRef<HTMLButtonElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const scrollFrame = useRef<number | null>(null);
  const programmaticVersion = useRef(0);
  const followIntent = useRef(true);
  const manualResumeOnly = useRef(false);
  const userScrollIntent = useRef<UserScrollIntent | null>(null);
  const scrollbarPointer = useRef<number | null>(null);
  const touchY = useRef<number | null>(null);
  const observedScrollTop = useRef<number | null>(null);
  const inputFrame = useRef<number | null>(null);
  const focusFrame = useRef<number | null>(null);
  const previous = useRef({ context: '', scope: '', lastId: '' });
  const contextEnteredAt = useRef(Date.now());
  const state = currentRoomId ? rooms[currentRoomId] : undefined;
  const style = currentRoomId ? roomDanmakuStyle(preferences, currentRoomId) : preferences.defaults;
  const messages = useMemo(() => (mode === 'sc' ? state?.superChats : state?.messages)?.filter(message => mode === 'sc' || !isDanmakuBlocked(message.text, style)) ?? noMessages,
    [mode, state?.superChats, state?.messages, style]);
  const contextKey = `${currentRoomId ?? ''}:${mode}`;
  const viewportCache = useRef(new Map<string, import('./DanmakuVirtualList').DanmakuViewport>());
  const viewportScope = chat?.draftScope ?? (chat?.enabled ? `account:${chat.accountUid ?? ''}` : 'anonymous');
  const previousScope = useRef(viewportScope);
  if (previousScope.current !== viewportScope) {
    viewportCache.current.clear(); previousScope.current = viewportScope;
  }
  const initialViewport = useMemo<import('./DanmakuVirtualList').DanmakuViewport>(() => viewportCache.current.get(contextKey) ?? { following: true }, [contextKey, viewportScope]);
  const viewportFollowing = previous.current.context === contextKey && previous.current.scope === viewportScope ? autoScroll : initialViewport.following;
  const viewportReady = useRef<string | null>(null);
  const scrollRuntime = useRef({ active, showSettings, contextKey, viewportScope });
  scrollRuntime.current = { active, showSettings, contextKey, viewportScope };
  useEffect(() => {
    for (const key of viewportCache.current.keys()) if (!roomIds.includes(key.slice(0, key.lastIndexOf(':')))) viewportCache.current.delete(key);
  }, [roomIds]);
  const settingsRoom = settingsTarget !== 'global' && roomIds.includes(settingsTarget) ? settingsTarget : null;
  const selectedStyle = settingsRoom ? roomDanmakuStyle(preferences, settingsRoom) : preferences.defaults;
  const setRoomEnabled = (id: string, enabled: boolean) => onChange({ ...preferences, rooms: { ...preferences.rooms, [id]: { ...preferences.rooms[id], enabled } } });
  const setAllEnabled = (enabled: boolean) => onChange({ ...preferences, rooms: { ...preferences.rooms, ...Object.fromEntries(roomIds.map(id => [id, { ...preferences.rooms[id], enabled }])) } });
  const allEnabled = roomIds.length > 0 && roomIds.every(id => preferences.rooms[id]?.enabled);
  const someEnabled = !allEnabled && roomIds.some(id => preferences.rooms[id]?.enabled);
  const changeStyle = (next: DanmakuStyle) => onChange(settingsRoom ? { ...preferences, rooms: { ...preferences.rooms, [settingsRoom]: { enabled: preferences.rooms[settingsRoom]?.enabled ?? false, style: next } } } : { ...preferences, defaults: next });

  const stopScroll = useCallback(() => { if (scrollFrame.current !== null) window.cancelAnimationFrame(scrollFrame.current); scrollFrame.current = null; }, []);
  const rememberViewport = (viewport: import('./DanmakuVirtualList').DanmakuViewport) => {
    if (viewportReady.current !== contextKey) return;
    viewportCache.current.delete(contextKey);
    viewportCache.current.set(contextKey, { ...viewport, following: followIntent.current, manualResumeOnly: manualResumeOnly.current });
    while (viewportCache.current.size > 96) viewportCache.current.delete(viewportCache.current.keys().next().value!);
  };
  const handleViewportReady = (ready: boolean, viewport?: import('./DanmakuVirtualList').DanmakuViewport) => {
    viewportReady.current = ready ? contextKey : null;
    if (!ready) { stopScroll(); return; }
    followIntent.current = (viewport ?? initialViewport).following;
    if (previous.current.context !== contextKey || previous.current.scope !== viewportScope) {
      manualResumeOnly.current = Boolean((viewport ?? initialViewport).manualResumeOnly);
    }
    setAutoScroll(followIntent.current);
  };
  const retainScrollbarIntent = (element: HTMLElement) => {
    const intent = userScrollIntent.current;
    if (scrollbarPointer.current === null || intent?.direction !== 'scrollbar') return false;
    // Native thumb dragging suppresses pointermove until release. Measuring a
    // newly visible virtual row must not erase that still-held user gesture.
    intent.version = programmaticVersion.current;
    intent.height = element.scrollHeight; intent.viewport = element.clientHeight;
    return true;
  };
  const recordProgrammaticScroll = (element: HTMLElement) => {
    observedScrollTop.current = element.scrollTop;
    programmaticVersion.current += 1;
    if (!retainScrollbarIntent(element)) userScrollIntent.current = null;
  };
  const writeScrollPosition = (element: HTMLElement, top: number) => {
    const before = element.scrollTop;
    element.scrollTop = top;
    if (element.scrollTop !== before) recordProgrammaticScroll(element);
  };
  const atLatest = (element: HTMLElement) => Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop) <= 2;
  const validUserScroll = (element: HTMLElement, intent: UserScrollIntent | null): intent is UserScrollIntent => Boolean(intent
    // Native thumb dragging suppresses DOM pointermove events until release.
    // Its explicit pointer-down intent remains valid through a stationary pause.
    && (performance.now() <= intent.until || (intent.direction === 'scrollbar' && scrollbarPointer.current !== null))
    && intent.version === programmaticVersion.current
    && ((intent.direction === 'scrollbar' && scrollbarPointer.current !== null)
      || (intent.height === element.scrollHeight && intent.viewport === element.clientHeight)));
  const scrollToLatest = (immediate = false) => {
    const element = listRef.current;
    if (!element || document.hidden || !active || showSettings || viewportReady.current !== contextKey) return;
    if (!immediate && (!followIntent.current || scrollbarPointer.current !== null || touchY.current !== null)) return;
    const latest = () => Math.max(0, element.scrollHeight - element.clientHeight);
    if (immediate || reducedMotion()) { stopScroll(); writeScrollPosition(element, latest()); return; }
    if (scrollFrame.current !== null) return;
    if (Math.abs(latest() - element.scrollTop) <= .5) { writeScrollPosition(element, latest()); return; }
    let lastTime = performance.now();
    let position = element.scrollTop;
    let writtenPosition = position;
    const step = (time: number) => {
      const runtime = scrollRuntime.current;
      if (!followIntent.current || document.hidden || !element.isConnected || !runtime.active || runtime.showSettings
        || runtime.contextKey !== contextKey || runtime.viewportScope !== viewportScope || viewportReady.current !== contextKey
        || scrollbarPointer.current !== null || touchY.current !== null) { stopScroll(); return; }
      // One loop owns all follow motion. Observe the current measured extent
      // on each active frame; arrivals/ResizeObserver only wake this same loop.
      const target = latest();
      if (reducedMotion()) { writeScrollPosition(element, target); stopScroll(); return; }
      const elapsed = Math.max(0, Math.min(64, time - lastTime)); lastTime = time;
      // Keep the fractional trajectory between frames. Starting each step at
      // quantized scrollTop loses small advances and snaps the remaining tail.
      // Rebase only by external measurement/eviction corrections so those
      // preserve their layout anchor without discarding accumulated progress.
      position += element.scrollTop - writtenPosition;
      const distance = target - position;
      if (Math.abs(distance) <= .5) { writeScrollPosition(element, target); scrollFrame.current = null; return; }
      position += distance * (1 - Math.exp(-elapsed / 105));
      writeScrollPosition(element, position);
      writtenPosition = element.scrollTop;
      scrollFrame.current = window.requestAnimationFrame(step);
    };
    scrollFrame.current = window.requestAnimationFrame(step);
  };
  useLayoutEffect(() => {
    if (!active || showSettings) {
      stopScroll(); userScrollIntent.current = null; scrollbarPointer.current = null; touchY.current = null;
      if (inputFrame.current !== null) window.cancelAnimationFrame(inputFrame.current);
      inputFrame.current = null;
    }
    const lastId = messages.at(-1)?.id ?? '';
    const changedContext = previous.current.context !== contextKey || previous.current.scope !== viewportScope;
    const changedLast = previous.current.lastId !== lastId;
    if (changedContext) {
      contextEnteredAt.current = Date.now();
      stopScroll(); userScrollIntent.current = null; scrollbarPointer.current = null; touchY.current = null; observedScrollTop.current = null;
      if (inputFrame.current !== null) window.cancelAnimationFrame(inputFrame.current);
      inputFrame.current = null; setUnseen(0);
      followIntent.current = initialViewport.following; setAutoScroll(initialViewport.following);
      manualResumeOnly.current = Boolean(initialViewport.manualResumeOnly);
      // The keyed virtual list restores before paint; no animation traverses
      // the history of a newly selected room or message tab.
      if (initialViewport.following) scrollToLatest(true);
    }
    else if (autoScroll) { setUnseen(0); if (!showSettings) scrollToLatest(!previous.current.lastId); }
    else if (changedLast && lastId) {
      const previousIndex = messages.findIndex(message => message.id === previous.current.lastId);
      // The first projection of a restored view is retained history. Only
      // messages actually received after entry count as new in an empty view.
      const added = previousIndex >= 0 ? messages.length - previousIndex - 1
        : !previous.current.lastId ? messages.filter(message => message.receivedAt > contextEnteredAt.current).length : 1;
      setUnseen(count => Math.min(500, count + added));
    }
    if (!messages.length) setUnseen(0);
    previous.current = { context: contextKey, scope: viewportScope, lastId: lastId || (changedContext ? '' : previous.current.lastId) };
  }, [messages, contextKey, viewportScope, autoScroll, showSettings, active]);
  useEffect(() => {
    const element = listRef.current;
    if (!element) return;
    const geometry = () => [element.clientWidth, element.clientHeight, element.scrollHeight];
    let previousGeometry = geometry();
    const resize = new ResizeObserver(() => {
      const nextGeometry = geometry();
      if (nextGeometry.some((value, index) => value !== previousGeometry[index]) && !retainScrollbarIntent(element)) userScrollIntent.current = null;
      previousGeometry = nextGeometry;
      if (autoScroll && !showSettings) scrollToLatest();
    });
    resize.observe(element);
    if (element.firstElementChild) resize.observe(element.firstElementChild);
    return () => resize.disconnect();
  }, [autoScroll, showSettings, contextKey, active]);
  useEffect(() => {
    const onVisibility = () => { setForeground(!document.hidden); if (document.hidden) { stopScroll(); userScrollIntent.current = null; scrollbarPointer.current = null; touchY.current = null; if (inputFrame.current !== null) window.cancelAnimationFrame(inputFrame.current); inputFrame.current = null; } else if (autoScroll && !showSettings) scrollToLatest(true); };
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onMotion = () => { if (media.matches && autoScroll && !showSettings) scrollToLatest(true); };
    document.addEventListener('visibilitychange', onVisibility);
    media.addEventListener('change', onMotion);
    return () => { document.removeEventListener('visibilitychange', onVisibility); media.removeEventListener('change', onMotion); };
  }, [autoScroll, showSettings, active]);
  useEffect(() => {
    const releaseScrollbar = (event: PointerEvent) => {
      if (event.pointerId !== scrollbarPointer.current) return;
      const element = listRef.current;
      if (element && event.type === 'pointerup') handleListScroll(element);
      scrollbarPointer.current = null;
      userScrollIntent.current = null;
      if (followIntent.current) scrollToLatest();
    };
    const blur = () => {
      scrollbarPointer.current = null; touchY.current = null; userScrollIntent.current = null;
      if (inputFrame.current !== null) window.cancelAnimationFrame(inputFrame.current);
      inputFrame.current = null;
      if (followIntent.current) scrollToLatest();
    };
    window.addEventListener('pointerup', releaseScrollbar);
    window.addEventListener('pointercancel', releaseScrollbar);
    window.addEventListener('blur', blur);
    return () => { window.removeEventListener('pointerup', releaseScrollbar); window.removeEventListener('pointercancel', releaseScrollbar); window.removeEventListener('blur', blur); };
  }, [showSettings, active]);
  useEffect(() => () => { stopScroll(); if (focusFrame.current !== null) window.cancelAnimationFrame(focusFrame.current); if (inputFrame.current !== null) window.cancelAnimationFrame(inputFrame.current); }, []);
  const resumeScroll = (explicitLatest = false) => {
    if (manualResumeOnly.current && !explicitLatest) return;
    manualResumeOnly.current = false;
    followIntent.current = true; userScrollIntent.current = null; setAutoScroll(true); setUnseen(0); scrollToLatest();
  };
  const pauseScroll = useCallback(() => { stopScroll(); followIntent.current = false; userScrollIntent.current = null; setAutoScroll(false); }, [stopScroll]);
  const pauseForRepeat = useCallback(() => { manualResumeOnly.current = true; pauseScroll(); }, [pauseScroll]);
  // Capture the view generation at dispatch. Even a round trip to another
  // room/tab must invalidate a delayed result's right to move this viewport.
  const repeatView = useMemo(() => ({}), [contextKey, viewportScope, chat?.sessionScope, active, showSettings, foreground]);
  const repeatViewRef = useRef(repeatView);
  repeatViewRef.current = repeatView;
  const handleRepeatSubmitted = () => {
    if (repeatViewRef.current !== repeatView || !active || showSettings || !foreground || document.hidden || mode !== 'danmaku') return;
    resumeScroll(true);
  };
  const noteUserScroll = (direction: UserScrollIntent['direction']) => {
    const element = listRef.current;
    if (!element) return;
    // User input takes over immediately; no stale animation flag may swallow its scroll events.
    stopScroll();
    if (direction === 'older') pauseScroll();
    const intent: UserScrollIntent = { direction, until: performance.now() + 800, version: programmaticVersion.current,
      height: element.scrollHeight, viewport: element.clientHeight };
    userScrollIntent.current = intent;
    observedScrollTop.current = element.scrollTop;
    if (inputFrame.current !== null) window.cancelAnimationFrame(inputFrame.current);
    inputFrame.current = null;
    // Upward intent must stay paused even if native key/wheel scrolling has not begun yet.
    // Only a downward gesture needs the "already at the boundary" recovery check.
    if (direction !== 'newer') return;
    // Compositor scrolling can reach the boundary before React receives wheel.
    // Commit that user action now, before newly visible rows change the extent.
    if (atLatest(element)) { resumeScroll(); return; }
    inputFrame.current = window.requestAnimationFrame(() => {
      inputFrame.current = null;
      const element = listRef.current;
      // A wheel at an already reached boundary may not emit a scroll event.
      // Do not mistake intervening anchor compensation for reaching it by hand.
      if (element && userScrollIntent.current === intent && validUserScroll(element, intent) && atLatest(element)) resumeScroll();
      else if (followIntent.current) scrollToLatest();
    });
  };
  const handleListScroll = (element: HTMLElement) => {
    const delta = observedScrollTop.current === null ? 0 : element.scrollTop - observedScrollTop.current;
    observedScrollTop.current = element.scrollTop;
    const intent = userScrollIntent.current;
    // Scroll events report position, not intent. Layout clamps, coalesced RAF writes,
    // row exits and history trimming must never switch the user's follow setting.
    if (!validUserScroll(element, intent)) {
      userScrollIntent.current = null;
      if (followIntent.current) scrollToLatest();
      return;
    }
    intent.until = performance.now() + 800;
    if (intent.direction === 'scrollbar' && delta < -0.1) { pauseScroll(); userScrollIntent.current = intent; }
    else if (intent.direction !== 'older' && delta > 0.1 && atLatest(element)) resumeScroll();
    else if (followIntent.current) scrollToLatest();
  };
  const changeSettings = (open: boolean) => {
    stopScroll(); setShowSettings(open);
    if (focusFrame.current !== null) window.cancelAnimationFrame(focusFrame.current);
    focusFrame.current = window.requestAnimationFrame(() => { focusFrame.current = null; (open ? backRef : settingsRef).current?.focus({ preventScroll: true }); });
  };

  return <section className="mv-danmaku-sidebar" data-view={showSettings ? 'settings' : 'messages'} onKeyDown={event => {
    if (event.key === 'Escape' && showSettings && !(event.target as HTMLElement).closest('[role="listbox"]')) { event.preventDefault(); event.stopPropagation(); changeSettings(false); }
  }}>
    <div className="mv-danmaku-view mv-danmaku-chat-view" data-testid="danmaku-chat-view" aria-hidden={showSettings} inert={showSettings}>
      <div className="mv-danmaku-controls">
        <div className="mv-sidebar-heading mv-danmaku-heading"><strong>弹幕与 SC</strong>
          <div className="mv-danmaku-heading-actions" role="group" aria-label="画面弹幕控制">
            <span className="mv-danmaku-overlay-label" aria-hidden="true">画面</span>
            <ToggleButton active={Boolean(currentRoomId && preferences.rooms[currentRoomId]?.enabled)} disabled={!currentRoomId} onChange={() => { if (currentRoomId) setRoomEnabled(currentRoomId, !preferences.rooms[currentRoomId]?.enabled); }}
              label="本房" ariaLabel={`当前直播间画面弹幕${currentRoomId ? `：${roomName(currentRoomId)}` : ''}`} onTitle={`关闭${currentRoomId ? roomName(currentRoomId) : '当前直播间'}的画面弹幕`} offTitle={`开启${currentRoomId ? roomName(currentRoomId) : '当前直播间'}的画面弹幕`} onIcon={<MessageSquare size={13} />} offIcon={<MessageSquareOff size={13} />} />
            <span className="mv-danmaku-all-toggle" data-state={someEnabled ? 'mixed' : allEnabled ? 'on' : 'off'}><ToggleButton active={allEnabled} disabled={!roomIds.length} onChange={() => setAllEnabled(!allEnabled)}
              label={someEnabled ? <>全部<span className="mv-danmaku-mixed-label">· 部分</span></> : '全部'} ariaLabel={`全部已选直播间画面弹幕${someEnabled ? '，部分开启' : ''}`} className={someEnabled ? 'mv-danmaku-toggle-mixed' : ''}
              onTitle="关闭全部已选直播间的画面弹幕" offTitle={someEnabled ? '部分直播间已开启；点击开启全部已选直播间的画面弹幕' : '开启全部已选直播间的画面弹幕'} onIcon={<Layers size={13} />} offIcon={someEnabled ? <Minus size={13} /> : <Layers size={13} />} /></span>
            <button ref={settingsRef} className="mv-icon-button" aria-label="弹幕显示设置" aria-expanded={showSettings} title="显示设置" onClick={() => changeSettings(true)}><SlidersHorizontal size={15} /></button>
          </div>
        </div>
        <UiSelect className="mv-danmaku-room-select" contentClassName="mv-danmaku-room-options" label="查看弹幕直播间" disabled={!roomIds.length} value={currentRoomId ?? ''} onChange={onRoomChange} options={roomIds.length ? roomIds.map(id => {
          const status = rooms[id]?.status ?? 'idle';
          return { value: id, label: `${roomName(id)} · ${roomStatusLabel[status]}`, className: `mv-danmaku-room-option mv-danmaku-room-option-${status}` };
        }) : [{ value: '', label: '先选择直播间' }]} />
        <div className="mv-danmaku-toolbar">
          <SegmentedControl value={mode} defaultValue="danmaku" onChange={setMode} label="消息类型" className="mv-danmaku-tabs" options={[
            { value: 'danmaku', label: '普通弹幕', icon: <MessageSquare size={12} /> },
            { value: 'sc', label: 'SC', icon: <ScrollText size={12} /> },
          ]} />
          <div className="mv-danmaku-toolbar-meta">
            <small className={`mv-danmaku-status mv-danmaku-status-${state?.status ?? 'idle'}`} role="status">{currentRoomId ? state?.status === 'live' ? state.receiveMode === 'authenticated' ? '登录接收' : '匿名接收' : statusLabel[state?.status ?? 'idle'] : '请选择直播间'}</small>
            <span className="mv-danmaku-record-count">{messages.length} 条{mode === 'sc' ? ' SC' : '弹幕'}</span>
          </div>
        </div>
        <AnimatedCollapse open={Boolean(state?.error || state?.status === 'error')} className="mv-danmaku-error-collapse"><div className="mv-danmaku-notices">
          {(state?.error || state?.status === 'error') && <div className="mv-danmaku-connection-notice"><p className="mv-danmaku-error" role="status">{state?.error || '暂时无法连接弹幕。'}</p>
            {state?.status === 'error' && <button type="button" className="mv-text-button" aria-label="重新连接弹幕" onClick={() => { if (currentRoomId) onReconnect(currentRoomId); }}><RefreshCw size={12} />重试连接</button>}
          </div>}
        </div></AnimatedCollapse>
      </div>
      <div className="mv-danmaku-log-area">
        <div ref={attachList} className="mv-danmaku-messages ui-scrollbar" role="log" aria-live="off" aria-label={mode === 'sc' ? 'SC消息列表' : '普通弹幕列表'} tabIndex={0} data-auto-scroll={autoScroll}
          onWheel={event => { if (!event.ctrlKey && event.deltaY !== 0) noteUserScroll(event.deltaY < 0 ? 'older' : 'newer'); }}
          onTouchStart={event => { stopScroll(); userScrollIntent.current = null; touchY.current = event.touches[0]?.clientY ?? null; }}
          onTouchMove={event => {
            const y = event.touches[0]?.clientY;
            if (y !== undefined && touchY.current !== null && Math.abs(y - touchY.current) >= 2) {
              noteUserScroll(y > touchY.current ? 'older' : 'newer'); touchY.current = y;
            }
          }}
          onTouchEnd={() => { touchY.current = null; if (userScrollIntent.current?.direction === 'newer') noteUserScroll('newer'); else if (followIntent.current) scrollToLatest(); }}
          onTouchCancel={() => { touchY.current = null; userScrollIntent.current = null; if (followIntent.current) scrollToLatest(); }}
          onPointerDown={event => {
            const element = event.currentTarget;
            if (event.pointerType === 'mouse' && event.button === 0 && event.target === element
              && event.clientX >= element.getBoundingClientRect().right - Math.max(12, element.offsetWidth - element.clientWidth)) {
              scrollbarPointer.current = event.pointerId; noteUserScroll('scrollbar');
            }
          }}
          onPointerMove={event => { if (event.pointerId === scrollbarPointer.current && !validUserScroll(event.currentTarget, userScrollIntent.current)) noteUserScroll('scrollbar'); }}
          onKeyDown={event => {
            if (event.key === 'End') { event.preventDefault(); resumeScroll(true); }
            else if (event.key === 'Home') { event.preventDefault(); noteUserScroll('older'); writeScrollPosition(event.currentTarget, 0); }
            else if (['ArrowUp', 'PageUp'].includes(event.key) || (event.key === ' ' && event.shiftKey)) noteUserScroll('older');
            else if (['ArrowDown', 'PageDown', ' '].includes(event.key)) noteUserScroll('newer');
          }}
          onScroll={event => handleListScroll(event.currentTarget)}>
          <DanmakuVirtualList key={`${viewportScope}:${contextKey}`} messages={messages} gaps={state?.gaps} scrollRef={listRef} scrollElement={listElement} onScrollCompensation={recordProgrammaticScroll} chat={chat} repeatState={repeatState} onRepeat={repeatMessage} onRepeatOpen={pauseForRepeat} paused={!active || showSettings || !foreground}
            initialViewport={initialViewport} following={viewportFollowing} onViewportReady={handleViewportReady} onViewportChange={rememberViewport} />
          {!messages.length && !state?.gaps?.length && <div className="mv-danmaku-empty" key={contextKey}><span aria-hidden="true">{mode === 'sc' ? <ScrollText size={24} /> : <MessageSquare size={24} />}</span><p>{!currentRoomId ? '选择直播间后查看弹幕' : state?.status === 'error' || state?.status === 'retrying' ? '连接恢复后将继续接收弹幕' : mode === 'sc' ? '暂无 SC 消息' : '等待新的弹幕…'}</p></div>}
        </div>
        <div className="mv-danmaku-jump" data-visible={!autoScroll} aria-hidden={autoScroll} inert={autoScroll}><button className="mv-text-button" onClick={() => resumeScroll(true)}><ArrowDown size={13} />{unseen ? `${unseen} 条新消息 · 回到最新` : '回到最新'}</button></div>
      </div>
      <DanmakuComposer roomId={currentRoomId} chat={chat} medalToggles={medalToggles} active={active && !showSettings && foreground} repeatRef={composerRef} onRepeatStateChange={setRepeatState} onRepeatSubmitted={handleRepeatSubmitted} />
    </div>
    <div className="mv-danmaku-view mv-danmaku-settings-view" data-testid="danmaku-settings-view" aria-hidden={!showSettings} inert={!showSettings}>
      <header className="mv-danmaku-settings-heading"><button ref={backRef} className="mv-icon-button" aria-label="返回弹幕列表" title="返回弹幕列表" onClick={() => changeSettings(false)}><ArrowLeft size={16} /></button><div><strong>弹幕设置</strong><small>显示样式与账号发言</small></div></header>
      <div className="mv-danmaku-settings ui-scrollbar" aria-label="弹幕显示设置面板">
        <div className="mv-danmaku-settings-section"><h4>应用范围</h4>
          <UiSelect label="弹幕设置范围" value={settingsRoom ?? 'global'} onChange={setSettingsTarget} options={[{ value: 'global', label: '全局默认样式' }, ...roomIds.map(id => ({ value: id, label: roomName(id) }))]} />
          <AnimatedCollapse open={Boolean(settingsRoom)}>{settingsRoom && <ToggleButton active={!preferences.rooms[settingsRoom]?.style} label="使用全局样式" onIcon={<SlidersHorizontal size={14} />} offIcon={<SlidersHorizontal size={14} />}
            onChange={() => onChange({ ...preferences, rooms: { ...preferences.rooms, [settingsRoom]: { enabled: preferences.rooms[settingsRoom]?.enabled ?? false, ...(preferences.rooms[settingsRoom]?.style ? {} : { style: { ...preferences.defaults, blockedWords: [...preferences.defaults.blockedWords] } }) } } })} />}</AnimatedCollapse>
        </div>
        <StyleEditor value={selectedStyle} onChange={changeStyle} label={settingsRoom ? `${roomName(settingsRoom)}弹幕` : '全局弹幕'} />
        <button className="mv-text-button mv-danmaku-reset" onClick={() => changeStyle(defaultDanmakuStyle())}><RotateCcw size={13} />恢复默认样式</button>
        <section className="mv-danmaku-settings-section mv-danmaku-account-settings" aria-label="账号发言设置"><h4>账号发言</h4>
          <DanmakuMedalToggles {...medalToggles} />
          <p>切房时可自动佩戴对应勋章，找不到时保留当前勋章。佩戴状态同步到 B站账号。</p>
        </section>
      </div>
    </div>
  </section>;
}
