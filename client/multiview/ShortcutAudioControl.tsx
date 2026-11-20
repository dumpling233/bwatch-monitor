import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Volume2, VolumeX } from 'lucide-react';
import { ToggleButton, UiPopoverContent, UiSlider } from '../ui';
import { RoomAudioBalance, type RoomAudioBalanceProps } from './RoomAudioBalance';
import './shortcut-audio-control.css';

export interface ShortcutAudioControlProps {
  name: string;
  variant?: 'room' | 'master';
  volume: number;
  muted: boolean;
  onToggle: () => void;
  onChange: (volume: number) => void;
  popupSide?: 'top' | 'bottom';
  idleHidden?: boolean;
  roomBalance?: RoomAudioBalanceProps;
}

/** A room name or the master icon toggles sound and offers a compact horizontal mixer. */
export function ShortcutAudioControl({ name, variant = 'room', volume, muted, onToggle, onChange, popupSide = 'top', idleHidden = false, roomBalance }: ShortcutAudioControlProps) {
  const [hovered, setHovered] = useState(false);
  const [keyboardFocus, setKeyboardFocus] = useState(false);
  const [touchOpen, setTouchOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [fullscreenContainer, setFullscreenContainer] = useState<Element | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const sliderRef = useRef<HTMLInputElement>(null);
  const pendingSliderFocus = useRef(false);
  const leaveTimer = useRef<number | undefined>(undefined);
  const open = !idleHidden && !dismissed && (hovered || keyboardFocus || touchOpen || dragging);
  const savedVolume = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 0;
  const audibleVolume = muted ? 0 : savedVolume;
  const master = variant === 'master';
  const balance = master ? undefined : roomBalance;
  const toggleLabel = master ? muted ? '取消全部静音' : '全部静音' : `${name}${muted ? '打开声音' : '关闭声音'}`;
  const sliderLabel = master ? '快捷总音量' : `${name}快捷音量`;
  const popoverLabel = master ? '快捷总音量调节' : `${name}快捷音量调节`;
  const portalContainer = fullscreenContainer?.contains(triggerRef.current) ? fullscreenContainer : undefined;

  const cancelLeave = () => { window.clearTimeout(leaveTimer.current); leaveTimer.current = undefined; };
  const dismiss = (returnFocus = false) => {
    cancelLeave();
    pendingSliderFocus.current = false;
    if (returnFocus) triggerRef.current?.focus({ preventScroll: true });
    setHovered(false); setKeyboardFocus(false); setTouchOpen(false); setDragging(false); setDismissed(true);
  };
  const enter = () => {
    cancelLeave(); setFullscreenContainer(document.fullscreenElement); setDismissed(false); setHovered(true);
  };
  const leave = () => {
    cancelLeave(); leaveTimer.current = window.setTimeout(() => setHovered(false), 120);
  };
  const focus = (target: EventTarget) => {
    if (target instanceof Element && target.matches(':focus-visible')) {
      cancelLeave(); setFullscreenContainer(document.fullscreenElement); setDismissed(false); setKeyboardFocus(true);
    }
  };
  const blur = (relatedTarget: EventTarget | null) => {
    if (relatedTarget instanceof Node && (rootRef.current?.contains(relatedTarget) || contentRef.current?.contains(relatedTarget))) return;
    setKeyboardFocus(false); setTouchOpen(false);
  };
  const focusPendingSlider = () => {
    const slider = sliderRef.current;
    if (!pendingSliderFocus.current || !slider) return;
    pendingSliderFocus.current = false;
    slider.focus({ preventScroll: true });
  };
  const requestSliderFocus = () => {
    cancelLeave();
    pendingSliderFocus.current = true;
    setFullscreenContainer(document.fullscreenElement);
    setDismissed(false); setKeyboardFocus(true);
    // An existing popup can be focused now; a new Portal consumes this request on mount.
    if (open) focusPendingSlider();
  };
  // Keep using the shared switch component without adding a second focusable trigger.
  useLayoutEffect(() => { triggerRef.current = rootRef.current?.querySelector('button') ?? null; }, []);
  useLayoutEffect(() => { if (open) focusPendingSlider(); }, [open]);
  useEffect(() => () => cancelLeave(), []);
  useEffect(() => {
    const changed = () => { dismiss(); setFullscreenContainer(document.fullscreenElement); };
    document.addEventListener('fullscreenchange', changed);
    return () => document.removeEventListener('fullscreenchange', changed);
  }, []);
  useEffect(() => {
    if (!dragging) return;
    const finish = () => setDragging(false);
    window.addEventListener('pointerup', finish, true);
    window.addEventListener('pointercancel', finish, true);
    window.addEventListener('blur', finish);
    return () => {
      window.removeEventListener('pointerup', finish, true);
      window.removeEventListener('pointercancel', finish, true);
      window.removeEventListener('blur', finish);
    };
  }, [dragging]);

  return <Popover.Root open={open} onOpenChange={next => { if (!next) dismiss(); }}>
    <Popover.Anchor asChild>
      <div ref={rootRef} className={`mv-shortcut-audio-control${master ? ' mv-shortcut-master-control' : ''}`} data-open={open} data-dragging={dragging}
        data-keep-controls={keyboardFocus || touchOpen || dragging}
        onPointerEnter={event => { if (event.pointerType !== 'touch') enter(); }}
        onPointerLeave={event => { if (event.pointerType !== 'touch') leave(); }}
        onPointerDownCapture={event => {
          pendingSliderFocus.current = false;
          setKeyboardFocus(false);
          if (event.pointerType === 'touch') { setFullscreenContainer(document.fullscreenElement); setDismissed(false); setTouchOpen(true); }
        }}
        onFocusCapture={event => focus(event.target)} onBlurCapture={event => blur(event.relatedTarget)}
        onKeyDown={event => {
          if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); dismiss(true); }
          else if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key) || (open && event.key === 'Tab' && !event.shiftKey)) {
            event.preventDefault(); requestSliderFocus();
          }
        }}
        onDoubleClick={event => event.stopPropagation()}>
        {master ? <button ref={triggerRef} type="button" className="mv-icon-button mv-master-audio"
          aria-label={toggleLabel} aria-pressed={muted} aria-expanded={open} aria-haspopup="dialog"
          title={`${toggleLabel}；悬停调节总音量`} onClick={onToggle}>
          {muted ? <VolumeX /> : <Volume2 />}
        </button> : <ToggleButton className="mv-switch-room" active={!muted} label={<strong>{name}</strong>}
          ariaLabel={toggleLabel}
          onTitle={`点击关闭${name}的声音；悬停调节音量和声道`} offTitle={`点击打开${name}的声音；悬停调节音量和声道`}
          onChange={onToggle} onIcon={<Volume2 size={13} />} offIcon={<VolumeX size={13} />} />}
      </div>
    </Popover.Anchor>
    <Popover.Portal container={portalContainer}>
      <UiPopoverContent ref={contentRef} returnFocusRef={triggerRef} className={`mv-shortcut-volume-popover${balance ? ' mv-shortcut-room-popover' : ''}`}
        data-keep-controls={keyboardFocus || touchOpen || dragging}
        side={popupSide} align="center" sideOffset={0} collisionPadding={10} aria-label={popoverLabel}
        onOpenAutoFocus={event => { event.preventDefault(); focusPendingSlider(); }} onCloseAutoFocus={event => event.preventDefault()}
        onPointerEnter={event => { if (event.pointerType !== 'touch') enter(); }}
        onPointerLeave={event => { if (event.pointerType !== 'touch') leave(); }}
        onPointerDownCapture={event => {
          if (!(event.target instanceof HTMLInputElement) || event.target.type !== 'range') return;
          pendingSliderFocus.current = false;
          setKeyboardFocus(false); setDismissed(false); setDragging(true);
        }}
        onFocusCapture={event => focus(event.target)} onBlurCapture={event => blur(event.relatedTarget)}
        onInteractOutside={event => {
          if (event.target instanceof Node && rootRef.current?.contains(event.target)) event.preventDefault();
        }}
        onEscapeKeyDown={event => { event.preventDefault(); event.stopPropagation(); dismiss(true); }}
        onKeyDownCapture={event => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss(true); }
          else if (event.key === 'Tab') {
            const popupControls = Array.from(contentRef.current?.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled)') ?? []);
            const focusedIndex = popupControls.indexOf(document.activeElement as HTMLElement);
            const inside = popupControls[focusedIndex + (event.shiftKey ? -1 : 1)];
            event.preventDefault();
            event.stopPropagation();
            if (inside) { inside.focus({ preventScroll: true }); return; }
            const controls = Array.from(document.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),[tabindex="0"]'))
              .filter(element => element.getClientRects().length && !element.closest('[inert],[aria-hidden="true"],.mv-shortcut-volume-popover'));
            const index = controls.indexOf(triggerRef.current!);
            const next = event.shiftKey ? triggerRef.current : controls[index + 1];
            dismiss(); next?.focus({ preventScroll: true });
          }
        }}
        onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
        <UiSlider className="mv-shortcut-volume-row" layout="inline" label={<Volume2 size={14} aria-hidden="true" />}
          ariaLabel={sliderLabel} inputRef={sliderRef} min={0} max={1} step={0.01} value={audibleVolume}
          formatValue={volume => `${Math.round(volume * 100)}%`} onChange={onChange} />
        {balance && <RoomAudioBalance name={name} {...balance} inline />}
      </UiPopoverContent>
    </Popover.Portal>
  </Popover.Root>;
}
