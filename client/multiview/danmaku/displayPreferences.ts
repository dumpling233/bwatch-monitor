export const danmakuFonts = [
  { value: 'SimHei', label: '黑体' },
  { value: 'SimSun', label: '宋体' },
  { value: 'NSimSun', label: '新宋体' },
  { value: 'FangSong', label: '仿宋' },
  { value: 'Microsoft YaHei', label: '微软雅黑' },
  { value: 'Microsoft YaHei Light', label: '微软雅黑 Light' },
  { value: 'Noto Sans CJK SC DemiLight', label: 'Noto Sans DemiLight' },
  { value: 'Noto Sans CJK SC Regular', label: 'Noto Sans Regular' },
] as const;
export type DanmakuFontFamily = typeof danmakuFonts[number]['value'];
export const danmakuTextEffects = [
  { value: 'heavy', label: '重墨' }, { value: 'stroke', label: '描边' },
  { value: 'projection', label: '45°投影' }, { value: 'none', label: '无效果' },
] as const;
export type DanmakuTextEffect = typeof danmakuTextEffects[number]['value'];

export interface DanmakuStyle {
  fontSize: number;
  fixedFontSize: boolean;
  fontFamily: DanmakuFontFamily;
  bold: boolean;
  textEffect: DanmakuTextEffect;
  area: number;
  opacity: number;
  speed: number;
  blockedWords: string[];
}
export interface RoomDanmakuPreference { enabled: boolean; style?: DanmakuStyle }
export interface DanmakuPreferences { defaults: DanmakuStyle; rooms: Record<string, RoomDanmakuPreference>; autoWearRoomMedal?: boolean }

export const defaultDanmakuStyle = (): DanmakuStyle => ({ fontSize: 28, fixedFontSize: false, fontFamily: 'SimHei', bold: true, textEffect: 'heavy', area: 0.5, opacity: 0.8, speed: 1, blockedWords: [] });
export const defaultDanmakuPreferences = (): DanmakuPreferences => ({ defaults: defaultDanmakuStyle(), rooms: {}, autoWearRoomMedal: false });
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const bounded = (value: unknown, fallback: number, min: number, max: number) => typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;

export function validateDanmakuStyle(value: unknown): DanmakuStyle {
  const defaults = defaultDanmakuStyle(), source = record(value) ? value : {};
  return {
    fontSize: bounded(source.fontSize, defaults.fontSize, 12, 56),
    fixedFontSize: source.fixedFontSize === true,
    fontFamily: danmakuFonts.some(font => font.value === source.fontFamily) ? source.fontFamily as DanmakuFontFamily : defaults.fontFamily,
    bold: typeof source.bold === 'boolean' ? source.bold : defaults.bold,
    textEffect: danmakuTextEffects.some(effect => effect.value === source.textEffect) ? source.textEffect as DanmakuTextEffect
      : source.textEffect === undefined && typeof source.outline === 'number' && Number.isFinite(source.outline) ? (source.outline > 0 ? 'stroke' : 'none') : defaults.textEffect,
    area: bounded(source.area, defaults.area, 0.25, 1),
    opacity: bounded(source.opacity, defaults.opacity, 0.1, 1),
    speed: bounded(source.speed, defaults.speed, 0.5, 2),
    blockedWords: Array.isArray(source.blockedWords) ? [...new Set(source.blockedWords.filter((word): word is string => typeof word === 'string').map(word => word.trim().slice(0, 64)).filter(Boolean))].slice(0, 100) : [],
  };
}

export function validateDanmakuPreferences(value: unknown, roomIds: readonly string[]): DanmakuPreferences {
  const source = record(value) ? value : {}, rooms: Record<string, RoomDanmakuPreference> = {};
  for (const id of roomIds) {
    const room = record(source.rooms) && record(source.rooms[id]) ? source.rooms[id] : {};
    rooms[id] = { enabled: room.enabled === true, ...(record(room.style) ? { style: validateDanmakuStyle(room.style) } : {}) };
  }
  return { defaults: validateDanmakuStyle(source.defaults), rooms, autoWearRoomMedal: source.autoWearRoomMedal === true };
}

export const roomDanmakuStyle = (preferences: DanmakuPreferences, roomId: string): DanmakuStyle => preferences.rooms[roomId]?.style ?? preferences.defaults;
export const isDanmakuBlocked = (text: string, style: DanmakuStyle): boolean => {
  const normalized = text.toLocaleLowerCase();
  return style.blockedWords.some(word => word.trim() && normalized.includes(word.trim().toLocaleLowerCase()));
};
