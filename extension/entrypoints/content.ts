import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { allowedPage } from '../lib/origins';
import { LOCAL_LOGIN_CHANNEL } from '../../shared/localLogin';
import { MONITOR_BRIDGE_PING, mountContentBridge, type BridgeRegistry } from '../lib/contentBridge';
import { MONITOR_MATCH_PATTERN } from '../../shared/site';

export default defineContentScript({
  matches: [MONITOR_MATCH_PATTERN, 'http://127.0.0.1/*', 'http://localhost/*'],
  allFrames: false,
  runAt: 'document_start',
  main(ctx) {
    if (window.top !== window || !allowedPage(location.href)) return;
    const host = window as Window & { __bwatchMonitorBridge?: BridgeRegistry };
    const registry = host.__bwatchMonitorBridge ??= {};
    mountContentBridge({
      registry, version: browser.runtime.getManifest().version, id: () => crypto.randomUUID(),
      allowed: () => window.top === window && allowedPage(location.href),
      post: message => window.postMessage(message, location.origin),
      connect: () => browser.runtime.connect({ name: LOCAL_LOGIN_CHANNEL }),
      consumeLastError: () => { void browser.runtime.lastError; },
      onMessage: listener => {
        const onMessage = (event: MessageEvent) => { if (event.source === window && event.origin === location.origin) listener(event.data); };
        window.addEventListener('message', onMessage);
        return () => window.removeEventListener('message', onMessage);
      },
      onPageHide: listener => { window.addEventListener('pagehide', listener); return () => window.removeEventListener('pagehide', listener); },
      onPing: listener => {
        const onMessage: Parameters<typeof browser.runtime.onMessage.addListener>[0] = (message, sender, respond) => {
          if (sender.id !== browser.runtime.id || sender.tab || message?.internal !== MONITOR_BRIDGE_PING) return;
          const result = listener();
          if (result) respond(result);
        };
        browser.runtime.onMessage.addListener(onMessage);
        return () => browser.runtime.onMessage.removeListener(onMessage);
      },
      onInvalidated: listener => ctx.onInvalidated(listener)
    });
  }
});
