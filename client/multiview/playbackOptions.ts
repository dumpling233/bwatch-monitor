import { playbackFormatKey, type PlaybackCapability, type PlaybackFormatPreference,
  type PlaybackInfo, type PlaybackQuality, type PlaybackSource } from '../../shared/playback';

const QUALITY_LABELS: Record<number, string> = { 80: '流畅', 150: '高清', 250: '超清', 400: '蓝光', 10000: '原画', 15000: '2K', 20000: '4K', 30000: '杜比' };
const FORMAT_LABELS: Record<PlaybackFormatPreference, string> = { auto: '自动格式', flv: 'FLV', 'hls-fmp4': 'HLS fMP4', 'hls-ts': 'HLS TS' };

export const playbackFormatLabel = (format: PlaybackFormatPreference): string => FORMAT_LABELS[format];
const tidyLabel = (value: string | undefined): string => value?.trim().replace(/\s+/g, ' ') ?? '';
const comparisonLabel = (value: string): string => value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, '');

/** Combine upstream brief/detail names once, keeping equal resolutions distinguishable. */
export function playbackQualityOptionLabel(quality: PlaybackQuality): string {
  const label = tidyLabel(quality.label), detail = tidyLabel(quality.detail);
  const brief = /^QN\s*\d+$/i.test(label) ? '' : label;
  if (!detail) return brief || '其他清晰度';
  if (!brief) return detail;
  const normalizedBrief = comparisonLabel(brief), normalizedDetail = comparisonLabel(detail);
  if (normalizedDetail.includes(normalizedBrief)) return detail;
  if (normalizedBrief.includes(normalizedDetail)) return brief;
  const words = [...brief.split(' '), ...detail.split(' ')];
  const seen = new Set<string>();
  return words.filter(word => { const key = comparisonLabel(word); if (seen.has(key)) return false; seen.add(key); return true; }).join(' ');
}

export function playbackQualityLabel(qn: number, info?: PlaybackInfo): string {
  const qualities = [...(info?.qualities ?? []), ...(info?.capabilities?.flatMap(branch => branch.qualities) ?? []),
    ...(info?.sources.flatMap(source => source.qualities ?? []) ?? [])];
  const candidates = qualities.filter(quality => quality.qn === qn);
  const declared = candidates.find(quality => Boolean(quality.detail)) ?? candidates[0];
  if (declared) {
    const label = playbackQualityOptionLabel(declared);
    if (label !== '其他清晰度') return label;
    if (QUALITY_LABELS[qn]) return QUALITY_LABELS[qn];
  } else if (QUALITY_LABELS[qn]) return QUALITY_LABELS[qn];
  const unnamed = [...new Set(qualities.filter(quality => playbackQualityOptionLabel(quality) === '其他清晰度'
    && !QUALITY_LABELS[quality.qn]).map(quality => quality.qn))];
  return unnamed.length > 1 && unnamed.includes(qn) ? `其他清晰度 ${unnamed.indexOf(qn) + 1}` : '其他清晰度';
}

export const userPlaybackQualityLabel = playbackQualityLabel;

function unionQualities(groups: readonly (readonly PlaybackQuality[])[]): PlaybackQuality[] {
  const qualities = new Map<number, PlaybackQuality>();
  for (const group of groups) for (const quality of group) {
    const previous = qualities.get(quality.qn);
    if (!previous) qualities.set(quality.qn, quality);
    else if (!previous.detail && quality.detail) qualities.set(quality.qn, { ...previous, detail: quality.detail });
  }
  return [...qualities.values()];
}

export interface PlaybackOptions {
  /** Advertised options for the selected format; these are not verified account entitlements. */
  qualities: PlaybackQuality[];
  allQualities: PlaybackQuality[];
  formats: { value: PlaybackFormatPreference; label: string }[];
  /** Only URLs returned for this request, preserving distinct addresses on the same host. */
  sources: PlaybackSource[];
  branches: PlaybackCapability[];
}

/** A room's menu is derived from its snapshot, never from a fixed quality catalog or its active URL alone. */
export function buildPlaybackOptions(info: PlaybackInfo | undefined, preferredFormat: PlaybackFormatPreference = 'auto',
  supports: (branch: PlaybackCapability) => boolean = () => true): PlaybackOptions {
  if (!info) return { qualities: [], allQualities: [], formats: [], sources: [], branches: [] };
  const declared = info.capabilities?.length ? info.capabilities : info.sources.map(source => ({ protocol: source.protocol, format: source.format,
    codec: source.codec, qualities: source.qualities ?? info.qualities }));
  const grouped = new Map<string, PlaybackCapability>();
  for (const branch of declared) {
    if (!supports(branch)) continue;
    const key = `${branch.protocol}:${branch.format}:${branch.codec}`;
    const previous = grouped.get(key);
    grouped.set(key, { ...branch, qualities: unionQualities([previous?.qualities ?? [], branch.qualities]) });
  }
  const branches = [...grouped.values()];
  const selected = preferredFormat === 'auto' ? branches : branches.filter(branch => playbackFormatKey(branch) === preferredFormat);
  const allQualities = unionQualities(branches.map(branch => branch.qualities));
  const availableFormats = [...new Set(branches.map(playbackFormatKey))];
  const formats: PlaybackOptions['formats'] = branches.length
    ? [{ value: 'auto', label: playbackFormatLabel('auto') }, ...availableFormats.map(value => ({ value, label: playbackFormatLabel(value) }))] : [];
  const sources = info.sources.filter(source => supports({ ...source, qualities: source.qualities ?? info.qualities })
    && (preferredFormat === 'auto' || playbackFormatKey(source) === preferredFormat));
  return { qualities: unionQualities(selected.map(branch => branch.qualities)), allQualities, formats, sources, branches };
}
