/** A display-only projection of a medal owned by the currently authorized Bilibili account. */
export interface LocalFanMedal {
  id: string;
  targetUid: string;
  roomId?: string;
  name: string;
  level: number;
  anchorName: string;
  lighted: boolean;
  color?: string;
  colorStart?: string;
  colorEnd?: string;
  colorBorder?: string;
  colorText?: string;
  colorLevel?: string;
  guardLevel?: number;
}

/** The official current display projection need not include a writable medal ID. */
export type LocalWearingMedal = Omit<LocalFanMedal, 'id'> & { id?: string };

/** Official room-panel ordering only; never a proof of global selection or directory completeness. */
export interface LocalMedalRoomContext {
  accountUid: string;
  authEpoch: string;
  roomId: string;
  targetUid: string;
  items: LocalFanMedal[];
  resolvedAt: number;
}

/** Account selection and the official room-context display are separate facts. */
export interface LocalMedalPage {
  accountUid: string;
  authEpoch: string;
  roomId: string;
  page: number;
  pageSize: number;
  total: number | null;
  /** Official account-center page count; absent on legacy responses. Zero is an empty first-page directory. */
  totalPages?: number;
  hasMore: boolean;
  items: LocalFanMedal[];
  /** Undefined: this page cannot determine selection. Null: confirmed taken off. */
  selectedMedalId?: string | null;
  /** False means wearing is unavailable, not a confirmed empty room display. */
  displayConfirmed?: boolean;
  /** All returned rows have valid, unambiguous explicit 0/1 wearing states. */
  selectionPageComplete?: boolean;
  wearing: LocalWearingMedal | null;
  resolvedAt: number;
}

export interface LocalMedalSelection {
  accountUid: string;
  authEpoch: string;
  roomId: string;
  status: 'applied' | 'rejected' | 'unknown';
  selectedMedalId?: string | null;
  displayConfirmed?: boolean;
  wearing: LocalWearingMedal | null;
  updatedAt: number;
  message?: string;
}
