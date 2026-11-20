import React from 'react';
import { Volume2, VolumeX } from 'lucide-react';
import { UiSlider } from '../ui';
import { MAX_ROOM_AUDIO_BALANCE, MIN_ROOM_AUDIO_BALANCE } from './preferences';
import './room-audio-balance.css';

const centerMark = [{ value: 0 }];

function formatBalance(value: number) {
  return value === 0 ? '居中' : `${value < 0 ? '左' : '右'} ${Math.abs(value)}`;
}

export type RoomAudioBalanceProps = {
  balance: number;
  balanceUnavailable?: boolean;
  onBalanceChange: (value: number) => void;
};

export function RoomAudioBalance({ name, balance, balanceUnavailable, onBalanceChange, inline = false }: RoomAudioBalanceProps & {
  name: string;
  inline?: boolean;
}) {
  const unavailableText = '当前播放方式暂不支持声道平衡，继续播放原声';
  return <UiSlider className="mv-room-balance" layout={inline ? 'inline' : 'stacked'}
    label={<>{inline ? (balanceUnavailable ? null : '声道') : '声道平衡'}{balanceUnavailable && <span className="mv-room-balance-note" role="status" title={unavailableText}>原声</span>}</>}
    ariaLabel={`${name} 声道平衡${balanceUnavailable ? '（当前播放原声）' : ''}`} value={balance}
    min={MIN_ROOM_AUDIO_BALANCE} max={MAX_ROOM_AUDIO_BALANCE} marks={centerMark} formatValue={formatBalance}
    resetValue={{ label: `${name} 声道平衡回中`, onClick: () => onBalanceChange(0) }} onChange={onBalanceChange} />;
}

export function MixerRoomAudio({ name, volume, muted, onSelect, onToggle, onVolumeChange, ...balanceProps }: RoomAudioBalanceProps & {
  name: string;
  volume: number;
  muted: boolean;
  onSelect: () => void;
  onToggle: () => void;
  onVolumeChange: (volume: number) => void;
}) {
  return <div className={`mv-mixer-room${!muted ? ' mv-audible' : ''}`}>
    <div className="mv-mixer-room-heading">
      <button type="button" className="mv-room-name-button" onClick={onSelect}>{name}</button>
      <button type="button" className="mv-icon-button" aria-label={`${name}${muted ? '取消静音' : '静音'}`}
        aria-pressed={!muted} onClick={onToggle}>{muted ? <VolumeX /> : <Volume2 />}</button>
    </div>
    <div className="mv-mixer-room-levels">
      <UiSlider className="mv-room-volume" label="音量" ariaLabel={`${name}混音音量`}
        min={0} max={1} step={0.01} value={volume} formatValue={value => `${Math.round(value * 100)}%`} onChange={onVolumeChange} />
      <RoomAudioBalance name={name} {...balanceProps} />
    </div>
  </div>;
}
