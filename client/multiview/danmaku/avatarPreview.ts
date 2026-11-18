import { danmakuAssetUrl } from './normalize';

/** The CSS avatar is 32px. A static 64px CDN image also covers DPR 2 without
 * keeping an original-sized or animated image decoded for every visible row. */
export function avatarPreview(value: string | undefined): string | undefined {
  const safe = danmakuAssetUrl(value);
  if (!safe) return;
  const url = new URL(safe);
  if (/^\/bfs\/[a-z0-9/_-]+\.(?:gif|webp|png|jpe?g)$/i.test(url.pathname)) {
    url.pathname += '@64w_64h.png';
    return url.href;
  }
  return safe;
}

export function isDanmakuAvatarPreview(value: string): boolean {
  const safe = danmakuAssetUrl(value);
  return Boolean(safe && /^\/bfs\/[a-z0-9/_-]+\.(?:gif|webp|png|jpe?g)@64w_64h\.png$/i.test(new URL(safe).pathname));
}
