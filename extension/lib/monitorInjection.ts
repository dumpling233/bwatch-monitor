import { allowedPage } from './origins';
import { supportedPageContext } from './browserCompatibility';
import { MONITOR_MATCH_PATTERN } from '../../shared/site';

type MonitorTab = { id?: number; url?: string; incognito?: boolean; cookieStoreId?: string };
interface InjectionOptions<File extends string> {
  firefox: boolean;
  local: boolean;
  tabs(): Promise<MonitorTab[]>;
  permitted(origins: string[]): Promise<boolean>;
  files(): File[];
  version: string;
  ping(tabId: number): Promise<unknown>;
  inject(tabId: number, files: File[]): Promise<unknown>;
}

/** Event-driven only: existing host grants never imply account authorization. */
export function createMonitorInjector<File extends string>(options: InjectionOptions<File>): (permissionsChanged?: boolean) => Promise<void> {
  let pending: Promise<void> | undefined;
  let rescan = false;
  const scan = async () => {
      const files = options.files();
      if (!files.length) return;
      const tabs = await options.tabs();
      for (const tab of tabs) {
        if (tab.id === undefined || !allowedPage(tab.url, options.local) || supportedPageContext(tab, options.firefox)) continue;
        const url = new URL(tab.url!);
        // Match patterns have host scope; allowedPage independently checks exact ports/path.
        if (!await options.permitted([`${url.protocol}//${url.hostname}/*`])) continue;
        // WXT invalidates earlier contexts before main(), so do not execute a
        // healthy same-version bundle merely to reach its in-main singleton guard.
        try {
          const reply = await options.ping(tab.id) as { extensionVersion?: unknown; bridgeId?: unknown } | undefined;
          if (reply?.extensionVersion === options.version && typeof reply.bridgeId === 'string') continue;
        } catch { /* No bridge, an outdated one, or an invalidated extension world. */ }
        try { await options.inject(tab.id, files); } catch { /* Closed/navigated/host access changed. Next explicit event can retry. */ }
      }
  };
  return (permissionsChanged = false) => {
    if (pending) { if (permissionsChanged) rescan = true; return pending; }
    const work = (async () => {
      do { rescan = false; await scan(); } while (rescan);
    })();
    pending = work;
    void work.finally(() => { if (pending === work) pending = undefined; }).catch(() => {});
    return work;
  };
}

/** Read the generated manifest so Firefox and Chromium inject the same built entrypoint. */
export function monitorContentFiles(manifest: { content_scripts?: Array<{ matches?: string[]; js?: string[] }> }): Array<'/content-scripts/content.js'> {
  const files = (manifest.content_scripts ?? [])
    .filter(script => script.matches?.some(match => match === MONITOR_MATCH_PATTERN))
    .flatMap(script => script.js ?? []);
  // WXT's generated ScriptPublicPath requires a root-relative public path.
  // Only the manifest-confirmed, fixed monitor bundle may be executed.
  return files.includes('content-scripts/content.js') ? ['/content-scripts/content.js'] : [];
}
