import React, { useEffect, useState } from 'react';

/** Keep only a short visual exit; healthy playback does not retain a cover image. */
export function PlayerBackdrop({ visible, cover }: { visible: boolean; cover?: string }) {
  const [present, setPresent] = useState(visible);
  useEffect(() => {
    if (visible) { setPresent(true); return; }
    const timer = window.setTimeout(() => setPresent(false), 180);
    return () => window.clearTimeout(timer);
  }, [visible]);

  return <div className="mv-player-backdrop" data-visible={visible} aria-hidden="true">
    {(visible || present) && cover && <img key={cover} src={cover} alt="" draggable={false} referrerPolicy="no-referrer"
      onLoad={event => { event.currentTarget.style.opacity = '1'; }}
      onError={event => { event.currentTarget.style.visibility = 'hidden'; }} />}
  </div>;
}
