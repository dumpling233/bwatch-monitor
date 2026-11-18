import type { PlaybackInfo } from '../../shared/playback';
import type { LocalLoginClient } from './localLoginClient';
import type { PlaybackResolveRequest } from './localLoginProvider';
import { pagePlaybackRequestBudget } from './playbackRequestPool';

export interface LocalAudioPlaybackLease { playback: PlaybackInfo; release(): void; }
export type LocalAudioPlaybackResolver = (request: PlaybackResolveRequest) => Promise<LocalAudioPlaybackLease>;
type AudioClient = Pick<LocalLoginClient, 'hello' | 'audioPlayback' | 'releaseAudioPlayback'>;
const cancelled = () => new DOMException('Audio request cancelled', 'AbortError');
const unsupported = () => new Error('Pure audio is unavailable');
const support = new WeakMap<AudioClient, { until: number; pending: boolean; available?: boolean; result: Promise<boolean> }>();

/** A new bridge was verified with HELLO. Old discovery misses no longer describe this document. */
export function invalidateLocalAudioCapability(client: AudioClient): void { support.delete(client); }

/** Shared on-demand HELLO, never a poll and never an account check. */
function supportsAudio(client: AudioClient, force = false): Promise<boolean> {
  const existing = support.get(client);
  if (existing && (existing.pending || existing.until > Date.now() && (!force || existing.available !== false))) return existing.result;
  const entry = { until: Date.now() + 30_000, pending: true, available: undefined as boolean | undefined, result: Promise.resolve(false) };
  entry.result = client.hello().then(hello => {
    const available = hello.capabilities.includes('audio-playback');
    entry.available = available;
    if (available) entry.until = Date.now() + 300_000;
    return available;
  }, () => { entry.available = false; return false; }).finally(() => { entry.pending = false; });
  support.set(client, entry);
  return entry.result;
}

/** Two initializations per page; queued rooms do not spend their network deadline. */
export function createLocalAudioResolver(getClient: () => AudioClient): LocalAudioPlaybackResolver {
  let active = 0;
  const waiting: Array<{ start(): void; signal: AbortSignal }> = [];
  const drain = () => {
    while (active < 2 && waiting.length) {
      const next = waiting.shift()!;
      if (next.signal.aborted) continue;
      active++; next.start();
    }
  };
  return request => new Promise((resolve, reject) => {
    if (request.signal.aborted) { reject(cancelled()); return; }
    if (waiting.length >= 48) { reject(unsupported()); return; }
    request.onQueued?.();
    const abort = () => {
      const index = waiting.indexOf(item);
      if (index >= 0) waiting.splice(index, 1);
      reject(cancelled());
    };
    const item = { signal: request.signal, start: () => {
      request.signal.removeEventListener('abort', abort);
      request.onStarted?.();
      void resolveAudio().then(resolve, reject).finally(() => { active--; drain(); });
    } };
    const resolveAudio = async (): Promise<LocalAudioPlaybackLease> => {
      const { roomId, source, signal } = request;
      const current = () => { if (signal.aborted) throw cancelled(); };
      current();
      const cooldown = pagePlaybackRequestBudget.error();
      if (cooldown) throw cooldown;
      const client = getClient();
      if (!await supportsAudio(client, request.force)) throw unsupported();
      current();
      const result = await client.audioPlayback(roomId, request.force, signal);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        void client.releaseAudioPlayback(result.leaseId).catch(() => undefined);
      };
      try {
        current();
        return { release, playback: { ...result.playback,
          sources: result.playback.sources.map(candidate => ({ ...candidate, mediaKind: 'audio-only' as const })) } };
      } catch (error) { release(); throw error; }
    };
    request.signal.addEventListener('abort', abort, { once: true });
    waiting.push(item); drain();
  });
}
