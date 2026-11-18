import type { PlaybackInfo } from '../../shared/playback';
import type { LocalLoginClient } from './localLoginClient';

export interface PlaybackResolveRequest {
  roomId: string; source: 'custom'; qn: number; force: boolean; signal: AbortSignal;
  onQueued?(): void;
  onStarted?(): void;
}
export type LocalPlaybackResolver = (request: PlaybackResolveRequest) => Promise<PlaybackInfo>;

export async function resolveLocalPlayback(client: Pick<LocalLoginClient, 'playback'>, request: PlaybackResolveRequest, authEpoch: string,
  currentEpoch: () => string | undefined): Promise<PlaybackInfo> {
  const { roomId, source, qn, force, signal } = request;
  const current = () => {
    if (signal.aborted || currentEpoch() !== authEpoch) throw new DOMException('Account changed', 'AbortError');
  };
  current();
  const result = await client.playback(roomId, qn, force, authEpoch, signal);
  current();
  return result;
}
