import { SITE_ORIGIN, SITE_BASE_PATH } from '../../shared/site';
export type ExtensionBrowser = 'chrome' | 'edge' | 'other';
export type ExtensionPackageBrowser = 'chrome';
export type ExtensionPackage = {
  browser: ExtensionPackageBrowser;
  version: string;
  url: string;
  bytes: number;
  sha256: string;
  variant: 'production' | 'local';
};
export type ExtensionPackages = Partial<Record<ExtensionPackageBrowser, ExtensionPackage>>;

export function distributionBase(origin: string): string | null {
  let location: URL;
  try { location = new URL(origin); } catch { return null; }
  const local = ['127.0.0.1', 'localhost'].includes(location.hostname);
  if (location.username || location.password || location.pathname !== '/' || location.search || location.hash) return null;
  if (local && location.protocol === 'http:') return '/';
  return location.protocol === 'https:' && location.origin === SITE_ORIGIN ? SITE_BASE_PATH : null;
}

export function getExtensionBrowser(userAgent: string): ExtensionBrowser {
  if (/Android|Mobile|iPhone|iPad/.test(userAgent)) return 'other';
  if (/Edg\//.test(userAgent)) return 'edge';
  if (/Chrome\//.test(userAgent) && !/OPR\/|SamsungBrowser\/|Android|Mobile/.test(userAgent)) return 'chrome';
  return 'other';
}

/** Download manifests never control authorization, extension discovery or account
 * reads. A local-only archive must not be offered on the production website. */
export function parseExtensionPackages(value: unknown, origin: string): ExtensionPackages | null {
  if (!distributionBase(origin)) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const manifest = value as Record<string, unknown>;
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.packages) || manifest.packages.length !== 1) return null;
  const packages: ExtensionPackages = {};
  for (const raw of manifest.packages) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    const browser = entry.browser;
    if (browser !== 'chrome') continue;
    if (entry.variant !== 'production' || typeof entry.version !== 'string' ||
      !/^(?:0|[1-9]\d{0,4})(?:\.(?:0|[1-9]\d{0,4})){2,3}$/.test(entry.version) ||
      entry.version.split('.').some(part => Number(part) > 65535) ||
      typeof entry.bytes !== 'number' || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 || entry.bytes > 5 * 1024 * 1024 ||
      typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      entry.url !== `downloads/bwatch-monitor-extension-${entry.version}.zip`) continue;
    if (packages[browser]) return null;
    packages[browser] = { browser, version: entry.version, url: entry.url, bytes: entry.bytes, sha256: entry.sha256, variant: 'production' };
  }
  return Object.keys(packages).length ? packages : null;
}

/** Legacy manifests contain Chromium packages only; never reuse one in Firefox. */
export function parseExtensionPackage(value: unknown, origin: string, browser: ExtensionPackageBrowser = 'chrome'): ExtensionPackage | null {
  return parseExtensionPackages(value, origin)?.[browser] ?? null;
}

export interface ExtensionPackagesCheck {
  packages: ExtensionPackages | null;
  /** Last successful check; a failed refresh must not advance this timestamp. */
  checkedAt: number | null;
  error: string;
  stale: boolean;
}

const CHECK_TTL_MS = 6 * 60 * 60_000;
const FAILURE_REUSE_MS = 60_000;
const MAX_MANIFEST_BYTES = 4096;
const cancelled = () => new DOMException('已停止检查浏览器扩展更新', 'AbortError');
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? cancelled());
    signal.addEventListener('abort', abort, { once: true });
    const cleanup = () => signal.removeEventListener('abort', abort);
    operation.then(value => { cleanup(); if (signal.aborted) abort(); else resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) { cleanup(); abort(); }
  });
}
const EMPTY_CHECK: ExtensionPackagesCheck = { packages: null, checkedAt: null, error: '', stale: false };
type CacheEntry = { value: ExtensionPackagesCheck; attemptedAt: number };
type PendingCheck = { controller: AbortController; consumers: Set<symbol>; promise: Promise<ExtensionPackagesCheck> };

/** One small same-origin manifest per page, shared by settings and installation
 * help. A consumer's cancellation must not cancel another visible consumer. */
export class ExtensionPackagesCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly pending = new Map<string, PendingCheck>();
  constructor(private readonly options: { now?: () => number; fetch?: typeof fetch; timeoutMs?: number } = {}) {}
  private now = () => this.options.now?.() ?? Date.now();
  getSnapshot(origin: string): ExtensionPackagesCheck {
    const value = this.entries.get(origin)?.value ?? EMPTY_CHECK;
    return value.checkedAt !== null && this.now() - value.checkedAt >= CHECK_TTL_MS ? { ...value, stale: true } : value;
  }
  private remember(origin: string, value: ExtensionPackagesCheck) {
    this.entries.delete(origin);
    this.entries.set(origin, { value, attemptedAt: this.now() });
    // Production and a few development origins suffice; no unbounded origin map.
    while (this.entries.size > 4) this.entries.delete(this.entries.keys().next().value!);
  }
  private async fetchManifest(origin: string, signal: AbortSignal): Promise<ExtensionPackages> {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(this.options.timeoutMs ?? 5000)]);
    const response = await abortable((this.options.fetch ?? fetch)(new URL(`${distributionBase(origin)}downloads/bwatch-monitor-extension.json`, origin).href, {
      signal: deadline, credentials: 'omit', cache: 'no-cache', redirect: 'error'
    }), deadline);
    if (!response.ok || Number(response.headers.get('content-length')) > MAX_MANIFEST_BYTES) {
      void response.body?.cancel().catch(() => {}); throw new Error('manifest');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('manifest');
    const decoder = new TextDecoder();
    let bytes = 0, source = '';
    try {
      while (true) {
        if (deadline.aborted) throw deadline.reason ?? cancelled();
        const part = await abortable(reader.read(), deadline);
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > MAX_MANIFEST_BYTES) throw new Error('manifest');
        source += decoder.decode(part.value, { stream: true });
      }
      source += decoder.decode();
    } finally { void reader.cancel().catch(() => {}); }
    if (deadline.aborted) throw deadline.reason ?? cancelled();
    const packages = parseExtensionPackages(JSON.parse(source), origin);
    if (!packages) throw new Error('manifest');
    return packages;
  }
  load(origin: string, signal: AbortSignal, force = false): Promise<ExtensionPackagesCheck> {
    if (signal.aborted) return Promise.reject(cancelled());
    if (!distributionBase(origin)) return Promise.resolve({ ...EMPTY_CHECK, error: '当前页面暂不支持读取扩展更新信息', stale: true });
    const cached = this.entries.get(origin);
    let pending = this.pending.get(origin);
    if (!pending && !force && cached && ((!cached.value.error && cached.value.checkedAt !== null && this.now() - cached.value.checkedAt < CHECK_TTL_MS) ||
      this.now() - cached.attemptedAt < FAILURE_REUSE_MS)) return Promise.resolve(this.getSnapshot(origin));
    if (!pending) {
      const controller = new AbortController();
      const entry: PendingCheck = { controller, consumers: new Set(), promise: Promise.resolve(EMPTY_CHECK) };
      entry.promise = this.fetchManifest(origin, controller.signal).then(packages => {
        if (controller.signal.aborted || this.pending.get(origin) !== entry) throw cancelled();
        const value = { packages, checkedAt: this.now(), error: '', stale: false };
        this.remember(origin, value); return value;
      }).catch(() => {
        if (controller.signal.aborted || this.pending.get(origin) !== entry) throw cancelled();
        const previous = this.entries.get(origin)?.value;
        const value = { packages: previous?.packages ?? null, checkedAt: previous?.checkedAt ?? null,
          error: '暂时无法检查更新，请稍后重试', stale: true };
        this.remember(origin, value); return value;
      }).finally(() => { if (this.pending.get(origin) === entry) this.pending.delete(origin); });
      this.pending.set(origin, entry); pending = entry;
    }
    const task = pending, consumer = Symbol(); task.consumers.add(consumer);
    return new Promise((resolve, reject) => {
      const detach = () => { task.consumers.delete(consumer); signal.removeEventListener('abort', abort); };
      const abort = () => {
        detach(); reject(cancelled());
        if (!task.consumers.size && this.pending.get(origin) === task) { this.pending.delete(origin); task.controller.abort(); }
      };
      signal.addEventListener('abort', abort, { once: true });
      task.promise.then(value => { detach(); if (signal.aborted) reject(cancelled()); else resolve(value); }, error => { detach(); reject(error); });
      if (signal.aborted) abort();
    });
  }
}

export const extensionPackagesCache = new ExtensionPackagesCache();

export function checkExtensionPackages(signal: AbortSignal, force = false): Promise<ExtensionPackagesCheck> {
  return extensionPackagesCache.load(window.location.origin, signal, force);
}

/** Legacy installation help shares the same cache and in-flight request. */
export async function loadExtensionPackages(signal: AbortSignal): Promise<ExtensionPackages | null> {
  try { return (await checkExtensionPackages(signal)).packages; } catch { return null; }
}
