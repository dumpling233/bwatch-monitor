import React, { memo, useEffect, useState } from 'react';
import type { LiveStatus } from '../../shared/types';
import { durationText, subscribeLiveDurationClock } from './liveDurationClock';

function ElapsedLiveDuration({ startTime }: { startTime: number | null }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => subscribeLiveDurationClock(setNow), []);
  return <>{durationText(startTime, now)}</>;
}

/** Keep second-by-second updates inside the timer instead of the entire panel. */
export const LiveDuration = memo(function LiveDuration({ name, status, startTime }: {
  name: string;
  status: LiveStatus;
  startTime: number | null;
}) {
  return <span className="mv-live-duration" role="timer" aria-label={`${name}开播时长`} aria-live="off" title="本场已开播时长，暂停或刷新不会重置">
    {status === 'live' ? <ElapsedLiveDuration startTime={startTime} /> : status === 'offline' ? '未开播' : '—'}
  </span>;
});
