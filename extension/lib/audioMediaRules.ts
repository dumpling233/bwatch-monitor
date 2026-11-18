import { isTrustedPlaybackUrl } from '../../shared/playbackParser';
import { AUDIO_USER_AGENT } from './audioApi';
import { BrokerError } from './broker';

export const AUDIO_RULE_IDS = Array.from({ length: 512 }, (_, index) => 3000 + index);
interface Owner { tabId: number; origin: string; document: string }
interface RuleEntry { id: number; owners: Set<string> }
interface Lease { owner: Owner; keys: string[] }
interface Options { updateRules: (options: chrome.declarativeNetRequest.UpdateRuleOptions) => Promise<void>; id?: () => string }

/** Media never enters the background. Only exact per-tab CDN GET requests receive an app UA. */
export class AudioMediaRules {
  private readonly rules = new Map<string, RuleEntry>();
  private readonly leases = new Map<string, Lease>();
  private serial = Promise.resolve();
  constructor(private readonly options: Options) {}
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.then(operation); this.serial = result.then(() => {}, () => {}); return result;
  }
  async reset(): Promise<void> {
    return this.enqueue(async () => { await this.options.updateRules({ removeRuleIds: AUDIO_RULE_IDS }); this.rules.clear(); this.leases.clear(); });
  }
  async acquire(owner: Owner, urls: string[], signal: AbortSignal): Promise<string> {
    return this.enqueue(async () => {
      if (signal.aborted) throw new DOMException('请求已取消', 'AbortError');
      if (this.leases.size >= 128 || [...this.leases.values()].filter(lease => lease.owner.tabId === owner.tabId).length >= 64)
        throw new BrokerError('RATE_LIMITED', '纯音频资源繁忙', 5);
      const unique = [...new Set(urls)];
      if (!unique.length || unique.length > 4 || unique.some(value => !this.valid(value))) throw new BrokerError('UNAVAILABLE', '纯音频线路暂不可用');
      const leaseId = (this.options.id ?? (() => crypto.randomUUID()))();
      const keys = unique.map(url => `${owner.tabId}:${url}`), used = new Set([...this.rules.values()].map(rule => rule.id));
      const additions: chrome.declarativeNetRequest.Rule[] = [];
      const fresh = new Map<string, RuleEntry>();
      for (let index = 0; index < unique.length; index++) {
        const key = keys[index]; if (this.rules.has(key)) continue;
        const id = AUDIO_RULE_IDS.find(candidate => !used.has(candidate));
        if (id === undefined) throw new BrokerError('RATE_LIMITED', '纯音频资源繁忙', 5);
        used.add(id); fresh.set(key, { id, owners: new Set() });
        additions.push({ id, priority: 30,
          action: { type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType, requestHeaders: [
            { header: 'User-Agent', operation: 'set' as chrome.declarativeNetRequest.HeaderOperation, value: AUDIO_USER_AGENT },
            { header: 'Cookie', operation: 'remove' as chrome.declarativeNetRequest.HeaderOperation },
            { header: 'Referer', operation: 'remove' as chrome.declarativeNetRequest.HeaderOperation },
          ] },
          condition: { tabIds: [owner.tabId], initiatorDomains: [new URL(owner.origin).hostname],
            requestDomains: [new URL(unique[index]).hostname], requestMethods: ['get' as chrome.declarativeNetRequest.RequestMethod],
            resourceTypes: ['xmlhttprequest', 'media'] as chrome.declarativeNetRequest.ResourceType[],
            urlFilter: `|${unique[index]}|`, isUrlFilterCaseSensitive: true } });
      }
      if (additions.length) await this.options.updateRules({ addRules: additions });
      if (signal.aborted) { if (additions.length) await this.options.updateRules({ removeRuleIds: additions.map(rule => rule.id) }); throw new DOMException('请求已取消', 'AbortError'); }
      for (const [key, rule] of fresh) this.rules.set(key, rule);
      for (const key of keys) this.rules.get(key)!.owners.add(leaseId);
      this.leases.set(leaseId, { owner: { ...owner }, keys });
      return leaseId;
    });
  }
  private valid(value: string): boolean {
    if (!isTrustedPlaybackUrl(value) || value.length > 1800 || /[|*^]/.test(value)) return false;
    const url = new URL(value);
    return ['bilivideo.com', 'bilivideo.cn'].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`)) &&
      /\.flv$/i.test(url.pathname) && url.searchParams.get('media_type') === '1';
  }
  async release(owner: Owner, leaseId: unknown): Promise<{ released: true }> {
    if (typeof leaseId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(leaseId)) throw new BrokerError('INVALID_REQUEST', '音频资源编号无效');
    return this.enqueue(async () => {
      const lease = this.leases.get(leaseId);
      if (lease && (lease.owner.tabId !== owner.tabId || lease.owner.origin !== owner.origin || lease.owner.document !== owner.document))
        throw new BrokerError('UNAUTHORIZED', '音频资源不属于当前页面');
      if (lease) await this.remove([leaseId]);
      return { released: true };
    });
  }
  async releaseDocument(owner: Owner): Promise<void> {
    return this.enqueue(() => this.remove([...this.leases].filter(([, lease]) => lease.owner.tabId === owner.tabId && lease.owner.document === owner.document).map(([id]) => id)));
  }
  async releaseTab(tabId: number): Promise<void> {
    return this.enqueue(() => this.remove([...this.leases].filter(([, lease]) => lease.owner.tabId === tabId).map(([id]) => id)));
  }
  private async remove(ids: string[]): Promise<void> {
    const removing = new Set(ids), keys = new Set(ids.flatMap(id => this.leases.get(id)?.keys ?? []));
    const obsolete = [...keys].filter(key => [...this.rules.get(key)!.owners].every(id => removing.has(id)));
    if (obsolete.length) await this.options.updateRules({ removeRuleIds: obsolete.map(key => this.rules.get(key)!.id) });
    for (const id of ids) { const lease = this.leases.get(id); for (const key of lease?.keys ?? []) this.rules.get(key)?.owners.delete(id); this.leases.delete(id); }
    for (const key of obsolete) this.rules.delete(key);
  }
}
