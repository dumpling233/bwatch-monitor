import type { LocalChatApproval, LocalLoginSession } from '../../shared/localLogin';
import { BrokerError } from './broker';

type Binding = { tabId: number; origin: string; documentUrl: string; requestId?: string };
type Entry = Binding & LocalChatApproval & { uid: string; name: string; revision: number; authEpoch: string;
  requestIds: Set<string>; windowId?: number; confirming: boolean; controller: AbortController; timer: ReturnType<typeof setTimeout> };
interface Options {
  session(origin: string, signal?: AbortSignal, force?: boolean): Promise<LocalLoginSession>;
  enable(origin: string, binding: { uid?: string; revision: number; authEpoch?: string }, signal: AbortSignal,
    current?: () => Promise<boolean>): Promise<LocalLoginSession>;
  currentPage(tabId: number): Promise<string | undefined>;
  open(approvalId: string): Promise<number | undefined>;
  close(windowId: number): Promise<void>;
  now?: () => number;
}
const idValid = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id);
const denied = () => new BrokerError('INVALID_REQUEST', '本次确认已失效，请返回 monitor 重新开启');

/** Ephemeral confirmation for complete local authorization, bound to a document and known account. */
export class ChatApprovals {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly options: Options) {}
  private get now(): number { return (this.options.now ?? Date.now)(); }
  private project(entry: Entry): LocalChatApproval {
    return { approvalId: entry.approvalId, status: entry.status, expiresAt: entry.expiresAt };
  }
  private rememberRequest(entry: Entry, requestId?: string): void {
    if (!requestId) return;
    entry.requestIds.add(requestId);
    while (entry.requestIds.size > 16) entry.requestIds.delete(entry.requestIds.values().next().value!);
  }
  private finish(entry: Entry, status: LocalChatApproval['status'], closeWindow = true): void {
    if (entry.status !== 'pending') return;
    entry.status = status; clearTimeout(entry.timer);
    if (status !== 'approved') entry.controller.abort();
    if (closeWindow && entry.windowId !== undefined) void this.options.close(entry.windowId).catch(() => {});
  }
  private async valid(entry: Entry): Promise<boolean> {
    if (entry.status !== 'pending') return false;
    if (this.now >= entry.expiresAt) { this.finish(entry, 'expired'); return false; }
    if (await this.options.currentPage(entry.tabId).catch(() => undefined) !== entry.documentUrl) {
      this.finish(entry, 'invalidated'); return false;
    }
    return entry.status === 'pending';
  }
  async request(binding: Binding, signal?: AbortSignal): Promise<LocalChatApproval> {
    // One pending prompt per initiating tab; repeated web clicks cannot create a window storm.
    const existing = [...this.entries.values()].find(item => item.tabId === binding.tabId && item.origin === binding.origin && item.status === 'pending');
    if (existing) {
      this.rememberRequest(existing, binding.requestId);
      if (await this.valid(existing)) return this.project(existing);
    }
    const session = await this.options.session(binding.origin, signal, true);
    if (signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
    if (await this.options.currentPage(binding.tabId) !== binding.documentUrl) throw denied();
    for (const [id, entry] of this.entries) if (entry.status !== 'pending' && this.now - entry.expiresAt > 120_000) this.entries.delete(id);
    while (this.entries.size >= 8) {
      const terminal = [...this.entries].find(([, entry]) => entry.status !== 'pending');
      if (!terminal) throw new BrokerError('RATE_LIMITED', '待确认操作过多，请先完成或取消现有确认', 2);
      this.entries.delete(terminal[0]);
    }
    // A second request may have completed its account check concurrently.
    const concurrent = [...this.entries.values()].find(item => item.tabId === binding.tabId && item.status === 'pending');
    if (concurrent) { this.rememberRequest(concurrent, binding.requestId); return this.project(concurrent); }
    const approvalId = crypto.randomUUID(), expiresAt = this.now + 120_000;
    const knownAccount = session.account?.state === 'logged-in' ? session.account : undefined;
    const entry: Entry = { ...binding, approvalId, expiresAt, status: 'pending', uid: knownAccount?.uid ?? '', name: knownAccount?.name ?? '',
      authEpoch: knownAccount?.authEpoch ?? '', revision: session.preferences.revision, requestIds: new Set(), confirming: false, controller: new AbortController(),
      timer: setTimeout(() => { this.finish(entry, 'expired'); }, 120_000) };
    entry.timer.unref?.();
    this.rememberRequest(entry, binding.requestId);
    this.entries.set(approvalId, entry);
    const cancelOpening = () => this.finish(entry, 'cancelled');
    signal?.addEventListener('abort', cancelOpening, { once: true });
    if (signal?.aborted) cancelOpening();
    try {
      if (entry.status !== 'pending') return this.project(entry);
      entry.windowId = await this.options.open(approvalId);
      if (entry.status !== 'pending' && entry.windowId !== undefined) await this.options.close(entry.windowId).catch(() => {});
    } catch { this.finish(entry, 'invalidated'); throw new BrokerError('UNAVAILABLE', '无法打开扩展确认窗口，请重试'); }
    finally { signal?.removeEventListener('abort', cancelOpening); }
    return this.project(entry);
  }
  async result(binding: Binding, id: unknown): Promise<LocalChatApproval> {
    if (!idValid(id)) throw denied();
    const entry = this.entries.get(id);
    // A worker restart loses pending requests; it must never reconstruct or replay consent.
    if (!entry) return { approvalId: id, status: 'invalidated', expiresAt: this.now };
    if (entry.tabId !== binding.tabId || entry.origin !== binding.origin || entry.documentUrl !== binding.documentUrl) throw denied();
    await this.valid(entry);
    return this.project(entry);
  }
  async cancel(binding: Binding, id: unknown): Promise<LocalChatApproval> {
    const result = await this.result(binding, id);
    const entry = this.entries.get(result.approvalId);
    if (entry && !entry.confirming) this.finish(entry, 'cancelled');
    return entry ? this.project(entry) : result;
  }
  cancelRequest(binding: Binding, requestId: string): void {
    for (const entry of this.entries.values()) if (entry.tabId === binding.tabId && entry.origin === binding.origin &&
      entry.documentUrl === binding.documentUrl && entry.requestIds.has(requestId) && !entry.confirming) this.finish(entry, 'cancelled');
  }
  async view(id: unknown): Promise<LocalChatApproval & { origin: string; name: string; uid: string }> {
    if (!idValid(id)) throw denied();
    const entry = this.entries.get(id);
    if (!entry || !await this.valid(entry)) throw denied();
    return { ...this.project(entry), origin: entry.origin, name: entry.name || '将验证当前浏览器的 B站账号', uid: entry.uid };
  }
  async decide(id: unknown, allow: boolean): Promise<LocalChatApproval> {
    if (!idValid(id)) throw denied();
    const entry = this.entries.get(id);
    if (!entry || !await this.valid(entry)) throw denied();
    if (!allow) { if (!entry.confirming) this.finish(entry, 'cancelled'); return this.project(entry); }
    if (entry.confirming) return this.project(entry);
    entry.confirming = true;
    try {
      // Both this read and the CAS enable verify the bound UID, revision and authentication epoch.
      const session = await this.options.session(entry.origin, entry.controller.signal, true);
      if (!await this.valid(entry) || session.preferences.revision !== entry.revision ||
        (entry.uid && (session.account?.state !== 'logged-in' || session.account.uid !== entry.uid || session.account.authEpoch !== entry.authEpoch))) throw denied();
      await this.options.enable(entry.origin, { revision: entry.revision,
        ...(entry.uid ? { uid: entry.uid, authEpoch: entry.authEpoch } : {}) }, entry.controller.signal, () => this.valid(entry));
      if (entry.status === 'pending') this.finish(entry, 'approved');
    } catch (failure) {
      // A verified refusal needs a readable extension-owned explanation (e.g. sign in first).
      // The web task is terminal and cannot retry or transfer this confirmation.
      this.finish(entry, 'invalidated', false); throw failure;
    }
    return this.project(entry);
  }
  invalidateOrigin(origin: string, force = false): void {
    for (const entry of this.entries.values()) if (entry.origin === origin && (force || !entry.confirming)) this.finish(entry, 'invalidated');
  }
  invalidateTab(tabId: number): void {
    for (const entry of this.entries.values()) if (entry.tabId === tabId) this.finish(entry, 'invalidated');
  }
  invalidateAll(): void { for (const entry of this.entries.values()) this.finish(entry, 'invalidated'); }
  windowClosed(windowId: number): void {
    for (const entry of this.entries.values()) if (entry.windowId === windowId && !entry.confirming) this.finish(entry, 'cancelled');
  }
}
