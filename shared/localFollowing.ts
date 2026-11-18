/** Account-bound, read-only page. No credential or reusable upstream URL crosses the bridge. */
export interface LocalFollowingRoom {
  roomId: string;
  uid: string;
  anchorName: string;
  title: string;
  cover?: string;
  status: 'live' | 'offline' | 'unknown';
  online: number | null;
  liveStartTime: number | null;
  lastLiveTime: number | null;
}

export interface LocalFollowingRoomsPage {
  accountUid: string;
  authEpoch: string;
  page: number;
  pageSize: number;
  total: number | null;
  liveCount: number | null;
  hasMore: boolean;
  rooms: LocalFollowingRoom[];
  resolvedAt: number;
  directorySource?: 'live' | 'relations';
  /** Account progress only; never a room total. */
  accountTotal?: number | null;
  scannedAccounts?: number;
  scannedUids?: string[];
  /** Successful status lookup did not identify a room; retained for later batch monitoring. */
  unresolvedUids?: string[];
}

/** Public live status, requested only within the verified account's following view. */
export interface LocalFollowingRoomStatus {
  uid: string;
  roomId: string;
  status: 'live' | 'offline' | 'unknown';
  /** Batch status fields are popularity, not viewer counts; kept null. */
  online?: number | null;
  liveStartTime: number | null;
  anchorName?: string;
  title?: string;
  cover?: string;
}

export interface LocalFollowingStatusBatch {
  accountUid: string;
  authEpoch: string;
  /** Exact requested order; an absent room entry is unknown, never implicitly offline. */
  uids: string[];
  rooms: LocalFollowingRoomStatus[];
  /** Only an explicit matching UID with room_id=0; absent response entries are not included. */
  noRoomUids?: string[];
  resolvedAt: number;
}

/** Public room metadata and verified viewer count, bound to the current account grant. */
export interface LocalFollowingRoomInfo {
  accountUid: string;
  authEpoch: string;
  roomId: string;
  uid: string;
  anchorName: string;
  title: string;
  cover?: string;
  status: 'live' | 'offline' | 'unknown';
  liveStartTime: number | null;
  online: number | null;
  onlineStale: boolean;
  onlineLastSuccessAt?: number;
  onlineError?: string;
  metadataFetchedAt: number;
  metadataStale: boolean;
  metadataError?: string;
  resolvedAt: number;
  retryAfterMs?: number;
}
