export type PlaybackMediaMode = 'video' | 'audio';
export type PlaybackFormatPreference = 'auto' | 'flv' | 'hls-fmp4' | 'hls-ts';

/** Validate transport parameters without assuming B站's quality catalogue is fixed. */
export function isPlaybackQuality(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 100_000;
}

export function playbackFormatKey(source: Pick<PlaybackSource, 'protocol' | 'format'>): Exclude<PlaybackFormatPreference, 'auto'> {
  return source.protocol === 'flv' ? 'flv' : source.format === 'fmp4' ? 'hls-fmp4' : 'hls-ts';
}

export interface PlaybackQuality {
  qn: number;
  label: string;
  detail?: string;
}

/** Upstream declarations for one supported branch; they do not prove account entitlement or media playback. */
export interface PlaybackCapability {
  protocol: PlaybackSource['protocol'];
  format: PlaybackSource['format'];
  codec: 'avc';
  qualities: PlaybackQuality[];
}

export interface PlaybackSource {
  /** Local audio candidate. Confirm actual tracks before claiming bandwidth savings. */
  mediaKind?: 'audio-only';
  id: string;
  url: string;
  protocol: 'hls' | 'flv';
  format: 'flv' | 'ts' | 'fmp4';
  codec: 'avc';
  actualQuality: number;
  qualities?: PlaybackQuality[];
  expiresAt?: number;
}

export interface PlaybackInfo {
  roomId: string;
  status: 'live' | 'offline' | 'restricted';
  requestedQuality: number;
  qualities: PlaybackQuality[];
  sources: PlaybackSource[];
  capabilities?: PlaybackCapability[];
  resolvedAt: number;
  message?: string;
}
