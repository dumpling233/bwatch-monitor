export type ExtensionInstallationType = 'development' | 'normal' | 'sideload' | 'other' | 'unknown';

/** The browser's own installation classification is not proof of a particular store. */
export function normalizeInstallationType(value: unknown): ExtensionInstallationType {
  if (value === 'development' || value === 'normal' || value === 'sideload') return value;
  return value === 'admin' || value === 'other' ? 'other' : 'unknown';
}

/** One lazy, bounded getSelf read per background lifetime, including unavailable results. */
export function createInstallationTypeReader(getSelf: () => Promise<unknown>, timeoutMs = 1500): () => Promise<ExtensionInstallationType> {
  let result: Promise<ExtensionInstallationType> | undefined;
  return () => result ??= new Promise(resolve => {
    let settled = false;
    const finish = (value: ExtensionInstallationType) => {
      if (settled) return;
      settled = true; clearTimeout(timer); resolve(value);
    };
    const timer = setTimeout(() => finish('unknown'), timeoutMs);
    void Promise.resolve().then(getSelf).then(value => {
      const info = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
      finish(normalizeInstallationType(info.installType));
    }, () => finish('unknown')).catch(() => finish('unknown'));
  });
}
