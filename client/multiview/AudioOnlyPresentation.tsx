import React from 'react';
import { Headphones, Video } from 'lucide-react';

export function AudioOnlyPresentation({ name, animated, onRestore, delivery }: {
  name: string; animated: boolean; onRestore: () => void; delivery?: 'audio-only' | 'full-stream' | null;
}) {
  return <div className="mv-audio-only" data-animated={animated}>
    <div className="mv-audio-only-lines" aria-hidden="true">{[0, 1, 2, 3, 4].map(index => <i key={index} style={{ '--mv-audio-line': index } as React.CSSProperties} />)}</div>
    <span className="mv-audio-only-label" title={delivery === 'audio-only' ? '正在播放纯音频，已减少视频流量'
      : delivery === 'full-stream' ? '当前使用完整直播流，仅播放声音，仍消耗视频流量' : '仅播放声音'}>
      <Headphones size={15} />{delivery === 'audio-only' ? '纯音频 · 省流量' : delivery === 'full-stream' ? '仅听声音 · 完整直播流' : '仅听声音'}</span>
    <button type="button" className="mv-audio-only-restore" aria-label={`${name}播放画面`} onClick={onRestore}><Video size={15} />播放画面</button>
  </div>;
}
