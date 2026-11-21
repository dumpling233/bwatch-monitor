/** Deployment contract for the static app and companion extension. */
export const SITE_ORIGIN = 'https://dumpling233.github.io';
export const SITE_BASE_PATH = '/bwatch-monitor/';
export const MONITOR_URL = `${SITE_ORIGIN}${SITE_BASE_PATH}`;
export const MONITOR_MATCH_PATTERN = `${MONITOR_URL}*`;
export const LOCAL_MONITOR_URLS = ['http://localhost:5173/', 'http://127.0.0.1:5173/'] as const;
export const PROJECT_VERSION = '0.3.0';
export const PROJECT_NAME = 'BWatch Monitor';
export function isAllowedMonitorPage(value: unknown, local = false): boolean {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    const page = `${url.origin}${url.pathname}`;
    return page === MONITOR_URL || page === MONITOR_URL.slice(0, -1)
      || local && LOCAL_MONITOR_URLS.some(candidate => page === candidate);
  } catch { return false; }
}
export function siteAssetPath(path: string, base = SITE_BASE_PATH): string {
  return `${base}${path.replace(/^\/+/, '')}`;
}
export function siteAssetUrl(path: string, origin = SITE_ORIGIN): string {
  return new URL(siteAssetPath(path), origin).href;
}
