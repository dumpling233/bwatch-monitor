import type { MonitorRoomDescriptor } from '../../shared/types';

/** Public display observations never change room bindings or invent viewer counts. */
export function mergeFollowingMetadata<T extends MonitorRoomDescriptor>(base: T, observation?: MonitorRoomDescriptor,
  trustedDetails: boolean | 'public-room' = false): T {
  if (!observation || observation.roomId !== base.roomId || observation.metadataStale ||
    (base.uid !== null && observation.uid !== null && base.uid !== observation.uid)) return base;
  const observedAt = observation.metadataFetchedAt;
  const previousAt = base.metadataFetchedAt ?? base.lastUpdatedAt;
  if (observedAt === null || !Number.isFinite(observedAt) || observedAt <= 0) return base;
  // Canonical cover and viewer samples can fill a newer directory observation;
  // its already-newer live status/name must still follow their own freshness.
  const newerMetadata = observedAt > previousAt;
  const canonicalCover = trustedDetails === 'public-room' && Boolean(observation.cover);
  const sampleAt = observation.onlineLastSuccessAt ?? observedAt;
  const previousSampleAt = base.onlineLastSuccessAt ?? 0;
  const usableCount = trustedDetails && observation.online !== null && Number.isSafeInteger(observation.online)
    && observation.online >= 0 && Number.isFinite(sampleAt) && sampleAt > 0 && sampleAt >= previousSampleAt;
  if (!newerMetadata && !usableCount && !canonicalCover) return base;
  const knownStatus = observation.status !== 'unknown';
  const status = newerMetadata && knownStatus ? observation.status : base.status;
  const sameLive = status === 'live' && base.status === 'live';
  const next = { ...base,
    anchorName: newerMetadata ? observation.anchorName || base.anchorName : base.anchorName,
    title: newerMetadata ? observation.title || base.title : base.title,
    cover: canonicalCover || newerMetadata ? observation.cover || base.cover : base.cover,
    status,
    // The following endpoint does not provide a trustworthy audience count.
    // Preserve an existing live sample, without inventing a new observation time.
    online: status === 'live' && usableCount ? observation.online : sameLive ? base.online : null,
    onlineStale: status === 'live' && usableCount ? observation.onlineStale
      : status === 'live' && trustedDetails && newerMetadata && observation.onlineStale ? true
        : sameLive ? base.onlineStale : false,
    liveStartTime: newerMetadata && trustedDetails && status === 'live' ? observation.liveStartTime
      : sameLive ? base.liveStartTime : null,
    lastUpdatedAt: Math.max(base.lastUpdatedAt, observedAt),
    metadataFetchedAt: newerMetadata ? observedAt : base.metadataFetchedAt, metadataStale: false, metadataError: undefined,
    ...(knownStatus ? { error: undefined } : {})
  };
  if (status !== 'live') {
    delete next.onlineLastSuccessAt; delete next.onlineError;
  } else if (usableCount) {
    next.onlineLastSuccessAt = sampleAt; next.onlineError = observation.onlineError;
  } else if (trustedDetails && newerMetadata && observation.onlineStale) {
    next.onlineError = observation.onlineError;
  }
  return next;
}
