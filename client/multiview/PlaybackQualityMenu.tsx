import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronLeft, ChevronRight } from 'lucide-react';
import { UiPopoverContent } from '../ui';
import type { PlaybackFormatPreference } from '../../shared/playback';
import './playback-quality-menu.css';

export interface PlaybackMenuOption {
  value: string;
  label: string;
  disabled?: boolean;
  title?: string;
  description?: string;
}

export interface PlaybackQualityMenuProps {
  name: string;
  quality: string;
  qualityOptions: readonly PlaybackMenuOption[];
  onQualityChange: (value: string) => void;
  route: string;
  routeOptions: readonly PlaybackMenuOption[];
  onRouteChange: (value: string) => void;
  routeDisabled?: boolean;
  triggerLabel?: string;
  currentRouteLabel?: string;
  preferredFormat?: PlaybackFormatPreference;
  formatOptions?: readonly PlaybackMenuOption[];
  onFormatChange?: (format: PlaybackFormatPreference) => void;
  summary?: string;
  notice?: string;
  emptyMessage?: string;
  optionsLoading?: boolean;
  routesLoading?: boolean;
  /** Follows the open lifecycle, including visibility changes and unmount cleanup. */
  onOpenChange?: (open: boolean) => void;
  /** Requests fresh routes only while the secondary routes view is open. */
  onRoutesOpenChange?: (open: boolean) => void;
  disabled?: boolean;
}

type MenuView = 'quality' | 'routes';
type OpenMethod = 'hover' | 'pointer' | 'keyboard';

/** The player's compact quality control; routing remains a secondary view of the same popup. */
export function PlaybackQualityMenu({ name, quality, qualityOptions, onQualityChange, route, routeOptions, onRouteChange,
  routeDisabled = false, triggerLabel, currentRouteLabel,
  notice, emptyMessage, optionsLoading = false, routesLoading = false, onOpenChange, onRoutesOpenChange,
  disabled = false }: PlaybackQualityMenuProps) {
  const [open, setOpen] = useState(false);
  const [present, setPresent] = useState(false);
  const [view, setView] = useState<MenuView>('quality');
  const [contentNode, setContentNode] = useState<HTMLDivElement | null>(null);
  const [viewHeight, setViewHeight] = useState(0);
  const [fullscreenContainer, setFullscreenContainer] = useState<Element | null>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const qualityViewRef = useRef<HTMLDivElement>(null);
  const routesViewRef = useRef<HTMLDivElement>(null);
  const leaveTimer = useRef<number | undefined>(undefined);
  const method = useRef<OpenMethod>('hover');
  const pendingFocus = useRef(false);
  const animation = useRef<Animation | null>(null);
  const animationGeneration = useRef(0);
  const openChangeCallback = useRef(onOpenChange);
  openChangeCallback.current = onOpenChange;
  const routesChangeCallback = useRef(onRoutesOpenChange);
  routesChangeCallback.current = onRoutesOpenChange;
  const shownQuality = triggerLabel ?? qualityOptions.find(option => option.value === quality)?.label ?? '清晰度';
  const shownRoute = currentRouteLabel ?? routeOptions.find(option => option.value === route)?.label ?? '自动线路';
  const routeUnavailable = routeDisabled;

  const cancelLeave = () => { window.clearTimeout(leaveTimer.current); leaveTimer.current = undefined; };
  const closeMenu = (restoreFocus = false, immediately = false) => {
    cancelLeave(); pendingFocus.current = false;
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
    if (immediately) { animationGeneration.current += 1; animation.current?.cancel(); animation.current = null; setPresent(false); }
  };
  const openMenu = (via: OpenMethod) => {
    if (disabled) return;
    cancelLeave();
    if (!open) setView('quality');
    method.current = via;
    pendingFocus.current = via === 'keyboard';
    setFullscreenContainer(document.fullscreenElement);
    setPresent(true); setOpen(true);
    if (open && via === 'keyboard') focusCurrentOption();
  };
  const enter = () => {
    cancelLeave();
    if (!open) openMenu('hover');
  };
  const leave = () => {
    cancelLeave();
    if (method.current === 'hover') leaveTimer.current = window.setTimeout(() => closeMenu(), 140);
  };
  const activeView = () => view === 'routes' ? routesViewRef.current : qualityViewRef.current;
  const revealOption = (target: HTMLElement) => {
    const list = target.closest<HTMLElement>('.mv-playback-menu-options');
    if (!list) return;
    const bounds = list.getBoundingClientRect(), item = target.getBoundingClientRect();
    if (item.top < bounds.top) list.scrollTop -= bounds.top - item.top;
    else if (item.bottom > bounds.bottom) list.scrollTop += item.bottom - bounds.bottom;
  };
  const focusCurrentOption = () => {
    if (!pendingFocus.current) return;
    const target = activeView()?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]:not(:disabled)')
      ?? activeView()?.querySelector<HTMLElement>('[data-menu-focusable]:not(:disabled)');
    if (target) { pendingFocus.current = false; target.focus({ preventScroll: true }); revealOption(target); }
  };
  const switchView = (next: MenuView) => { cancelLeave(); pendingFocus.current = true; setView(next); };
  const selectQuality = (value: string) => { onQualityChange(value); closeMenu(method.current === 'keyboard'); };
  const selectRoute = (value: string) => { onRouteChange(value); closeMenu(method.current === 'keyboard'); };
  const renderOption = (option: PlaybackMenuOption, selected: string, select: (value: string) => void) => <button type="button" key={option.value}
    className="mv-playback-quality-item" role="menuitemradio" aria-checked={option.value === selected} disabled={option.disabled}
    title={option.title} data-menu-focusable
    onClick={event => { if (event.detail === 0) method.current = 'keyboard'; select(option.value); }}>
    <span>{option.label}</span>
    {option.value === selected && <Check size={14} aria-hidden="true" />}
  </button>;
  const portalContainer = fullscreenContainer?.contains(triggerRef.current) ? fullscreenContainer : undefined;
  const attachContent = useCallback((node: HTMLDivElement | null) => setContentNode(node), []);

  useLayoutEffect(() => {
    if (!open) return;
    openChangeCallback.current?.(true);
    return () => { openChangeCallback.current?.(false); };
  }, [open]);
  useLayoutEffect(() => {
    if (!open || view !== 'routes') return;
    routesChangeCallback.current?.(true);
    return () => { routesChangeCallback.current?.(false); };
  }, [open, view]);

  useLayoutEffect(() => {
    if (!contentNode) return;
    const node = contentNode;
    const previous = getComputedStyle(node);
    const fromOpacity = previous.opacity, fromTransform = previous.transform;
    const generation = ++animationGeneration.current;
    animation.current?.cancel(); animation.current = null;
    node.style.opacity = open ? '1' : '0';
    node.style.transform = open ? 'translateY(0) scale(1)' : 'translateY(4px) scale(.97)';
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !node.animate) { if (!open) setPresent(false); return; }
    const next = node.animate([{ opacity: fromOpacity, transform: fromTransform },
      { opacity: open ? '1' : '0', transform: node.style.transform }], { duration: open ? 170 : 130, easing: 'cubic-bezier(.22, 1, .36, 1)' });
    animation.current = next;
    next.onfinish = () => { if (generation !== animationGeneration.current) return; animation.current = null; if (!open) setPresent(false); };
  }, [open, contentNode]);
  useLayoutEffect(() => {
    if (!present || !contentNode) return;
    const measure = () => { const node = activeView(); if (node) setViewHeight(node.offsetHeight); };
    measure();
    const observer = new ResizeObserver(measure);
    if (qualityViewRef.current) observer.observe(qualityViewRef.current);
    if (routesViewRef.current) observer.observe(routesViewRef.current);
    if (open) focusCurrentOption();
    return () => observer.disconnect();
  }, [view, present, contentNode, open]);
  useLayoutEffect(() => {
    if (open) focusCurrentOption();
  }, [open, qualityOptions, routeOptions]);
  useEffect(() => {
    const fullScreenChanged = () => { closeMenu(false, true); setFullscreenContainer(document.fullscreenElement); };
    const visibilityChanged = () => { if (document.hidden) closeMenu(false, true); };
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const motionChanged = () => {
      if (!media.matches) return;
      animationGeneration.current += 1; animation.current?.cancel(); animation.current = null;
      if (contentNode) { contentNode.style.opacity = open ? '1' : '0'; contentNode.style.transform = open ? 'none' : 'translateY(4px) scale(.97)'; }
      if (!open) setPresent(false);
    };
    document.addEventListener('fullscreenchange', fullScreenChanged);
    document.addEventListener('visibilitychange', visibilityChanged);
    media.addEventListener('change', motionChanged);
    return () => {
      document.removeEventListener('fullscreenchange', fullScreenChanged);
      document.removeEventListener('visibilitychange', visibilityChanged);
      media.removeEventListener('change', motionChanged);
    };
  }, [open, contentNode]);
  useEffect(() => { if (disabled) closeMenu(false, true); }, [disabled]);
  useEffect(() => () => { cancelLeave(); animationGeneration.current += 1; animation.current?.cancel(); }, []);

  const keyboardNavigation = (event: React.KeyboardEvent) => {
    cancelLeave(); method.current = 'keyboard';
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(true); return; }
    if (event.key === 'ArrowLeft' && view === 'routes') { event.preventDefault(); event.stopPropagation(); method.current = 'keyboard'; switchView('quality'); return; }
    if (event.key === 'ArrowRight' && view === 'quality' && !routeUnavailable) { event.preventDefault(); event.stopPropagation(); method.current = 'keyboard'; switchView('routes'); return; }
    if (event.key === 'Tab') {
      event.preventDefault(); event.stopPropagation();
      const controls = Array.from(document.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),[tabindex="0"]'))
        .filter(node => node.getClientRects().length && !node.closest('[inert],[aria-hidden="true"],.mv-playback-menu-content'));
      const index = controls.indexOf(triggerRef.current!);
      const target = event.shiftKey ? triggerRef.current : controls[index + 1];
      closeMenu(); target?.focus({ preventScroll: true });
      return;
    }
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation(); method.current = 'keyboard';
    const controls = Array.from(activeView()?.querySelectorAll<HTMLElement>('[data-menu-focusable]:not(:disabled)') ?? []);
    const index = controls.indexOf(document.activeElement as HTMLElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1
      : index < 0 ? event.key === 'ArrowDown' ? 0 : controls.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + controls.length) % controls.length;
    const target = controls[next];
    if (target) { target.focus({ preventScroll: true }); revealOption(target); }
  };

  return <Popover.Root open={open} onOpenChange={next => { if (next) openMenu('pointer'); else closeMenu(); }}>
    <Popover.Anchor asChild><div ref={anchorRef} className="mv-playback-quality-menu" data-open={open} data-keep-controls={open}
      onPointerEnter={event => { if (event.pointerType === 'mouse') enter(); }} onPointerLeave={event => { if (event.pointerType === 'mouse') leave(); }}
      onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
      <button ref={triggerRef} type="button" className="mv-playback-quality-trigger" aria-label={`${name}清晰度`} aria-haspopup="dialog" aria-expanded={open} disabled={disabled}
        title={`清晰度：${shownQuality}；${shownRoute}`}
        onClick={event => { event.stopPropagation(); if (open && method.current !== 'hover') closeMenu(event.detail === 0); else openMenu(event.detail === 0 ? 'keyboard' : 'pointer'); }}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); event.stopPropagation(); openMenu('keyboard'); }
          else if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); closeMenu(true); }
        }}>{shownQuality}</button>
    </div></Popover.Anchor>
    {present && <Popover.Portal forceMount container={portalContainer}><UiPopoverContent forceMount ref={attachContent} returnFocusRef={triggerRef}
      className="mv-playback-menu-content" side="top" align="end" sideOffset={7} collisionPadding={10} aria-label={`${name}清晰度与线路`}
      aria-hidden={!open} inert={!open} data-open={open} data-keep-controls={open}
      onOpenAutoFocus={event => { event.preventDefault(); focusCurrentOption(); }} onCloseAutoFocus={event => event.preventDefault()}
      onPointerEnter={event => { if (event.pointerType === 'mouse') cancelLeave(); }} onPointerLeave={event => { if (event.pointerType === 'mouse') leave(); }}
      onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
      onKeyDown={keyboardNavigation} onEscapeKeyDown={event => { event.preventDefault(); event.stopPropagation(); closeMenu(true); }}
      onInteractOutside={event => { if (event.target instanceof Node && anchorRef.current?.contains(event.target)) event.preventDefault(); }}>
      {notice && <div className="mv-playback-menu-summary" role="status" aria-live="polite">
        <p className="mv-playback-menu-notice">{notice}</p>
      </div>}
      <div className="mv-playback-menu-views" data-view={view} style={{ height: viewHeight || undefined }}>
        <div ref={qualityViewRef} className="mv-playback-quality-view" aria-hidden={view !== 'quality'} inert={view !== 'quality'}>
          <button type="button" className="mv-playback-route-entry" data-menu-focusable disabled={routeUnavailable} aria-label={`${name}线路`}
            onClick={event => { if (event.detail === 0) method.current = 'keyboard'; switchView('routes'); }}><span>{shownRoute}</span><ChevronRight size={14} aria-hidden="true" /></button>
          <div className="mv-playback-menu-options" role="menu" aria-label={`${name}清晰度选项`} aria-busy={optionsLoading}>
            {qualityOptions.map(option => renderOption(option, quality, selectQuality))}
            {!qualityOptions.length && <p className="mv-playback-menu-empty">{emptyMessage ?? (optionsLoading ? '正在加载…' : '暂无清晰度选项')}</p>}
          </div>
        </div>
        <div ref={routesViewRef} className="mv-playback-routes-view" aria-hidden={view !== 'routes'} inert={view !== 'routes'}>
          <button type="button" className="mv-playback-route-back" data-menu-focusable aria-label={`${name}返回清晰度`}
            onClick={event => { if (event.detail === 0) method.current = 'keyboard'; switchView('quality'); }}><ChevronLeft size={14} aria-hidden="true" /><span>线路选择</span></button>
          <div className="mv-playback-menu-options" role="menu" aria-label={`${name}线路选项`} aria-busy={routesLoading}>
            {routeOptions.map(option => renderOption(option, route, selectRoute))}
            {(routesLoading || !routeOptions.length) && <p className="mv-playback-menu-empty" role="status">{routesLoading ? '正在更新线路…' : '暂无可用线路'}</p>}
          </div>
        </div>
      </div>
    </UiPopoverContent></Popover.Portal>}
  </Popover.Root>;
}
