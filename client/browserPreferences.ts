

/** Stored JSON is untrusted, even when the TypeScript caller expects T. */
function compatibleValue<T>(value: unknown, fallback: T): value is T {
  if (Array.isArray(fallback) || fallback === null) {
    return (fallback === null && value === null) || (Array.isArray(value) && value.every(item => typeof item === 'string'));
  }
  return typeof value === typeof fallback && (typeof value !== 'number' || Number.isFinite(value));
}

export function readBrowserPreference<T>(key: string, fallback: T, storage?: Storage): T {
  try {
    const raw = (storage ?? globalThis.localStorage).getItem(key);
    if (raw === null) return fallback;
    const value: unknown = JSON.parse(raw);
    return compatibleValue(value, fallback) ? value : fallback;
  } catch { return fallback; }
}

/** Preferences are best effort; an unavailable disk must not break the UI. */
export function writeBrowserPreference<T>(key: string, value: T, storage?: Storage): boolean {
  try {
    const target = storage ?? globalThis.localStorage;
    const raw = JSON.stringify(value);
    try { target.setItem(key, raw); }
    catch (error) {
      if (!(error instanceof Error) || !['QuotaExceededError', 'NS_ERROR_DOM_QUOTA_REACHED'].includes(error.name)) return false;
      // Only replaceable chart data may be evicted. Never clear user storage.
      return false;

    }
    return true;
  } catch { return false; }
}
