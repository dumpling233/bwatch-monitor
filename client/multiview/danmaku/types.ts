export interface DanmakuSegment {
  type: 'text' | 'emote';
  text: string;
  url?: string;
  /** Upstream identifier, never inferred from the display name or send rights. */
  unique?: string;
  /** Message semantics, independent of the original image's pixel dimensions. */
  emoteSize?: 'small' | 'large';
  width?: number;
  height?: number;
  dynamic?: boolean;
}

export interface DanmakuMedal {
  name: string;
  level: number;
  targetRoomId?: string;
  targetUid?: string;
  color?: string;
  colorStart?: string;
  colorEnd?: string;
  colorBorder?: string;
  lighted?: boolean;
  /** The medal's relationship, never the sender's role in the current room. */
  guardLevel?: 0 | 1 | 2 | 3;
}

export interface DanmakuMessage {
  id: string;
  roomId: string;
  kind: 'danmaku' | 'sc';
  text: string;
  userName: string;
  /** Present only when upstream provides an exact, positive numeric UID. */
  userId?: string;
  userIdentity?: 'full' | 'masked' | 'unknown';
  /** Upstream privacy flags take precedence over historical identity caches. */
  isMystery?: boolean;
  avatarUrl?: string;
  /** These optional values distinguish missing upstream evidence from false/0. */
  isModerator?: boolean;
  isAnchor?: boolean;
  guardLevel?: 0 | 1 | 2 | 3;
  roleRoomId?: string;
  sourceRoomId?: string;
  isMirror?: boolean;
  medal?: DanmakuMedal;
  segments?: DanmakuSegment[];
  color: string;
  sourceTime: number;
  receivedAt: number;
  price?: number;
  scColors?: import('./superChatColors').SuperChatColors;
}

export interface DanmakuRoomState {
  status: 'idle' | 'connecting' | 'live' | 'retrying' | 'error';
  receiveMode?: 'anonymous' | 'authenticated';
  hasGap?: boolean;
  error?: string;
  retryAt?: number;
  messages: DanmakuMessage[];
  superChats: DanmakuMessage[];
}

export type DanmakuEvent = { type: 'message'; message: DanmakuMessage }
  | { type: 'delete-sc'; roomId: string; ids: string[] };

export interface DanmakuConnectionState {
  status: DanmakuRoomState['status'];
  error?: string;
  retryAt?: number;
}

export type DanmakuWorkerCommand =
  | { type: 'begin'; roomId: string; generation: number; clearVersion: number; superChats: DanmakuMessage[] }
  | { type: 'connect'; roomId: string; generation: number; bootstrap: import('../../../shared/danmaku').DanmakuBootstrap; hostIndex: number }
  | { type: 'disconnect'; roomId: string; generation: number }
  | { type: 'clear'; roomId: string; generation: number; clearVersion: number }
  | { type: 'ack'; batchId: number }
  | { type: 'dispose' };

export interface DanmakuBatchRoom {
  roomId: string;
  generation: number;
  clearVersion: number;
  events: DanmakuEvent[];
  /** Only congestion coalesces SC changes into their bounded final state. */
  superChats?: DanmakuMessage[];
  scSnapshot?: { id: string; offset: number; total: number; messages: DanmakuMessage[]; complete: boolean };
}

export type DanmakuWorkerEvent =
  | { type: 'state'; roomId: string; generation: number; state: DanmakuConnectionState }
  | { type: 'events'; roomId: string; generation: number; events: DanmakuEvent[] }
  | { type: 'batch'; batchId: number; rooms: DanmakuBatchRoom[] };
