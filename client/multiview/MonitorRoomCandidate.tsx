import React from 'react';
import { Bookmark, BookmarkCheck, Check, Headphones, Plus, RefreshCw, Trash2, Users, Video } from 'lucide-react';
import type { MonitorRoomDescriptor } from '../../shared/types';
import type { PlayerStatus } from './playbackSession';
import { OverflowMarquee } from '../overflowMarquee';
import { RollingNumber } from '../ui';
import './monitorRoomCandidate.css';

export function MonitorRoomCandidate({ room, selected, disabled, dragging, onToggle, onPointerDown, onClickCapture,
  saved = false, collection = 'mine', onSave, onRemoveSaved,
  unavailable = false, refreshing = false, onRevalidate, onRemove, mediaMode, onRestoreVideo, playbackStatus }: {
  room: MonitorRoomDescriptor;
  selected: boolean;
  disabled?: boolean;
  dragging?: boolean;
  onToggle: () => void;
  onPointerDown?: (event: React.PointerEvent<HTMLElement>) => void;
  onClickCapture?: (event: React.MouseEvent<HTMLElement>) => void;
  saved?: boolean;
  collection?: 'mine' | 'following' | 'watching';
  onSave?: () => void;
  onRemoveSaved?: () => void;
  unavailable?: boolean;
  refreshing?: boolean;
  onRevalidate?: () => void;
  /** Compatibility for callers predating the personal room library. */
  onRemove?: () => void;
  mediaMode?: 'video' | 'audio';
  onRestoreVideo?: () => void;
  playbackStatus?: PlayerStatus;
}) {
  const name = room.anchorName || '未知主播';
  const title = room.title || (room.status === 'live' ? '直播中' : room.status === 'offline' ? '暂未开播' : '状态未知');
  const online = room.status === 'live' && typeof room.online === 'number' && Number.isFinite(room.online) && room.online >= 0 ? room.online : null;
  const staleOnline = online !== null && room.onlineStale;
  const custom = room.source === 'custom' && !unavailable && collection !== 'following';
  const removeSaved = onRemoveSaved ?? onRemove;
  const tags = [{ id: 'room-origin', name: collection === 'following' ? 'B站关注' : unavailable ? '待验证' : '自定义' }];
  if (collection === 'watching') {
    tags.push({ id: 'room-watching', name: '观看中' });
    if (mediaMode === 'audio') {
      const state = playbackStatus === 'paused' ? '已暂停' : playbackStatus === 'autoplay-blocked' ? '等待点击播放' : playbackStatus === 'stalled' ? '播放停滞'
        : playbackStatus === 'retrying' ? '正在恢复' : playbackStatus === 'error' || playbackStatus === 'unsupported' ? '暂不可用' : '';
      tags.push({ id: 'room-audio', name: `仅听声音${state ? ` · ${state}` : ''}` });
    }
  }
  const blocked = disabled || unavailable;
  const revalidate = unavailable ? onRevalidate : undefined;
  const management = collection === 'following' || !saved ? onSave : removeSaved;
  return <div className={`mv-candidate mv-room-candidate${selected ? ' mv-selected' : ''}${room.status === 'live' && !unavailable ? ' mv-candidate-live' : ''}`}
    data-placement-source={room.roomId} data-placement-dragging={Boolean(dragging)} data-unavailable={unavailable || undefined}
    data-custom={custom || undefined} data-live={room.status === 'live' && !unavailable || undefined}>
    <div className="mv-candidate-main" data-placement-handle="true"
      onPointerDown={unavailable ? undefined : onPointerDown} onClickCapture={onClickCapture} onDragStart={event => event.preventDefault()}
      title={unavailable ? '请重新获取直播间信息' : `拖动${name}到布局中${disabled ? '，已满 12 路时可替换已有画面' : ''}`}>
      <span className="mv-candidate-cover">{room.cover ? <img key={room.cover} src={room.cover} alt="" loading="lazy" referrerPolicy="no-referrer"
        onError={event => { event.currentTarget.style.visibility = 'hidden'; }} /> : <Video size={20} />}</span>
      <span className="mv-candidate-info" data-tags-visible={tags.length > 0}>
        <span className="mv-candidate-heading"><strong className="mv-candidate-name" title={name}>{name}</strong>
          <span className="mv-candidate-online" data-stale={staleOnline} title={online === null ? room.onlineError || '暂无有效在线人数' : staleOnline ? `上次成功获取的在线人数${room.onlineError ? `；${room.onlineError}` : ''}` : '当前在线人数'}>
            <Users size={11} aria-hidden="true" /><RollingNumber value={online} />{staleOnline && <sup>旧</sup>}
          </span>
        </span>
        {tags.length > 0 && <OverflowMarquee contentKey={tags.map(tag => `${tag.id}:${tag.name}`).join('|')}
          className="mv-candidate-tags room-group-tags" trackClassName="room-group-tags-track"
          aria-label={`分组：${tags.map(tag => tag.name).join('、')}`} title={tags.map(tag => tag.name).join('、')}>
          {tags.map(tag => <span className={`room-group-tag${tag.id.startsWith('guest:') || custom && tag.id === 'room-origin' ? ' guest-custom-tag' : ''}${tag.id === 'room-audio' ? ' mv-watching-audio' : ''}`} key={tag.id}>{tag.id === 'room-audio' && <Headphones size={10} aria-hidden="true" />}{tag.name}</span>)}
        </OverflowMarquee>}
        <OverflowMarquee contentKey={title} className="mv-candidate-title" trackClassName="room-title-track" title={title}><span>{title}</span></OverflowMarquee>
      </span>
    </div>
    <div className="mv-candidate-actions" data-columns={revalidate || mediaMode === 'audio' && collection === 'watching' && onRestoreVideo ? '2' : '1'} data-no-placement-drag="true" aria-label={`${name}房间操作`}>
      <button type="button" className="mv-candidate-tool mv-candidate-toggle" aria-label={`${selected ? '移除' : '加入'}${name}`}
        aria-pressed={selected} disabled={blocked} title={unavailable ? '请先重新验证公开房间' : disabled ? '已达到 12 路上限，可从房间信息区域拖入替换' : `${selected ? '移出观看' : '加入观看'}：${name}`}
        onClick={onToggle}>{selected ? <Check size={17} /> : <Plus size={17} />}</button>
      {onRestoreVideo && mediaMode === 'audio' && collection === 'watching' && <button type="button" className="mv-candidate-tool mv-candidate-restore-video" aria-label={`${name}播放画面`} title={`${name}播放画面`} onClick={onRestoreVideo}><Video size={15} /></button>}
      {revalidate && <button type="button" className="mv-candidate-tool mv-candidate-revalidate" disabled={refreshing} aria-busy={refreshing}
        aria-label={`重新验证${name}公开房间`} title={`重新验证${name}公开房间`}
        onClick={revalidate}><RefreshCw size={15} className={refreshing ? 'mv-spin' : undefined} /></button>}
      {management && (collection !== 'following' && saved ? <button type="button" className="mv-candidate-tool mv-candidate-delete"
        aria-label={`从我的房间移除${name}`} title={`从我的房间移除${name}，当前播放继续`} onClick={removeSaved}><Trash2 size={15} /></button>
        : <button type="button" className="mv-candidate-tool mv-candidate-save" data-saved={saved} disabled={saved}
          aria-label={saved ? `${name}已保存到我的房间` : `保存${name}到我的房间`} title={saved ? `${name}已保存到我的房间` : `保存${name}到我的房间`}
          onClick={onSave}>{saved ? <BookmarkCheck size={15} /> : <Bookmark size={15} />}</button>)}
    </div>
  </div>;
}
