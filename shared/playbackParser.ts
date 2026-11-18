import { isPlaybackQuality, type PlaybackCapability, type PlaybackInfo, type PlaybackQuality, type PlaybackSource } from './playback.js';

const CDN_DOMAINS = ['bilivideo.com', 'bilivideo.cn', 'bilivideo.net'];
type Json = Record<string, unknown>;

function object(value: unknown): Json { return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}; }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function qn(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  return isPlaybackQuality(number) ? number : undefined;
}
function description(value: unknown, limit: number): string | undefined {
  return typeof value === 'string' && !/[\u0000-\u001f\u007f]/.test(value) && value.trim()
    ? value.trim().slice(0, limit) : undefined;
}
function qualities(value: unknown): PlaybackQuality[] {
  const found = new Map<number, PlaybackQuality>();
  for (const entry of array(value).slice(0, 32)) {
    const item = object(entry), quality = qn(item.qn);
    const media = object(item.media_base_desc);
    const brief = description(media.brief_desc, 40) ?? description(object(media.brief_desc).desc, 40);
    const detail = description(object(media.detail_desc).desc, 120) ?? description(media.detail_desc, 120);
    const label = brief ?? description(item.desc, 40) ?? description(detail, 40);
    if (quality !== undefined && label) {
      found.set(quality, { qn: quality, label, ...(detail && detail !== label ? { detail } : {}) });
    }
  }
  return [...found.values()];
}
function enabled(value: unknown): boolean {
  return value === true || (typeof value === 'number' && value !== 0) ||
    (typeof value === 'string' && !['', '0', 'false', 'none'].includes(value.toLowerCase())) ||
    (typeof value === 'object' && value !== null && Object.keys(value).length > 0);
}
function restricted(value: Json): boolean {
  return ['drm', 'drm_info', 'drm_type', 'is_drm', 'encrypted', 'is_encrypted', 'is_hidden', 'is_locked', 'license_url', 'key_url']
    .some(key => enabled(value[key]));
}

/** Validate without serializing again: query strings contain upstream signatures. */
export function isTrustedPlaybackUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 8192 || value !== value.trim() || /[\s\\\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash && (!url.port || url.port === '443') &&
      CDN_DOMAINS.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`));
  } catch { return false; }
}

function signedUrl(host: unknown, base: unknown, extra: unknown): string | undefined {
  if (typeof host !== 'string' || typeof base !== 'string' || typeof extra !== 'string' ||
    !base.startsWith('/') || base.startsWith('//') || base.includes('#')) return;
  try {
    const origin = new URL(host);
    if (origin.pathname !== '/' || origin.search || origin.hash) return;
    // Upstream may end base_url with '?' and put bare signed parameters in extra.
    // Concatenate exact bytes; the complete URL and media path are validated separately.
    const value = `${host.endsWith('/') ? host.slice(0, -1) : host}${base}${extra}`;
    return isTrustedPlaybackUrl(value) ? value : undefined;
  } catch { return; }
}

function expiry(url: string, info: Json, now: number): number | undefined {
  const candidates: number[] = [];
  const params = new URL(url).searchParams;
  for (const key of ['expires', 'expire', 'deadline']) {
    const value = params.get(key);
    if (value && /^\d+$/.test(value)) {
      const number = Number(value);
      if (Number.isSafeInteger(number) && number > 1_000_000_000) candidates.push(number > 100_000_000_000 ? number : number * 1000);
    }
  }
  for (const key of ['wsTime', 'wstime', 'ws_time']) {
    const value = params.get(key);
    if (value && /^[a-f\d]{8,12}$/i.test(value)) {
      const number = Number.parseInt(value, 16) * 1000;
      if (Number.isSafeInteger(number)) candidates.push(number);
    }
  }
  const ttl = Number(info.stream_ttl);
  if (Number.isFinite(ttl) && ttl > 0 && ttl <= 7 * 86400) candidates.push(now + ttl * 1000);
  return candidates.length ? Math.min(...candidates) : undefined;
}

function source(url: string, protocol: PlaybackSource['protocol'], format: PlaybackSource['format'], actualQuality: number,
  info: Json, now: number, availableQualities: PlaybackQuality[], idFor: (value: string) => string): PlaybackSource | undefined {
  if (!isTrustedPlaybackUrl(url) || restricted(info)) return;
  const path = new URL(url).pathname;
  if (protocol === 'flv' ? !/\.flv$/i.test(path) : !/\.m3u8$/i.test(path)) return;
  const expiresAt = expiry(url, info, now);
  if (expiresAt !== undefined && expiresAt <= now + 5000) return;
  return { id: idFor(`${protocol}:${format}:${actualQuality}:${url}`),
    url, protocol, format, codec: 'avc', actualQuality, qualities: availableQualities,
    ...(expiresAt === undefined ? {} : { expiresAt }) };
}

function unavailable(roomId: string, requestedQuality: number, now: number, status: 'offline' | 'restricted'): PlaybackInfo {
  return { roomId, status, requestedQuality, qualities: [], sources: [], resolvedAt: now,
    message: status === 'offline' ? '直播间当前未开播' : '当前直播暂未提供可用的播放源，可前往 B站观看' };
}

export function parsePlaybackInfo(data: unknown, roomId: string, requestedQuality: number, now: number, idFor = stableSourceId): PlaybackInfo {
  const value = object(data);
  if (restricted(value)) return unavailable(roomId, requestedQuality, now, 'restricted');
  if (value.live_status === 0 || value.live_status === 2) return unavailable(roomId, requestedQuality, now, 'offline');
  const playInfo = object(value.playurl_info), play = object(playInfo.playurl);
  if (restricted(playInfo) || restricted(play)) return unavailable(roomId, requestedQuality, now, 'restricted');
  if (!Array.isArray(play.stream)) throw new PlaybackError('播放源信息暂时不可用', 503);
  const descriptions = qualities(play.g_qn_desc), accepted = new Set<number>(), sources = new Map<string, PlaybackSource>();
  const capabilities: PlaybackCapability[] = [];
  for (const streamValue of array(play.stream).slice(0, 8)) {
    const stream = object(streamValue);
    if (restricted(stream)) continue;
    const protocol = stream.protocol_name === 'http_hls' ? 'hls' : stream.protocol_name === 'http_stream' ? 'flv' : undefined;
    if (!protocol) continue;
    for (const formatValue of array(stream.format).slice(0, 8)) {
      const format = object(formatValue), name = format.format_name;
      if (restricted(format) || (protocol === 'flv' ? name !== 'flv' : name !== 'ts' && name !== 'fmp4')) continue;
      for (const codecValue of array(format.codec).slice(0, 8)) {
        const codec = object(codecValue), actual = qn(codec.current_qn);
        if (codec.codec_name !== 'avc' || restricted(codec)) continue;
        const accept = array(codec.accept_qn).map(qn).filter((item): item is number => item !== undefined);
        const availableQualities = descriptions.filter(item => accept.includes(item.qn));
        const existing = capabilities.find(item => item.protocol === protocol && item.format === name && item.codec === 'avc');
        if (existing) {
          const qualityIds = new Set(existing.qualities.map(item => item.qn));
          existing.qualities.push(...availableQualities.filter(item => !qualityIds.has(item.qn)));
        } else capabilities.push({ protocol, format: name as PlaybackSource['format'], codec: 'avc', qualities: [...availableQualities] });
        for (const item of accept) accepted.add(item);
        if (actual === undefined || !accept.includes(actual)) continue;
        for (const infoValue of array(codec.url_info).slice(0, 8)) {
          const info = object(infoValue), url = signedUrl(info.host, codec.base_url, info.extra);
          if (!url) continue;
          const item = source(url, protocol, name as PlaybackSource['format'], actual, info, now, availableQualities, idFor);
          if (item && sources.size < 24) sources.set(item.id, item);
        }
      }
    }
  }
  if (!sources.size) return { ...unavailable(roomId, requestedQuality, now, 'restricted'), capabilities,
    qualities: descriptions.filter(item => accepted.has(item.qn)) };
  return { roomId, status: 'live', requestedQuality, qualities: descriptions.filter(item => accepted.has(item.qn)),
    sources: [...sources.values()], capabilities, resolvedAt: now };
}

export function parseLegacyPlaybackInfo(data: unknown, roomId: string, requestedQuality: number, now: number, idFor = stableSourceId): PlaybackInfo {
  const value = object(data);
  if (restricted(value)) return unavailable(roomId, requestedQuality, now, 'restricted');
  if (value.live_status === 0 || value.live_status === 2) return unavailable(roomId, requestedQuality, now, 'offline');
  if (value.codec_name !== undefined && value.codec_name !== 'avc') return unavailable(roomId, requestedQuality, now, 'restricted');
  const actual = qn(value.current_qn) ?? qn(value.current_quality);
  if (actual === undefined) return unavailable(roomId, requestedQuality, now, 'restricted');
  const descriptions = qualities(value.quality_description);
  const accept = array(value.accept_qn ?? value.accept_quality).map(qn).filter((item): item is number => item !== undefined);
  const availableQualities = descriptions.filter(item => accept.length ? accept.includes(item.qn) : item.qn === actual);
  const sources: PlaybackSource[] = [];
  for (const entry of array(value.durl).slice(0, 16)) {
    const info = object(entry);
    if (typeof info.url !== 'string' || (info.codec_name !== undefined && info.codec_name !== 'avc')) continue;
    const item = source(info.url, 'flv', 'flv', actual, info, now, availableQualities, idFor);
    if (item) sources.push(item);
  }
  const capabilities: PlaybackCapability[] = [{ protocol: 'flv', format: 'flv', codec: 'avc', qualities: availableQualities }];
  if (!sources.length) return { ...unavailable(roomId, requestedQuality, now, 'restricted'), qualities: availableQualities, capabilities };
  return { roomId, status: 'live', requestedQuality,
    qualities: availableQualities, sources, capabilities, resolvedAt: now };
}

export class PlaybackError extends Error {
  constructor(message: string, public readonly statusCode = 503, public readonly retryAfter?: number) {
    super(message); this.name = 'PlaybackError';
  }
}


/** Source identifiers are local deduplication keys, never authentication secrets. */
function stableSourceId(value: string): string {
  let left = 2166136261, right = 2246822519;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    left = Math.imul(left ^ code, 16777619);
    right = Math.imul(right ^ code, 3266489917);
  }
  return (left >>> 0).toString(16).padStart(8, '0') + (right >>> 0).toString(16).padStart(8, '0');
}
