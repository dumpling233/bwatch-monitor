export type LiveStatus = 'live' | 'offline' | 'unknown';

/** 所有直播间均由用户添加或从本机关注列表选择。 */
export type MonitorRoomSource = 'custom';

export interface RoomStatus {
  roomId: string;
  uid: number | null;
  anchorName: string;
  title: string;
  cover?: string;
  status: LiveStatus;
  online: number | null;
  onlineStale: boolean;
  onlineLastSuccessAt?: number;
  onlineError?: string;
  fansCount: number | null;
  fansStale: boolean;
  fansLastSuccessAt?: number;
  fansError?: string;
  guardCount: number | null;
  guardStale: boolean;
  guardLastSuccessAt?: number;
  guardError?: string;
  liveStartTime: number | null;
  lastUpdatedAt: number;
  error?: string;
}

/** 浏览器本地添加的 B 站房间描述；不包含播放地址、Cookie 或弹幕凭证。 */
export interface MonitorRoomDescriptor extends RoomStatus {
  source: MonitorRoomSource;
  input?: string;
  metadataFetchedAt: number | null;
  metadataStale: boolean;
  metadataError?: string;
}
