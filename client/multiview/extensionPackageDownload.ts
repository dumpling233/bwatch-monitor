import { distributionBase, type ExtensionPackage } from './extensionDistribution';

const MAX_ARCHIVE_BYTES = 5 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30_000;

function checkedPackage(value: ExtensionPackage, origin: string): { item: ExtensionPackage; url: string } {
  const location = new URL(origin);
  const base = distributionBase(origin);
  if (!base) throw new Error('当前页面不支持下载安装包');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('安装包信息无效，请刷新本页重试');
  // Keep this attempt bound to the descriptor that the guide confirmed, even
  // when a later metadata check discovers a different release.
  const item = { ...value };
  if (item.browser !== 'chrome' || item.variant !== 'production'
    || typeof item.version !== 'string' || item.version !== item.version.trim()
    || !/^(?:0|[1-9]\d{0,4})(?:\.(?:0|[1-9]\d{0,4})){2,3}$/.test(item.version)
    || item.version.split('.').some(part => Number(part) > 65535)
    || !Number.isSafeInteger(item.bytes) || item.bytes <= 0 || item.bytes > MAX_ARCHIVE_BYTES
    || typeof item.sha256 !== 'string' || item.sha256.length !== 64 || !/^[a-f0-9]{64}$/.test(item.sha256)
    || item.url !== `downloads/bwatch-monitor-extension-${item.version}.zip`)
    throw new Error('安装包信息无效，请刷新本页重试');
  return { item, url: new URL(base + item.url, location.origin).href };
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => { cleanup(); reject(signal.reason ?? new DOMException('已停止下载安装包', 'AbortError')); };
    signal.addEventListener('abort', abort, { once: true });
    operation.then(value => {
      cleanup();
      if (signal.aborted) abort(); else resolve(value);
    }, error => { cleanup(); reject(error); });
    if (signal.aborted) abort();
  });
}

/** Fetch and verify the confirmed archive. Returning a Blob does not assert
 * that a browser saved it, installed it, or connected a newer extension. */
export async function fetchExtensionPackageBlob(descriptor: ExtensionPackage, signal: AbortSignal,
  options: { fetch?: typeof fetch; timeoutMs?: number; origin?: string } = {}): Promise<Blob> {
  signal.throwIfAborted();
  const { item, url } = checkedPackage(descriptor, options.origin ?? window.location.origin);
  const timeoutMs = options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > DOWNLOAD_TIMEOUT_MS)
    throw new Error('安装包下载超时设置无效');
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason ?? new DOMException('已停止下载安装包', 'AbortError'));
  signal.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException('安装包下载超时，请重试', 'TimeoutError')), timeoutMs);
  const deadline = controller.signal;
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    if (signal.aborted) cancel();
    deadline.throwIfAborted();
    const downloaded = await abortable<Response>((options.fetch ?? fetch)(url, {
      signal: deadline, credentials: 'omit', redirect: 'error', cache: 'no-cache'
    }).then(result => {
      response = result;
      // A custom fetch implementation may finish after cancellation. Do not
      // leave that late response streaming after the caller has moved on.
      if (deadline.aborted) {
        void result.body?.cancel().catch(() => {});
        deadline.throwIfAborted();
      }
      return result;
    }), deadline);
    if (!downloaded.ok || downloaded.redirected) throw new Error('安装包暂不可用，请刷新本页重试');
    if (/^(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/i.test(downloaded.headers.get('content-type') ?? ''))
      throw new Error('返回内容不是安装包，请刷新本页重试');
    const contentLength = downloaded.headers.get('content-length');
    if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) !== item.bytes
      || Number(contentLength) > MAX_ARCHIVE_BYTES)) throw new Error('安装包大小校验失败，请刷新本页重试');
    reader = downloaded.body?.getReader();
    if (!reader) throw new Error('安装包正文不可用，请重试');
    const archive = new Uint8Array(item.bytes);
    let bytes = 0;
    while (true) {
      deadline.throwIfAborted();
      const part = await abortable(reader.read(), deadline);
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > item.bytes || bytes > MAX_ARCHIVE_BYTES) throw new Error('安装包大小校验失败，请刷新本页重试');
      archive.set(part.value, bytes - part.value.byteLength);
    }
    if (bytes !== item.bytes) throw new Error('安装包大小校验失败，请刷新本页重试');
    const digest = await abortable(crypto.subtle.digest('SHA-256', archive), deadline);
    const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    if (sha256 !== item.sha256) throw new Error('安装包 SHA-256 校验失败，请刷新本页重试');
    deadline.throwIfAborted();
    return new Blob([archive], { type: 'application/zip' });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
    if (reader) void reader.cancel().catch(() => {});
    else void response?.body?.cancel().catch(() => {});
  }
}
