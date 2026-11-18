import { danmakuAssetUrl } from './normalize';

export type DanmakuEmotePreview = { url: string; dynamic: boolean; fallbackUrl?: string; fallbackDynamic?: boolean; staticFallbackUrl?: string };

/** Bounded CDN PNG previews; message animation is admitted separately from still visibility. */
export function emotePreview(value: string | undefined, dynamic = false, animate = false): DanmakuEmotePreview {
  const safe = danmakuAssetUrl(value);
  if (!safe) return { url: '', dynamic: false };
  const url = new URL(safe);
  // Covers can be animated WebP without an is_dynamic field. Static originals
  // also need the size suffix: a small CSS tile does not bound decoded pixels.
  const path = url.pathname.match(/^(\/bfs\/[a-z0-9/_-]+\.(?:gif|webp|png|jpe?g))(?:@([a-z0-9_,!.-]+))?$/i);
  if (path && path[2] !== '96w_96h.png') {
    const moving = dynamic || /\.(?:gif|apng)$/i.test(url.pathname);
    // Unknown WebP originals can animate. Their bounded still is preferred;
    // falling back to the original must still consume an animation slot.
    const fallbackDynamic = moving || /\.webp$/i.test(url.pathname);
    // Match the official size conversion: replace a safe existing transform,
    // so directory and message variants share one still URL and cache entry.
    url.pathname = `${path[1]}@96w_96h.png`;
    if (animate && moving) return { url: safe, dynamic: true, staticFallbackUrl: url.href, fallbackUrl: safe, fallbackDynamic };
    return { url: url.href, dynamic: false, fallbackUrl: safe, fallbackDynamic };
  }
  return { url: safe, dynamic: dynamic || /\.(?:gif|apng|webp)(?:\?|$)/i.test(safe) };
}
