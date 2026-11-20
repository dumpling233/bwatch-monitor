import React from 'react';
import { Medal } from 'lucide-react';
import { ToggleButton } from '../../ui';
import type { DanmakuPreferences } from './displayPreferences';

type MedalPreference = 'autoWearRoomMedal';

export interface DanmakuMedalToggleControls {
  preferences: Pick<DanmakuPreferences, MedalPreference>;
  onToggle(key: MedalPreference, value: boolean): void;
}

export function DanmakuMedalToggles({ preferences, onToggle, compact = false }: DanmakuMedalToggleControls & { compact?: boolean }) {
  const autoWear = preferences.autoWearRoomMedal === true;
  const wearLabel = '切房自动佩戴勋章';
  const wearIcon = <Medal size={14} aria-hidden="true" />;
  const className = compact ? 'mv-danmaku-medal-quick-toggle' : undefined;
  return <div className={compact ? 'mv-danmaku-medal-quick-toggles' : 'mv-danmaku-medal-setting-toggles'} role="group" aria-label="粉丝勋章设置">
    <ToggleButton active={autoWear} label={compact ? null : wearLabel} ariaLabel={wearLabel} className={className}
      onTitle={`关闭${wearLabel}`} offTitle={`开启${wearLabel}`} onIcon={wearIcon} offIcon={wearIcon}
      onChange={() => onToggle('autoWearRoomMedal', !autoWear)} />
  </div>;
}
