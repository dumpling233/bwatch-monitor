import React, { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { RefreshCw, Search, Video, X } from 'lucide-react';
import type { MonitorRoomDescriptor } from '../shared/types';
import { AnimatedCollapse } from './ui';
import { useModalFocus, useModalLayer } from './modalLayer';
import { parseMonitorRoomInput } from './multiview/customRooms';
import './multiview/roomLibraryPicker.css';

export interface RoomLookupActions {
  complete: () => void;
  reportError: (message: string) => void;
}
interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  suspended?: boolean;
  knownRooms: readonly MonitorRoomDescriptor[];
  resolveRoom: (input: string, signal: AbortSignal) => Promise<MonitorRoomDescriptor>;
  renderBadges?: (room: MonitorRoomDescriptor) => ReactNode;
  renderActions: (room: MonitorRoomDescriptor, actions: RoomLookupActions) => ReactNode;
}

/** Shared room-number/link lookup. Callers own saving or monitoring mutations. */
export function RoomLookupDialog({ open, onClose, title, suspended = false, knownRooms, resolveRoom, renderBadges, renderActions }: Props) {
  const titleId = useId();
  const [present, setPresent] = useState(open), [input, setInput] = useState(''), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [preview, setPreview] = useState<MonitorRoomDescriptor | null>(null);
  const surface = useRef<HTMLDivElement>(null), initial = useRef<HTMLInputElement>(null);
  const latestPreview = useRef<MonitorRoomDescriptor | null>(null);
  if (preview) latestPreview.current = preview;
  const request = useRef<{ generation: number; controller: AbortController | null }>({ generation: 0, controller: null });
  const cancel = () => { request.current.generation++; request.current.controller?.abort(); request.current.controller = null; setBusy(false); };
  useEffect(() => {
    if (open) { setPresent(true); setPreview(null); latestPreview.current = null; setError(''); return; }
    cancel();
    const timer = window.setTimeout(() => setPresent(false), window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180);
    return () => window.clearTimeout(timer);
  }, [open]);
  useEffect(() => () => { request.current.generation++; request.current.controller?.abort(); }, []);
  useEffect(() => {
    if (!open) return;
    const close = () => { cancel(); onClose(); };
    document.addEventListener('fullscreenchange', close);
    return () => document.removeEventListener('fullscreenchange', close);
  }, [open, onClose]);
  useModalLayer(open && present, surface, suspended);
  useModalFocus(open && present, surface, initial, onClose, suspended);
  const resolve = async () => {
    if (!input.trim() || busy) return;
    cancel(); setError(''); setPreview(null);
    const parsed = parseMonitorRoomInput(input);
    if (!parsed) { setError('请输入有效的 B站直播间房间号或 live.bilibili.com 链接'); return; }
    const known = knownRooms.find(room => room.roomId === parsed.roomId);
    if (known) { setPreview(known); return; }
    const generation = ++request.current.generation, controller = new AbortController();
    request.current.controller = controller; setBusy(true);
    try {
      const room = await resolveRoom(input.trim(), controller.signal);
      if (generation !== request.current.generation || controller.signal.aborted) return;
      setPreview(knownRooms.find(item => item.roomId === room.roomId) ?? room);
    } catch (cause) {
      if (generation === request.current.generation && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : '房间信息获取失败，请稍后重试');
    } finally { if (generation === request.current.generation) { request.current.controller = null; setBusy(false); } }
  };
  if (!present) return null;
  const shown = preview ?? latestPreview.current;
  return createPortal(<div className="ui-modal-layer mv-library-overlay" data-state={open ? 'open' : 'closed'} aria-hidden={!open || suspended} inert={!open || suspended} style={suspended ? { visibility: 'hidden' } : undefined}
    onPointerDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={surface} className="ui-dialog-content mv-library-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={event => event.stopPropagation()}>
      <header><div><h2 id={titleId}>{title}</h2><p>输入 B站直播间房间号或链接</p></div><button type="button" className="mv-dialog-close" aria-label={`关闭${title}`} onClick={onClose}><X size={18} /></button></header>
      <form onSubmit={event => { event.preventDefault(); void resolve(); }}>
        <label className="mv-library-input"><Search size={16} /><input ref={initial} aria-label="B站房间号或链接" placeholder="房间号或 live.bilibili.com 链接" value={input}
          onChange={event => { cancel(); setInput(event.target.value); setPreview(null); setError(''); }} /></label>
        <button className="secondary" type="submit" disabled={!input.trim() || busy}>{busy ? <RefreshCw size={14} className="spin" /> : <Search size={14} />}获取房间信息</button>
      </form>
      {error && <p className="mv-library-error" role="alert">{error}</p>}
      <AnimatedCollapse open={Boolean(preview)} className="mv-library-preview-collapse">{shown && <div className="mv-library-preview" key={shown.roomId}>
        <div className="mv-library-preview-body"><div className="mv-library-preview-cover">{shown.cover ? <img src={shown.cover} alt="" referrerPolicy="no-referrer" onError={event => { event.currentTarget.style.visibility = 'hidden'; }} /> : <Video size={24} />}</div>
          <div><strong>{shown.anchorName}</strong><p>{shown.title}</p><small>房间 {shown.roomId}</small><small>{shown.status === 'live' ? '正在直播' : shown.status === 'offline' ? '暂未开播' : '状态未知'} · {shown.online === null ? '在线人数暂不可用' : `${shown.online.toLocaleString()} 人`}</small></div></div>
        {renderBadges && <div className="mv-library-preview-badges">{renderBadges(shown)}</div>}
        {renderActions(shown, { complete: () => { setInput(''); onClose(); }, reportError: setError })}
      </div>}</AnimatedCollapse>
    </div>
  </div>, document.fullscreenElement ?? document.body);
}
