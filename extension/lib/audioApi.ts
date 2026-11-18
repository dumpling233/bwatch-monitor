/** Fixed anonymous app endpoint; these are client identifiers, never account credentials. */
export const AUDIO_API = 'https://api.live.bilibili.com/xlive/app-room/v2/index/getRoomPlayInfo';
export const AUDIO_USER_AGENT = 'Bilibili Freedoooooom/MarkII BiliDroid/5.49.0 os/android model/MuMu mobi_app/android build/5490400 channel/dw090 innerVer/5490400 osVer/6.0.1 network/2';
const FIXED = {
  appkey: 'iVGUTjsxvpLeuDCf', build: '6250300', c_locale: 'zh_CN', channel: 'bili',
  codec: '0', device: 'android', device_name: 'MuMu', dolby: '0', format: '0,2',
  free_type: '0', http: '1', mask: '0', media_type: '1', mobi_app: 'android', network: 'wifi',
  no_playurl: '0', only_audio: '1', only_video: '0', platform: 'android', play_type: '0',
  protocol: '0,1', qn: '150', s_locale: 'zh_CN',
  statistics: '{"appId":1,"platform":3,"version":"6.25.0","abtest":""}',
};
export const validAudioRoom = (room: unknown): room is string => typeof room === 'string' && /^[1-9][0-9]{0,19}$/.test(room);
export function audioApiUrl(roomId: string, now: number): URL {
  const url = new URL(AUDIO_API);
  url.search = new URLSearchParams({ ...FIXED, room_id: roomId, ts: String(Math.floor(now / 1000)) }).toString();
  return url;
}
export function isAudioApiUrl(url: URL): boolean {
  if (url.origin + url.pathname !== AUDIO_API || !validAudioRoom(url.searchParams.get('room_id'))) return false;
  const keys = [...url.searchParams.keys()];
  return keys.length === Object.keys(FIXED).length + 2 && new Set(keys).size === keys.length &&
    Object.entries(FIXED).every(([key, value]) => url.searchParams.get(key) === value) &&
    /^[0-9]{1,12}$/.test(url.searchParams.get('ts') ?? '');
}
