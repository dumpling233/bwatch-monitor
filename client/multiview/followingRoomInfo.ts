import type { LocalFollowingRoomInfo } from '../../shared/localFollowing';
import type { CustomRoomRecord } from './customRooms';
import { localChatImage } from './localChatClient';
import { LocalLoginClientError } from './localLoginClient';

const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const stamp = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Accept only the canonical room and owner requested under this account epoch. */
export function readFollowingRoomInfo(value: unknown, roomId: string, uid: string, accountUid: string, authEpoch: string): CustomRoomRecord {
  const info = record(value);
  if (!info || info.roomId !== roomId || info.uid !== uid || info.accountUid !== accountUid || info.authEpoch !== authEpoch ||
    !text(info.anchorName, 128) || !text(info.title, 512) || !['live', 'offline', 'unknown'].includes(String(info.status)) ||
    !(info.online === null || count(info.online)) || typeof info.onlineStale !== 'boolean' ||
    !stamp(info.metadataFetchedAt) || !stamp(info.resolvedAt) || info.metadataFetchedAt > info.resolvedAt ||
    typeof info.metadataStale !== 'boolean' || !(info.liveStartTime === null || stamp(info.liveStartTime)) ||
    (info.onlineLastSuccessAt !== undefined && (!stamp(info.onlineLastSuccessAt) || info.onlineLastSuccessAt > info.resolvedAt)) ||
    (info.online !== null && !stamp(info.onlineLastSuccessAt)) ||
    (info.onlineError !== undefined && !text(info.onlineError, 160)) || (info.metadataError !== undefined && !text(info.metadataError, 160)) ||
    (info.retryAfterMs !== undefined && (typeof info.retryAfterMs !== 'number' || !Number.isFinite(info.retryAfterMs) || info.retryAfterMs < 0))) {
    throw new LocalLoginClientError('UNAVAILABLE', '房间信息暂时无法更新');
  }
  const cover = info.cover === undefined ? undefined : localChatImage(info.cover);
  if (info.cover !== undefined && !cover) throw new LocalLoginClientError('UNAVAILABLE', '房间信息暂时无法更新');
  const data = info as unknown as LocalFollowingRoomInfo;
  const owner = Number(uid);
  return { source: 'custom', input: roomId, roomId, uid: Number.isSafeInteger(owner) ? owner : null,
    anchorName: data.anchorName, title: data.title, ...(cover ? { cover } : {}), status: data.status,
    online: data.online, onlineStale: data.onlineStale, onlineLastSuccessAt: data.onlineLastSuccessAt,
    onlineError: data.onlineError, liveStartTime: data.liveStartTime,
    metadataFetchedAt: data.metadataFetchedAt, metadataStale: data.metadataStale, metadataError: data.metadataError,
    lastUpdatedAt: data.resolvedAt, retryAfterMs: data.retryAfterMs,
    fansCount: null, fansStale: false, guardCount: null, guardStale: false };
}
