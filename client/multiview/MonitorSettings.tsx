import React from 'react';
import { Eye, EyeOff, Grid3X3, LayoutGrid, RefreshCw, ShieldCheck, Zap } from 'lucide-react';
import { InfoPopover, SegmentedControl, ToggleButton, UiSlider } from '../ui';
import { MAX_GRID_GAP, MIN_GRID_GAP, type MultiviewPreferences } from './preferences';
import './monitor-settings.css';

export function LayoutModeControl({ enabled, onChange }: {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return <div className="mv-layout-mode-controls">
    <SegmentedControl label="布局模式" value={enabled ? 'adaptive' : 'fixed'} defaultValue="fixed"
      className="mv-layout-mode-tabs" options={[
        { value: 'fixed', label: '固定布局', icon: <LayoutGrid size={14} aria-hidden="true" /> },
        { value: 'adaptive', label: '自适应网格', icon: <Grid3X3 size={14} aria-hidden="true" /> },
      ]} onChange={value => { const next = value === 'adaptive'; if (next !== enabled) onChange(next); }} />
  </div>;
}

export function AdaptiveGridDetails({ roomCount, maxRooms = 48 }: { roomCount: number; maxRooms?: number }) {
  return <div className="mv-adaptive-grid-copy">
    <div className="mv-adaptive-grid-heading"><strong>完全自适应网格</strong><InfoPopover label="查看自适应网格说明">
      <p>按当前画布和 16:9 画面比例自动计算均匀网格，1–{maxRooms} 路均适用。</p>
      <p>多路同时播放会增加浏览器解码、内存和带宽占用。</p>
    </InfoPopover></div>
    <span className="mv-adaptive-grid-capacity">当前观看 {Math.min(roomCount, maxRooms)}/{maxRooms}</span>
    <p>根据画面数量和观看区域自动排布，无需选择模板。</p>
    <p>切回固定布局时按数量恢复模板，超过 12 路保留前 12 路，并可撤销。</p>
  </div>;
}

export function MonitorSettings({ preferences, onChange }: {
  preferences: MultiviewPreferences;
  onChange: (patch: Partial<MultiviewPreferences>) => void;
}) {
  return <section className="mv-settings">
    <div className="mv-sidebar-heading"><strong>观看设置</strong></div>
    <fieldset className="mv-settings-group">
      <legend>播放模式</legend>
      <div className="mv-settings-modes">
        <ToggleButton active={preferences.playbackMode === 'stable'}
          onChange={() => { if (preferences.playbackMode !== 'stable') onChange({ playbackMode: 'stable' }); }}
          label="稳定优先" onIcon={<ShieldCheck size={16} />} offIcon={<ShieldCheck size={16} />}
          onTitle="使用稳定优先模式" offTitle="使用稳定优先模式" />
        <ToggleButton active={preferences.playbackMode === 'low-latency'}
          onChange={() => { if (preferences.playbackMode !== 'low-latency') onChange({ playbackMode: 'low-latency' }); }}
          label="低延迟" onIcon={<Zap size={16} />} offIcon={<Zap size={16} />}
          onTitle="使用低延迟模式" offTitle="使用低延迟模式" />
      </div>
    </fieldset>
    <fieldset className="mv-settings-group">
      <legend>播放与恢复</legend>
      <ToggleButton active={preferences.autoReconnect} onChange={() => onChange({ autoReconnect: !preferences.autoReconnect })}
        label="检测到播放中断后自动尝试恢复" onIcon={<RefreshCw size={16} />} offIcon={<RefreshCw size={16} />}
        onTitle="关闭自动恢复" offTitle="开启自动恢复" />
      <ToggleButton active={preferences.stopHidden} onChange={() => onChange({ stopHidden: !preferences.stopHidden })}
        label="停止隐藏画面，节省资源" onIcon={<EyeOff size={16} />} offIcon={<Eye size={16} />}
        onTitle="恢复隐藏画面播放" offTitle="停止隐藏画面播放" />
    </fieldset>
    <fieldset className="mv-settings-group">
      <legend>界面</legend>
      <div className="mv-settings-placement">
        <span>快捷控制栏位置</span>
        <SegmentedControl value={preferences.switchbarTop ? 'top' : 'bottom'} defaultValue="bottom"
          label="快捷控制栏位置" options={[{ value: 'bottom', label: '底部' }, { value: 'top', label: '顶部' }]}
          onChange={value => onChange({ switchbarTop: value === 'top' })} />
      </div>
      <div className="mv-settings-placement">
        <span>侧边栏位置</span>
        <SegmentedControl value={preferences.sidebarSide} defaultValue="left"
          label="侧边栏位置" options={[{ value: 'left', label: '左侧' }, { value: 'right', label: '右侧' }]}
          onChange={sidebarSide => onChange({ sidebarSide })} />
      </div>
      <UiSlider label="网格间距" ariaLabel="网格间距" layout="inline" min={MIN_GRID_GAP} max={MAX_GRID_GAP} step={1}
        value={preferences.gridGap} marks={[0, 1, 2, 3, 4, 5].map(value => ({ value }))}
        formatValue={value => `${Math.round(value)}px`} onChange={gridGap => onChange({ gridGap })} />
      <ToggleButton active={preferences.autoHideControls} onChange={() => onChange({ autoHideControls: !preferences.autoHideControls })}
        label="闲置时自动隐藏侧边栏和快捷控制栏" onIcon={<EyeOff size={16} />} offIcon={<Eye size={16} />}
        onTitle="关闭自动隐藏控制栏" offTitle="开启自动隐藏控制栏，闲置 4 秒隐藏，操作时恢复" />
      <div className="mv-settings-placement mv-settings-online-placement">
        <span>直播间人数</span>
        <SegmentedControl value={preferences.onlineCountPosition} defaultValue="hidden" label="直播间人数"
          className="mv-online-count-positions" options={[
            { value: 'hidden', label: '不显示' },
            { value: 'top-left', label: '左上' },
            { value: 'top-right', label: '右上' },
            { value: 'bottom-left', label: '左下' },
            { value: 'bottom-right', label: '右下' },
          ]} onChange={onlineCountPosition => onChange({ onlineCountPosition })} />
      </div>
    </fieldset>
  </section>;
}
