import React, { type CSSProperties } from 'react';
import type { DanmakuMedal } from './types';

type MedalAppearance = Pick<DanmakuMedal, 'name' | 'level' | 'color' | 'colorStart' | 'colorEnd' | 'colorBorder' | 'lighted'>;

/** One visual for received messages, the account's selected medal, and its catalogue. */
export function DanmakuMedalBadge({ medal, title }: { medal: MedalAppearance; title?: string }) {
  return <span className={`mv-danmaku-medal${medal.lighted === false ? ' mv-danmaku-medal-unlit' : ''}`} style={{
    '--medal-color': medal.colorStart ?? medal.color ?? '#547d9b',
    '--medal-end': medal.colorEnd ?? medal.color ?? '#547d9b',
    '--medal-border': medal.colorBorder ?? medal.color ?? '#547d9b',
  } as CSSProperties} title={title}><span>{medal.name}</span><b>{medal.level}</b></span>;
}
