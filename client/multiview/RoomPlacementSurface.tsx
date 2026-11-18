import React, { useEffect, useRef, useState } from 'react';
import { ArrowRightLeft, CornerDownRight, MapPin, Undo2, X } from 'lucide-react';
import type { RoomStatus } from '../../shared/types';
import { layoutGridStyle, SLOT_AREAS, type MultiviewLayout, type RoomSlot } from './layouts';
import type { RoomPlacementResult } from './roomPlacement';
import './roomPlacement.css';

export interface PlacementDraft { roomId: string; targetIndex: number | null; contextKey: string }
const nameOf = (rooms: ReadonlyMap<string, RoomStatus>, id: string | null) => id ? rooms.get(id)?.anchorName || id : '空位';

export function placementDescription(result: RoomPlacementResult, rooms: ReadonlyMap<string, RoomStatus>): string {
  if (!result.ok) return result.reason === 'limit' ? '已达 12 路，请拖到已有画面上替换' : '请选择有效位置';
  switch (result.action) {
    case 'noop': return '已经位于此处';
    case 'move': return '移动到此处，原位置留空';
    case 'swap': return `与${nameOf(rooms, result.targetRoomId)}交换`;
    case 'add': return '放置到此处';
    case 'displace': return `${nameOf(rooms, result.targetRoomId)}移至第 ${result.displacedToIndex! + 1} 格`;
    case 'replace': return `替换${nameOf(rooms, result.replacedRoomId)}，可撤销`;
  }
}

/** Only covers and hints live in this layer. Playback never consumes its draft. */
export function RoomPlacementSurface({ draft, layout, slots, rooms, staticMap, plan }: {
  draft: PlacementDraft | null;
  layout: MultiviewLayout;
  slots: readonly RoomSlot[];
  rooms: ReadonlyMap<string, RoomStatus>;
  staticMap: boolean;
  plan: (index: number) => RoomPlacementResult;
}) {
  const [previous, setPrevious] = useState({ draft, staticMap });
  const shown = draft ?? previous.draft;
  const map = draft ? staticMap : previous.staticMap;
  useEffect(() => {
    if (draft) { setPrevious({ draft, staticMap }); return; }
    const timer = window.setTimeout(() => setPrevious(value => ({ ...value, draft: null })), 180);
    return () => window.clearTimeout(timer);
  }, [draft, staticMap]);
  if (!shown || !rooms.has(shown.roomId)) return null;
  const activeIndex = draft?.targetIndex ?? null;
  const result = activeIndex === null ? null : plan(activeIndex);
  const displaced = result?.ok ? result.displacedToIndex : null;
  return <div className={`mv-placement-surface${map ? ' mv-placement-static' : ''}`}
    data-state={draft ? 'open' : 'closed'} inert={!draft} aria-hidden="true">
    <div className="mv-placement-dialog">
      {map && <header className="mv-placement-heading"><span><MapPin size={16} /><strong>拖入布局</strong></span>
        <small>{nameOf(rooms, shown.roomId)}</small></header>}
      <div className="mv-placement-slots" style={layoutGridStyle(layout)}>
        {SLOT_AREAS.slice(0, layout.count).map((area, index) => {
          const occupant = rooms.get(slots[index] ?? '');
          const active = activeIndex === index, receiver = displaced === index;
          const candidate = plan(index);
          const kind = active ? !candidate.ok ? 'invalid' : candidate.action === 'replace' ? 'replace' : 'target' : receiver ? 'receiver' : 'idle';
          const content = <>
            {map && occupant?.cover && <img src={occupant.cover} alt="" referrerPolicy="no-referrer" draggable={false} />}
            {map && <span className="mv-placement-slot-name">{index + 1} · {occupant?.anchorName || (slots[index] ? slots[index] : '空位')}</span>}
            {(active || receiver) && <span className="mv-placement-label">{receiver ? <CornerDownRight size={15} /> : <ArrowRightLeft size={15} />}
              {receiver ? `${nameOf(rooms, result?.ok ? result.targetRoomId : null)}移到这里` : placementDescription(candidate, rooms)}</span>}
          </>;
          const shared = { className: 'mv-placement-slot', style: { gridArea: area }, 'data-kind': kind };
          return <div key={area} {...shared} data-placement-slot={draft ? index : undefined}>{content}</div>;
        })}
      </div>
      {map && <p className="mv-placement-instructions">{result ? placementDescription(result, rooms) : '松开放置 · Esc 取消'}</p>}
    </div>
  </div>;
}

/** A single bounded notification; focus and hover pause its visible-time budget. */
export function PlacementUndoToast({ message, onUndo, onDismiss }: { message: string; onUndo: () => void; onDismiss: () => void }) {
  const [hovered, setHovered] = useState(false), [focused, setFocused] = useState(false);
  const remaining = useRef(8000), latestDismiss = useRef(onDismiss);
  latestDismiss.current = onDismiss;
  useEffect(() => {
    if (hovered || focused) return;
    const start = performance.now(), timer = window.setTimeout(() => latestDismiss.current(), remaining.current);
    return () => { window.clearTimeout(timer); remaining.current = Math.max(0, remaining.current - (performance.now() - start)); };
  }, [hovered, focused]);
  return <div className="mv-placement-undo" role="status" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onFocus={() => setFocused(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false); }}>
    <span>{message}</span><button onClick={onUndo}><Undo2 size={14} />撤销</button><button className="mv-icon-button" aria-label="关闭撤销提示" onClick={onDismiss}><X size={14} /></button>
  </div>;
}
