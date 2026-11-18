import { parsePlaybackInfo, isTrustedPlaybackUrl } from '../../shared/playbackParser';
import type { PlaybackInfo } from '../../shared/playback';
import { audioApiUrl, validAudioRoom } from './audioApi';
import { BrokerError } from './broker';
import type { LocalCookieTransport } from './cookieTransport';

const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const cancelled = () => new DOMException('请求已取消', 'AbortError');
async function boundedText(response: Response): Promise<string> {
  const limit = 512 * 1024;
  if (Number(response.headers.get('content-length')) > limit || !response.body) throw new BrokerError('UNAVAILABLE', '纯音频信息超出限制');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let bytes = 0, text = '';
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > limit) { await reader.cancel(); throw new BrokerError('UNAVAILABLE', '纯音频信息超出限制'); }
      text += decoder.decode(part.value, { stream: true });
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}

/** Upgrade only the known CDN origin, preserving all signed path/query bytes. No IP/PCDN fallback. */
function audioHost(value: unknown): string | undefined {
  if (typeof value !== 'string' || /[\s\\]/.test(value)) return;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port ||
      url.pathname !== '/' || url.search || url.hash || !['bilivideo.com', 'bilivideo.cn'].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) return;
    return value.replace(/^http:/, 'https:');
  } catch { return; }
}

export function parseAudioPlayback(data: unknown, roomId: string, now: number): PlaybackInfo {
  const value = object(data), playInfo = object(value.playurl_info), play = object(playInfo.playurl);
  const streams = list(play.stream).slice(0, 8).map(object).filter(stream => stream.protocol_name === 'http_stream').map(stream => ({
    ...stream, format: list(stream.format).slice(0, 8).map(object).filter(format => format.format_name === 'flv').map(format => ({
      ...format, codec: list(format.codec).slice(0, 8).map(object).map(codec => ({ ...codec,
        url_info: list(codec.url_info).slice(0, 8).map(object).flatMap(info => {
          const host = audioHost(info.host); return host ? [{ ...info, host }] : [];
        }) })),
    })),
  }));
  const result = parsePlaybackInfo({ ...value, playurl_info: { ...playInfo, playurl: { ...play, stream: streams } } }, roomId, 150, now);
  result.sources = result.sources.filter(source => {
    const url = new URL(source.url);
    return source.protocol === 'flv' && url.searchParams.get('media_type') === '1' &&
      isTrustedPlaybackUrl(source.url) && source.url.length <= 1800 && !/[|*^]/.test(source.url);
  }).slice(0, 4);
  // The old app response can still describe AVC. The page must confirm actual audio-only media.
  if (result.status === 'live' && !result.sources.length) result.status = 'restricted';
  return result;
}

interface Options {
  transport: Pick<LocalCookieTransport, 'run'>;
  fetch?: typeof fetch;
  now?: () => number;
}
interface Work { controller: AbortController; promise: Promise<PlaybackInfo>; consumers: number }

/** On-demand anonymous configuration only; it never downloads or relays media. */
export class LocalAudioPlayback {
  private readonly cache = new Map<string, { info: PlaybackInfo; until: number }>();
  private readonly tasks = new Map<string, Work>();
  private readonly forced = new Map<string, number>();
  private blockedUntil = 0;
  constructor(private readonly options: Options) {}
  private now(): number { return (this.options.now ?? Date.now)(); }
  async resolve(roomId: unknown, force: unknown, signal: AbortSignal): Promise<PlaybackInfo> {
    if (!validAudioRoom(roomId) || force !== undefined && typeof force !== 'boolean') throw new BrokerError('INVALID_REQUEST', '直播间参数无效');
    if (signal.aborted) throw cancelled();
    if (this.blockedUntil > this.now()) throw new BrokerError('RATE_LIMITED', '纯音频暂不可用', Math.ceil((this.blockedUntil - this.now()) / 1000));
    const cached = this.cache.get(roomId);
    if (!force && cached && cached.until > this.now()) { this.cache.delete(roomId); this.cache.set(roomId, cached); return cached.info; }
    let work = this.tasks.get(roomId);
    if (!work) {
      if (this.tasks.size >= 64) throw new BrokerError('RATE_LIMITED', '纯音频请求繁忙', 5);
      if (force && (this.forced.get(roomId) ?? -Infinity) + 5000 > this.now()) throw new BrokerError('RATE_LIMITED', '请稍后再试', 5);
      if (force) { this.forced.delete(roomId); this.forced.set(roomId, this.now()); }
      while (this.forced.size > 128) this.forced.delete(this.forced.keys().next().value!);
      const controller = new AbortController();
      work = { controller, consumers: 0, promise: Promise.resolve(undefined as never) };
      const current = work;
      current.promise = this.request(roomId, controller).finally(() => { if (this.tasks.get(roomId) === current) this.tasks.delete(roomId); });
      void current.promise.catch(() => {});
      this.tasks.set(roomId, current);
    }
    work.consumers++;
    const current = work;
    return new Promise<PlaybackInfo>((resolve, reject) => {
      let finished = false;
      const done = () => { if (finished) return false; finished = true; signal.removeEventListener('abort', abort); if (--current.consumers === 0 && this.tasks.get(roomId) === current) current.controller.abort(); return true; };
      const abort = () => { if (done()) reject(cancelled()); };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
      current.promise.then(info => { if (done()) resolve(info); }, failure => { if (done()) reject(failure); });
    });
  }
  private async request(roomId: string, controller: AbortController): Promise<PlaybackInfo> {
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const url = audioApiUrl(roomId, this.now());
      const info = await this.options.transport.run(url, 'anonymous', controller.signal, async (_cookies, signal) => {
        const response = await (this.options.fetch ?? fetch)(url, { signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
        if ([412, 429].includes(response.status)) {
          const seconds = Number(response.headers.get('retry-after'));
          const retryAfter = Number.isFinite(seconds) && seconds > 0 ? Math.min(300, Math.ceil(seconds)) : 60;
          this.blockedUntil = this.now() + retryAfter * 1000;
          throw new BrokerError('RATE_LIMITED', '纯音频暂不可用', retryAfter);
        }
        if (!response.ok) throw new BrokerError('UNAVAILABLE', '纯音频暂不可用');
        const text = await boundedText(response);
        const payload = object(JSON.parse(text));
        if (payload.code !== 0) throw new BrokerError('UNAVAILABLE', '纯音频暂不可用');
        return parseAudioPlayback(payload.data, roomId, this.now());
      });
      if (controller.signal.aborted) throw cancelled();
      if (info.status === 'live' && info.sources.length) {
        const until = Math.min(this.now() + 30000, ...info.sources.map(source => (source.expiresAt ?? Infinity) - 5000));
        if (until > this.now()) { this.cache.delete(roomId); this.cache.set(roomId, { info, until }); }
        while (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value!);
      }
      return info;
    } finally { clearTimeout(timer); }
  }
}
