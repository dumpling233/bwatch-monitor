/** Connection metadata only. Messages flow directly from Bilibili to the browser. */
export interface DanmakuHost {
  host: string;
  wssPort: number;
  url: string;
}

export interface DanmakuBootstrap {
  requestedRoomId: string;
  /** Canonical room number used by the upstream authentication packet. */
  roomId: string;
  hosts: DanmakuHost[];
  token: string;
  buvid: string;
  resolvedAt: number;
  /** Optional local-extension identity. Server bootstraps omit these fields. */
  uid?: string;
  mode?: 'anonymous' | 'authenticated';
  authEpoch?: string;
}
