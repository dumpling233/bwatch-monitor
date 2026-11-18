import React, { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { Volume2, VolumeX } from 'lucide-react';
import './player-volume-control.css';

interface PlayerVolumeControlProps {
  name: string;
  volume: number;
  muted: boolean;
  onToggle: () => void;
  onChange: (volume: number) => void;
}

/** Keep the slider available while dragging, without leaving mouse focus permanently open. */
export function PlayerVolumeControl({ name, volume, muted, onToggle, onChange }: PlayerVolumeControlProps) {
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  const [hovered, setHovered] = useState(false);
  const [keyboardFocus, setKeyboardFocus] = useState(false);
  const [touchOpen, setTouchOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const open = !dismissed && (hovered || keyboardFocus || touchOpen || dragging);
  const audibleVolume = muted ? 0 : volume;

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (root.current?.contains(event.target as Node)) return;
      setTouchOpen(false); setKeyboardFocus(false); setDismissed(true);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
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

  return <div ref={root} className="mv-volume-control" data-open={open} data-dragging={dragging}
    data-keep-controls={keyboardFocus || touchOpen || dragging}
    onPointerDownCapture={() => setKeyboardFocus(false)}
    onPointerEnter={event => { if (event.pointerType !== 'touch') { setDismissed(false); setHovered(true); } }}
    onPointerLeave={() => setHovered(false)}
    onFocusCapture={event => { if (event.target.matches(':focus-visible')) { setDismissed(false); setKeyboardFocus(true); } }}
    onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { setKeyboardFocus(false); setTouchOpen(false); } }}
    onKeyDown={event => {
      if (event.key !== 'Escape' || !open) return;
      event.preventDefault(); event.stopPropagation();
      button.current?.focus({ preventScroll: true });
      setDragging(false); setTouchOpen(false); setKeyboardFocus(false); setDismissed(true);
    }}>
    <button ref={button} className="mv-icon-button mv-volume-button" aria-label={`${name}${muted ? '开启声音' : '关闭声音'}`}
      title={muted ? '开启声音；悬停调节音量' : '静音；悬停调节音量'} aria-pressed={!muted} aria-expanded={open} aria-controls={id}
      onPointerDown={event => { if (event.pointerType === 'touch') { setDismissed(false); setTouchOpen(true); } }}
      onClick={onToggle}>{muted ? <VolumeX /> : <Volume2 />}</button>
    <div id={id} className="mv-volume-popover mv-player-volume-popover" role="group" aria-label={`${name}音量调节`} aria-hidden={!open} inert={!open}>
      <output aria-hidden="true">{Math.round(audibleVolume * 100)}</output>
      <input className="mv-tile-volume" type="range" min="0" max="1" step="0.01" aria-label={`${name}音量`}
        aria-orientation="vertical" aria-valuetext={`${Math.round(audibleVolume * 100)}%`} value={audibleVolume}
        style={{ '--mv-volume-fill': `${audibleVolume * 100}%` } as CSSProperties}
        onPointerDown={() => { setDismissed(false); setDragging(true); }}
        onChange={event => onChange(Number(event.target.value))} />
    </div>
  </div>;
}
