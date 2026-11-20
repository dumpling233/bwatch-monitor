import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Award, Check, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { UiPopoverContent } from '../../ui';
import type { DanmakuMedalAdapter, LocalMedalSnapshot } from '../localMedalClient';
import { DanmakuMedalBadge } from './DanmakuMedalBadge';
import { DanmakuMedalToggles, type DanmakuMedalToggleControls } from './DanmakuMedalToggles';
import '../../ui-scroll.css';

const emptySnapshot: LocalMedalSnapshot = { scope: '', revision: 0, items: [], wearing: null, displayConfirmed: false, loaded: false, loading: false, changing: false, page: 0, hasMore: false, error: '', unknown: false };
const subscribeEmpty = () => () => {};
const getEmpty = () => emptySnapshot;

/** Room-context medal display. Opening it refreshes facts, never changes the medal. */
export function DanmakuMedalPicker({ adapter, active, disabled, open, toggles, onOpenChange, onSetup }: {
  adapter?: DanmakuMedalAdapter; active: boolean; disabled: boolean; open: boolean;
  toggles?: DanmakuMedalToggleControls;
  onOpenChange(open: boolean): void; onSetup?(): void;
}) {
  const state = useSyncExternalStore(adapter?.subscribe ?? subscribeEmpty, adapter?.getSnapshot ?? getEmpty, getEmpty);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [container, setContainer] = useState<Element | undefined>(undefined);
  const [localError, setLocalError] = useState('');
  const [readFeedback, setReadFeedback] = useState('');
  const readController = useRef<AbortController | null>(null);
  const readGeneration = useRef(0);
  const readBusy = useRef(false);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scopeRef = useRef(state.scope);
  scopeRef.current = state.scope;
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    if (!adapter || !active || document.hidden) return;
    const controller = new AbortController();
    void adapter.load(1, controller.signal).catch(() => {});
    return () => controller.abort();
  }, [adapter, active, state.scope, state.revision]);
  useEffect(() => {
    if (!open || !adapter || !active || document.hidden) return;
    const controller = new AbortController();
    setLocalError(''); setReadFeedback('');
    void Promise.all([adapter.load(1, controller.signal, true), adapter.loadRoom?.(controller.signal)]).catch(() => {});
    return () => {
      controller.abort(); readController.current?.abort(); readBusy.current = false; readGeneration.current++;
      if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    };
  }, [open, adapter, active, state.scope]);
  useEffect(() => {
    if (!active) onOpenChange(false);
  }, [active, onOpenChange]);
  useEffect(() => {
    const close = () => onOpenChange(false);
    const visibility = () => {
      if (document.hidden) close();
      else if (active && adapter) void adapter.load(1).catch(() => {});
    };
    document.addEventListener('visibilitychange', visibility);
    document.addEventListener('fullscreenchange', close);
    return () => { document.removeEventListener('visibilitychange', visibility); document.removeEventListener('fullscreenchange', close); };
  }, [onOpenChange, active, adapter]);
  const choose = async (id: string | null) => {
    if (!adapter || disabled || state.changing || state.unknown || !state.loaded) return;
    if (state.selectedMedalId !== undefined && state.selectedMedalId === id) { onOpenChange(false); return; }
    setLocalError('');
    const scope = state.scope;
    try {
      const success = await adapter.select(id);
      if (success && scope === scopeRef.current && openRef.current) onOpenChange(false);
    } catch { if (scope === scopeRef.current) setLocalError('切换未完成，请刷新勋章后确认'); }
  };
  const read = async (page: number, force = false) => {
    if (!adapter || state.loading || state.roomLoading || state.changing || readBusy.current || !open || !active || document.hidden) return;
    setLocalError(''); setReadFeedback(force ? '正在刷新…' : '');
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    readController.current?.abort();
    const controller = new AbortController(); readController.current = controller;
    const generation = ++readGeneration.current; readBusy.current = true;
    try {
      await Promise.all([adapter.load(page, controller.signal, force), ...(force ? [adapter.loadRoom?.(controller.signal, true)] : [])]);
      if (controller.signal.aborted || generation !== readGeneration.current) return;
      const result = adapter.getSnapshot();
      if (force && !result.error && !result.roomError && !result.unknown) {
        if (listRef.current) listRef.current.scrollTop = 0;
        setReadFeedback('列表已就绪');
        feedbackTimer.current = setTimeout(() => setReadFeedback(''), 2000);
      } else setReadFeedback('');
    } catch { if (!controller.signal.aborted) { setLocalError('暂时无法获取勋章，请稍后重试'); setReadFeedback(''); } }
    finally { if (generation === readGeneration.current) readBusy.current = false; }
  };
  const accountMedal = typeof state.selectedMedalId === 'string' && state.selectedMedal?.id === state.selectedMedalId ? state.selectedMedal : undefined;
  const label = state.unknown ? '确认当前佩戴勋章' : accountMedal ? `切换粉丝勋章，当前佩戴${accountMedal.name}${accountMedal.level}级` : state.selectedMedalId === null ? '切换粉丝勋章，当前未佩戴' : '选择粉丝勋章';
  const error = localError || state.error || state.roomError;
  const visibleMedals = new Map<string, NonNullable<typeof state.selectedMedal>>();
  if (accountMedal) visibleMedals.set(accountMedal.id, accountMedal);
  for (const medal of [...(state.roomItems ?? []), ...state.items]) if (!visibleMedals.has(medal.id)) visibleMedals.set(medal.id, medal);
  const blocked = disabled || state.changing || state.unknown || !state.loaded;
  return <Popover.Root open={open && active && Boolean(adapter)} onOpenChange={value => {
    if (value) setContainer(document.fullscreenElement ?? triggerRef.current?.closest('.mv-shell') ?? undefined);
    onOpenChange(value);
  }}>
    <Popover.Trigger asChild><button ref={triggerRef} className="mv-danmaku-medal-trigger" type="button" disabled={disabled || !active}
      aria-label={adapter ? label : '更新扩展以切换粉丝勋章'} title={adapter ? label : '更新 BWatch Companion 后可切换粉丝勋章'}
      onClick={event => { if (!adapter) { event.preventDefault(); onSetup?.(); } }}>
      {accountMedal && !state.unknown ? <DanmakuMedalBadge medal={accountMedal} /> : <><Award size={15} aria-hidden="true" /><span>{state.unknown ? '确认勋章' : state.selectedMedalId === null ? '不佩戴' : '粉丝勋章'}</span></>}
    </button></Popover.Trigger>
    <Popover.Portal container={container}><UiPopoverContent className="mv-danmaku-medal-popover ui-inset-scroll-frame" side="top" align="start" sideOffset={9} collisionPadding={10}
      aria-label="我的粉丝勋章" returnFocusRef={triggerRef} onOpenAutoFocus={event => { event.preventDefault(); listRef.current?.focus(); }}
      onEscapeKeyDown={event => event.stopPropagation()}>
      <header><strong>我的粉丝勋章</strong><div>
        {toggles && <DanmakuMedalToggles {...toggles} compact />}
        <button type="button" className="mv-icon-button" title="刷新粉丝勋章" aria-label="刷新粉丝勋章" disabled={state.loading || state.roomLoading || state.changing} onClick={() => read(1, true)}>
          {state.loading || state.roomLoading ? <LoaderCircle size={14} className="mv-danmaku-spinner" /> : <RefreshCw size={14} />}</button>
        <Popover.Close asChild><button className="mv-icon-button" type="button" aria-label="关闭粉丝勋章"><X size={15} /></button></Popover.Close>
      </div></header>
      <div ref={listRef} className="mv-danmaku-medal-list ui-inset-scroll" role="radiogroup" aria-label="佩戴的粉丝勋章" tabIndex={-1} aria-busy={state.loading || state.roomLoading || state.changing}
        onScroll={event => {
          const list = event.currentTarget;
          if (state.hasMore && !state.unknown && !localError && !state.error && list.scrollTop > 0 && list.scrollHeight - list.clientHeight - list.scrollTop < 48) void read(state.page + 1);
        }}
        onKeyDown={event => {
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
          const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="radio"]:not(:disabled)'));
          if (!buttons.length) return;
          event.preventDefault();
          const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : event.key === 'ArrowDown' ? (current + 1) % buttons.length : (current + buttons.length - 1) % buttons.length;
          buttons[next]?.focus();
        }}>
        <div className="ui-inset-scroll-content">
        {state.loaded && <button type="button" className="mv-danmaku-medal-option" role="radio" aria-checked={state.selectedMedalId === null} disabled={blocked} onClick={() => { void choose(null); }}>
          <span className="mv-danmaku-medal-radio" aria-hidden="true">{state.selectedMedalId === null && <Check size={11} />}</span><span className="mv-danmaku-medal-none"><Award size={15} />不佩戴勋章</span>
        </button>}
        {[...visibleMedals.values()].map(medal => <button type="button" key={medal.id} className="mv-danmaku-medal-option" role="radio" aria-checked={state.selectedMedalId === medal.id} disabled={blocked}
          title={`${medal.name} ${medal.level}级 · ${medal.anchorName || `UID ${medal.targetUid}`}${medal.lighted === false ? ' · 未点亮' : ''}`} onClick={() => { void choose(state.selectedMedalId === medal.id ? null : medal.id); }}>
          <span className="mv-danmaku-medal-radio" aria-hidden="true">{state.selectedMedalId === medal.id && <Check size={11} />}</span>
          <DanmakuMedalBadge medal={medal} /><span className="mv-danmaku-medal-anchor">{medal.anchorName || `UID ${medal.targetUid}`}</span>
        </button>)}
        {!state.loaded && !error && <p className="mv-danmaku-medal-empty">正在获取勋章…</p>}
        {state.loaded && !visibleMedals.size && !state.hasMore && <p className="mv-danmaku-medal-empty">你还没有粉丝勋章</p>}
        {state.hasMore && <button type="button" className="mv-text-button mv-danmaku-medal-more" disabled={state.loading || state.changing} onClick={() => read(state.page + 1)}>{state.loading ? '加载中…' : '加载更多'}</button>}
        </div>
      </div>
      <footer aria-live="polite">{state.changing ? <span><LoaderCircle size={12} className="mv-danmaku-spinner" />正在切换…</span> : state.loading || state.roomLoading || readFeedback === '正在刷新…' ? <span><LoaderCircle size={12} className="mv-danmaku-spinner" />{readFeedback || '正在加载…'}</span> : error ? <><span className="mv-danmaku-error">{error}</span><button className="mv-text-button" type="button" onClick={() => void read(1, true)}>重试</button></> : readFeedback ? <span className="mv-danmaku-medal-feedback"><Check size={12} />{readFeedback}</span> : <span>{state.loaded ? `已显示 ${visibleMedals.size} 枚${state.limitReached ? ' · 已达显示上限' : state.hasMore ? ' · 下滑继续查看' : ''}` : '我的粉丝勋章'}</span>}</footer>
    </UiPopoverContent></Popover.Portal>
  </Popover.Root>;
}
