import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { LocalLoginBroker, BrokerError } from '../lib/broker';
import { LoginSessions } from '../lib/loginSessions';
import { allowedPage } from '../lib/origins';
import { accountEventNotifier } from '../lib/accountEvents';
import { LocalCookieTransport } from '../lib/cookieTransport';
import { LocalAudioPlayback } from '../lib/audioPlayback';
import { LocalPublicRooms } from '../lib/publicRooms';
import { SITE_ORIGIN, SITE_BASE_PATH, MONITOR_URL, MONITOR_MATCH_PATTERN } from '../../shared/site';
import { AudioMediaRules } from '../lib/audioMediaRules';
import { CredentialCookieEvents } from '../lib/credentialEvents';
import { LocalDanmakuService } from '../lib/danmaku';
import { LocalFollowingService } from '../lib/following';
import { LocalMedalService } from '../lib/medals';
import { ChatApprovals } from '../lib/chatApprovals';
import { LOCAL_BUILD } from '../lib/origins';
import { audioBrowserPermissions, audioOnlyPermissionRemoval, danmakuWebsocketRegex, FIREFOX_DEFAULT_STORE, isFirefoxRuntime, localCookieQuery, requiredBrowserPermissions, supportedPageContext, unpartitionedCookie } from '../lib/browserCompatibility';
import { LOCAL_LOGIN_CHANNEL, type LocalLoginRequest, type LocalLoginResponse } from '../../shared/localLogin';
import { LOCAL_LOGIN_EXTENSION_NAME } from '../../shared/extensionBrand';
import { createMonitorInjector, monitorContentFiles } from '../lib/monitorInjection';
import { MONITOR_BRIDGE_PING } from '../lib/contentBridge';
import { createInstallationTypeReader } from '../lib/installationType';

export default defineBackground({ persistent: { firefox: false }, main() {
  const runtimeUrl = browser.runtime.getURL('/');
  const firefox = isFirefoxRuntime(runtimeUrl);
  const installationType = createInstallationTypeReader(() => browser.management.getSelf());
  const injectMonitor = createMonitorInjector({ firefox, local: LOCAL_BUILD,
    version: browser.runtime.getManifest().version,
    ping: tabId => browser.tabs.sendMessage(tabId, { internal: MONITOR_BRIDGE_PING }, { frameId: 0 }),
    tabs: () => browser.tabs.query({ url: [MONITOR_MATCH_PATTERN, ...(LOCAL_BUILD ? ['http://127.0.0.1/*', 'http://localhost/*'] : [])] }),
    permitted: origins => browser.permissions.contains({ origins }),
    files: () => monitorContentFiles(browser.runtime.getManifest()),
    inject: (tabId, files) => browser.scripting.executeScript({ target: { tabId, frameIds: [0] }, files })
  });
  browser.runtime.onInstalled.addListener(details => { if (details.reason === 'install' || details.reason === 'update') void injectMonitor().catch(() => {}); });
  browser.permissions.onAdded.addListener(() => { void injectMonitor(true).catch(() => {}); });
  const browserPermissions = requiredBrowserPermissions(firefox, LOCAL_BUILD);
  const contextError = (tab: chrome.tabs.Tab) => supportedPageContext(tab, firefox);
  const ports = new Map<chrome.runtime.Port, { origin: string; pending: Map<string, { action: string; controller: AbortController }> }>();
  const runtimeEpoch = crypto.randomUUID();
  const popupAuthorizations = new Map<number, { origin: string; controller: AbortController }>();
  const cancelPopupAuthorization = (tabId: number) => { popupAuthorizations.get(tabId)?.controller.abort(); };
  const cancelOriginAuthorization = (origin: string) => {
    approvals?.invalidateOrigin(origin, true);
    for (const pending of popupAuthorizations.values()) if (pending.origin === origin) pending.controller.abort();
  };
  let approvals: ChatApprovals | undefined;
  let credentialEvents: CredentialCookieEvents | undefined;
  const popupPorts = new Set<chrome.runtime.Port>();
  const notifyPopup = () => { for (const port of popupPorts) try { port.postMessage({ event: 'state-changed' }); } catch { /* closed */ } };
  const transport = new LocalCookieTransport({ extensionId: new URL(runtimeUrl).hostname,
    getCookies: async url => (await browser.cookies.getAll(localCookieQuery(url, firefox)))
      .filter(cookie => !firefox || cookie.storeId === FIREFOX_DEFAULT_STORE && unpartitionedCookie(cookie)),
    observeCookies: cookies => credentialEvents?.observe(cookies),
    updateRules: options => browser.declarativeNetRequest.updateSessionRules(options) });
  const audio = new LocalAudioPlayback({ transport });
  const publicRooms = new LocalPublicRooms({ transport });
  const audioMedia = new AudioMediaRules({ updateRules: options => browser.declarativeNetRequest.updateSessionRules(options) });
  // Clear only the dedicated media rule range after an event-page/worker restart.
  const audioReady = audioMedia.reset();
  void audioReady.catch(() => {});
  const notifyAccountChange = accountEventNotifier(authEpoch => {
    notifyPopup();
    for (const port of ports.keys()) {
      try { port.postMessage({ channel: LOCAL_LOGIN_CHANNEL, direction: 'event', event: 'account-changed', authEpoch, reason: 'credentials-changed' }); } catch { /* disconnected */ }
    }
  });
  const broker = new LocalLoginBroker({ fetch: async (input, init) => {
    await initializeTransport();
    return transport.run(new URL(String(input)), 'authenticated',
      init?.signal ?? new AbortController().signal, (_cookies, signal) => fetch(input, { ...init, signal, credentials: 'omit' }));
  }, onChange: authEpoch => {
    void transport.invalidate().catch(() => {});
    following.invalidate();
    medals.invalidate();
    notifyAccountChange(authEpoch);
  } });
  const sessions = new LoginSessions({ broker, storage: browser.storage.local,
    allowedOrigin: origin => (allowedPage(`${origin}${SITE_BASE_PATH}`) || LOCAL_BUILD && allowedPage(`${origin}/`)) && new URL(origin).origin === origin,
    onChange: (origin, revision, reason) => {
      approvals?.invalidateOrigin(origin);
      if (['revoked', 'permission-removed', 'logged-out', 'account-changed', 'playback-disabled'].includes(reason)) { danmaku.invalidate(); following.invalidate(); medals.invalidate(); }
      notifyPopup();
      for (const [port, context] of ports) if (context.origin === origin) {
        const preferences = sessions.read(origin);
        for (const item of context.pending.values()) if (item.action === 'RESOLVE_PLAYBACK' ||
          ((!preferences.chatWanted || !preferences.connectionWanted) && ['GET_CHAT_CONTEXT', 'GET_FOLLOWING_ROOMS', 'GET_FOLLOWING_STATUS', 'GET_FOLLOWING_ROOM_INFO', 'GET_FAN_MEDALS', 'GET_ROOM_FAN_MEDALS', 'SET_FAN_MEDAL', 'SEND_DANMAKU'].includes(item.action)) ||
          ((!preferences.granted || !preferences.connectionWanted || ['logged-out', 'account-changed'].includes(reason)) && item.action === 'RESOLVE_DANMAKU')) item.controller.abort();
        try { port.postMessage({ channel: LOCAL_LOGIN_CHANNEL, direction: 'event', event: 'session-changed', revision, reason }); } catch { /* disconnected */ }
      }
    } });
  const danmaku = new LocalDanmakuService({ transport, broker, sessions, storage: browser.storage.session, catalogStorage: browser.storage.local });
  const following = new LocalFollowingService({ transport, sessions });
  const medals = new LocalMedalService({ transport, sessions, onDiagnostic: diagnostic => console.info('[BWatch medal]', diagnostic), onChange: selection => {
    // A cosmetic medal change must not become a session/identity change: doing
    // so would restart otherwise healthy media and danmaku connections.
    for (const [port, context] of ports) {
      const preferences = sessions.read(context.origin);
      if (preferences.authorizationVersion !== 2 || !preferences.granted || !preferences.connectionWanted || !preferences.chatWanted || preferences.expectedUid !== selection.accountUid) continue;
      try { port.postMessage({ channel: LOCAL_LOGIN_CHANNEL, direction: 'event', event: 'medal-changed', medalSelection: selection }); } catch { /* closed */ }
    }
  } });
  approvals = new ChatApprovals({
    session: (origin, signal, force) => sessions.get(origin, signal, force),
    enable: (origin, binding, signal, current) => sessions.authorize(origin, binding, signal, current),
    currentPage: async tabId => { const tab = await browser.tabs.get(tabId); return allowedPage(tab.url) && !contextError(tab) ? new URL(tab.url!).href : undefined; },
    open: async approvalId => (await browser.windows.create({ url: browser.runtime.getURL(`/approval.html?request=${approvalId}`), type: 'popup', width: 440, height: 560, focused: true }))?.id,
    close: windowId => browser.windows.remove(windowId)
  });
  let transportInitialization: Promise<void> | undefined;
  const initializeTransport = (): Promise<void> => {
    if (transportInitialization) return transportInitialization;
    const current = (async () => {
      if (!await browser.permissions.contains(browserPermissions))
        throw new BrokerError('UNAUTHORIZED', '浏览器权限尚未允许，请打开登录助手并点击“连接并授权”。');
      await transport.reset();
      await browser.declarativeNetRequest.updateSessionRules({ removeRuleIds: [2000], addRules: [{ id: 2000, priority: 20,
        action: { type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
          requestHeaders: [{ header: 'Cookie', operation: 'remove' as chrome.declarativeNetRequest.HeaderOperation }] },
        condition: { initiatorDomains: [new URL(SITE_ORIGIN).hostname, ...(LOCAL_BUILD ? ['127.0.0.1', 'localhost'] : [])],
          regexFilter: danmakuWebsocketRegex(firefox),
          resourceTypes: ['websocket' as chrome.declarativeNetRequest.ResourceType] } }] });
    })();
    transportInitialization = current;
    void current.catch(() => { if (transportInitialization === current) transportInitialization = undefined; });
    return current;
  };
  const ready = (async () => {
    // Session DNR rules survive worker sleep. Clear prior cookie material first.
    // A host/API permission may be temporarily unavailable. Keep the control UI usable;
    // every HTTP path still requires successful transport initialization before fetch.
    await transport.reset().catch(() => {});
    await sessions.ready;
    await danmaku.ready;
    // A removed browser permission must not revive old intent after worker restart.
    if (!await browser.permissions.contains(browserPermissions)) await sessions.revokeAll();
    else await initializeTransport().catch(() => {});
  })();
  ready.catch(() => {});
  browser.runtime.onConnect.addListener(port => {
    if (port.name === 'bwatch-monitor-popup-state' && port.sender?.id === browser.runtime.id && port.sender.url === browser.runtime.getURL('/popup.html')) {
      popupPorts.add(port); port.onDisconnect.addListener(() => popupPorts.delete(port)); return;
    }
    if (port.name !== LOCAL_LOGIN_CHANNEL || port.sender?.id !== browser.runtime.id || port.sender.frameId !== 0 ||
      !allowedPage(port.sender.url) || !port.sender.tab?.id) { port.disconnect(); return; }
    const tabId = port.sender.tab.id;
    const documentUrl = new URL(port.sender.url!).href;
    const origin = new URL(documentUrl).origin;
    const audioOwner = { tabId, origin, document: port.sender.documentId ?? crypto.randomUUID() };
    let documentAnnounced = false;
    const pending = new Map<string, { action: string; controller: AbortController }>();
    ports.set(port, { origin, pending });
    port.onDisconnect.addListener(() => {
      ports.delete(port);
      approvals!.invalidateTab(tabId);
      cancelPopupAuthorization(tabId);
      for (const item of pending.values()) item.controller.abort();
      pending.clear();
    });
    port.onMessage.addListener((message: unknown) => {
      const internal = message as { internal?: string; documentToken?: unknown };
      if (internal?.internal === 'audio-document') {
        if (!documentAnnounced && typeof internal.documentToken === 'string' && /^[a-f0-9-]{36}$/.test(internal.documentToken)) {
          audioOwner.document = port.sender?.documentId ?? internal.documentToken;
          documentAnnounced = true;
        }
        return;
      }
      if ((message as { internal?: string })?.internal === 'audio-pagehide') {
        for (const item of pending.values()) if (item.action === 'RESOLVE_AUDIO_PLAYBACK') item.controller.abort();
        void audioMedia.releaseDocument(audioOwner).catch(() => {});
        return;
      }
      const value = message as LocalLoginRequest;
      if (!value || value.channel !== LOCAL_LOGIN_CHANNEL || value.direction !== 'request' ||
        typeof value.requestId !== 'string' || !/^[a-zA-Z0-9:_-]{1,100}$/.test(value.requestId) ||
        !['HELLO', 'GET_ACCOUNT', 'GET_SESSION', 'UPDATE_SESSION', 'RESOLVE_PUBLIC_ROOM', 'RESOLVE_PUBLIC_PLAYBACK', 'RESOLVE_PLAYBACK', 'RESOLVE_AUDIO_PLAYBACK', 'RELEASE_AUDIO_PLAYBACK', 'RESOLVE_DANMAKU', 'GET_CHAT_CONTEXT', 'GET_PUBLIC_PROFILE', 'GET_FOLLOWING_ROOMS', 'GET_FOLLOWING_STATUS', 'GET_FOLLOWING_ROOM_INFO', 'GET_FAN_MEDALS', 'GET_ROOM_FAN_MEDALS', 'SET_FAN_MEDAL', 'SEND_DANMAKU', 'GET_DANMAKU_SEND_RESULT', 'REQUEST_AUTHORIZATION', 'GET_AUTHORIZATION', 'CANCEL_AUTHORIZATION', 'CANCEL', 'DISCONNECT'].includes(value.action)) return;
      let serialized: string;
      try { serialized = JSON.stringify(value); } catch { return; }
      if (serialized.length > 4096) return;
      const keys: Record<string, string[]> = { HELLO: [], GET_ACCOUNT: [], GET_SESSION: ['force'],
        UPDATE_SESSION: ['revision', 'connectionWanted', 'playbackWanted', 'chatWanted', 'confirmUid'],
        RESOLVE_PLAYBACK: ['roomId', 'qn', 'force', 'authEpoch'],
        RESOLVE_PUBLIC_ROOM: ['roomId', 'force'], RESOLVE_PUBLIC_PLAYBACK: ['roomId', 'qn', 'force'],
        RESOLVE_AUDIO_PLAYBACK: ['roomId', 'force'], RELEASE_AUDIO_PLAYBACK: ['leaseId'],
        RESOLVE_DANMAKU: ['roomId', 'mode', 'authEpoch', 'force'], GET_CHAT_CONTEXT: ['roomId', 'authEpoch', 'force'], GET_PUBLIC_PROFILE: ['uid'],
        GET_FOLLOWING_ROOMS: ['page', 'authEpoch'], GET_FOLLOWING_STATUS: ['uids', 'authEpoch'], GET_FOLLOWING_ROOM_INFO: ['roomId', 'uid', 'authEpoch'],
        GET_FAN_MEDALS: ['roomId', 'page', 'authEpoch', 'force'], GET_ROOM_FAN_MEDALS: ['roomId', 'authEpoch'], SET_FAN_MEDAL: ['roomId', 'authEpoch', 'medalId', 'operationId'],
        SEND_DANMAKU: ['roomId', 'authEpoch', 'operationId', 'text', 'emoticonUnique'], GET_DANMAKU_SEND_RESULT: ['operationId'],
        REQUEST_AUTHORIZATION: [], GET_AUTHORIZATION: ['approvalId'], CANCEL_AUTHORIZATION: ['approvalId'],
        CANCEL: ['targetId'], DISCONNECT: ['revision'] };
      if (value.payload && (typeof value.payload !== 'object' || Array.isArray(value.payload) ||
        Object.keys(value.payload).some(key => !keys[value.action].includes(key)))) return;
      if (value.action === 'CANCEL') {
        if (typeof value.payload?.targetId === 'string') {
          pending.get(value.payload.targetId)?.controller.abort();
          approvals!.cancelRequest({ tabId, origin, documentUrl }, value.payload.targetId);
        }
        return;
      }
      if (pending.has(value.requestId) || pending.size >= 64) return;
      const controller = new AbortController();
      const operation = { action: value.action, controller, audioLeaseId: undefined as string | undefined };
      pending.set(value.requestId, operation);
      const releaseUndeliveredAudio = () => {
        const leaseId = operation.audioLeaseId;
        operation.audioLeaseId = undefined;
        if (leaseId) void audioMedia.release(audioOwner, leaseId).catch(() => {});
      };
      controller.signal.addEventListener('abort', releaseUndeliveredAudio, { once: true });
      const send = (response: LocalLoginResponse): boolean => {
        if (!ports.has(port)) return false;
        try { port.postMessage(response); return true; } catch { return false; }
      };
      void (async () => {
        await ready;
        const tab = await browser.tabs.get(tabId);
        const unsupported = contextError(tab);
        if (unsupported) throw new BrokerError('UNAUTHORIZED', unsupported);
        if (!allowedPage(tab.url) || new URL(tab.url!).origin !== origin || new URL(tab.url!).pathname !== new URL(documentUrl).pathname) throw new BrokerError('UNAUTHORIZED', '页面已离开 monitor');
        if (controller.signal.aborted) throw new DOMException('请求已取消', 'AbortError');
        // Following reads are account-bound. Reject an unauthorised page before
        // touching the transport/DNR setup so a first request cannot wait on
        // browser permission initialization or accidentally create a network
        // lease without a complete account grant.
        if (['GET_FOLLOWING_ROOMS', 'GET_FOLLOWING_STATUS', 'GET_FOLLOWING_ROOM_INFO', 'GET_FAN_MEDALS', 'GET_ROOM_FAN_MEDALS', 'SET_FAN_MEDAL'].includes(value.action)) {
          const preferences = sessions.read(origin);
          if (!preferences.granted || !preferences.connectionWanted || !preferences.chatWanted)
            throw new BrokerError('UNAUTHORIZED', '请先连接并授权本机 B站账号');
        }
        if (['RESOLVE_PUBLIC_ROOM', 'RESOLVE_PUBLIC_PLAYBACK', 'GET_ACCOUNT', 'RESOLVE_PLAYBACK', 'RESOLVE_DANMAKU', 'GET_CHAT_CONTEXT', 'GET_PUBLIC_PROFILE', 'GET_FOLLOWING_ROOMS', 'GET_FOLLOWING_STATUS', 'GET_FOLLOWING_ROOM_INFO', 'GET_FAN_MEDALS', 'GET_ROOM_FAN_MEDALS', 'SET_FAN_MEDAL', 'SEND_DANMAKU'].includes(value.action)) await initializeTransport();
        switch (value.action) {
          case 'HELLO': return { version: 1 as const, extensionVersion: browser.runtime.getManifest().version, runtimeEpoch, installationType: await installationType(),
            capabilities: ['account', 'playback', 'session', 'danmaku', 'chat', 'profile', 'unified-authorization', 'audio-playback', 'following', 'following-status', 'following-room-info', 'medals', 'medal-room-context', 'public-room', 'public-playback', 'anonymous-danmaku'] as ['account', 'playback', 'session', 'danmaku', 'chat', 'profile', 'unified-authorization', 'audio-playback', 'following', 'following-status', 'following-room-info', 'medals', 'medal-room-context', 'public-room', 'public-playback', 'anonymous-danmaku'] };
          case 'GET_SESSION': {
            if (value.payload?.force !== undefined && typeof value.payload.force !== 'boolean') throw new BrokerError('INVALID_REQUEST', '验证参数无效');
            return sessions.get(origin, controller.signal, value.payload?.force);
          }
          case 'UPDATE_SESSION': throw new BrokerError('INVALID_REQUEST', '请使用完整账号授权；如需停止，请撤销本站授权');
          // The legacy RPC cannot silently establish connection intent.
          case 'GET_ACCOUNT': return (await sessions.get(origin, controller.signal, true)).account ?? { state: 'unauthorized' as const, authEpoch: broker.authEpoch };
          case 'RESOLVE_PUBLIC_ROOM': return publicRooms.room(value.payload ?? {}, controller.signal);
          case 'RESOLVE_PUBLIC_PLAYBACK': return publicRooms.playback(value.payload ?? {}, controller.signal);
          case 'RESOLVE_PLAYBACK': return sessions.resolve(origin, value.payload ?? {}, controller.signal);
          case 'RESOLVE_AUDIO_PLAYBACK': {
            await audioReady;
            if (!await browser.permissions.contains(audioBrowserPermissions(LOCAL_BUILD))) throw new BrokerError('UNAVAILABLE', '请在浏览器扩展中允许省流量收听所需的网站访问权限');
            const playback = await audio.resolve(value.payload?.roomId, value.payload?.force, controller.signal);
            if (playback.status !== 'live' || !playback.sources.length) throw new BrokerError('UNAVAILABLE', '此直播间暂未提供纯音频');
            const current = await browser.tabs.get(tabId);
            if (!ports.has(port) || new URL(current.url ?? '').href !== documentUrl || controller.signal.aborted) throw new DOMException('页面已离开', 'AbortError');
            const leaseId = await audioMedia.acquire(audioOwner, playback.sources.map(source => source.url), controller.signal);
            operation.audioLeaseId = leaseId;
            if (controller.signal.aborted || !ports.has(port)) { releaseUndeliveredAudio(); throw new DOMException('请求已取消', 'AbortError'); }
            return { playback, leaseId };
          }
          case 'RELEASE_AUDIO_PLAYBACK': return audioMedia.release(audioOwner, value.payload?.leaseId);
          case 'RESOLVE_DANMAKU': return danmaku.resolve(origin, value.payload ?? {}, controller.signal);
          case 'GET_CHAT_CONTEXT': {
            if (value.payload?.force !== undefined && typeof value.payload.force !== 'boolean') throw new BrokerError('INVALID_REQUEST', '表情更新参数无效');
            return danmaku.context(origin, value.payload ?? {}, controller.signal);
          }
          case 'GET_PUBLIC_PROFILE': return danmaku.profile(value.payload?.uid, controller.signal);
          case 'GET_FOLLOWING_ROOMS': return following.page(origin, value.payload ?? {}, controller.signal);
          case 'GET_FOLLOWING_STATUS': return following.status(origin, value.payload ?? {}, controller.signal);
          case 'GET_FOLLOWING_ROOM_INFO': return following.roomInfo(origin, value.payload ?? {}, controller.signal);
          case 'GET_FAN_MEDALS': return medals.page(origin, value.payload ?? {}, controller.signal);
          case 'GET_ROOM_FAN_MEDALS': return medals.roomContext(origin, value.payload ?? {}, controller.signal);
          case 'SET_FAN_MEDAL': return medals.set(origin, value.payload ?? {}, controller.signal);
          case 'SEND_DANMAKU': return danmaku.send(origin, value.payload ?? {}, controller.signal);
          case 'GET_DANMAKU_SEND_RESULT': return danmaku.result(origin, value.payload?.operationId);
          case 'REQUEST_AUTHORIZATION': return approvals!.request({ tabId, origin, documentUrl, requestId: value.requestId }, controller.signal);
          case 'GET_AUTHORIZATION': return approvals!.result({ tabId, origin, documentUrl }, value.payload?.approvalId);
          case 'CANCEL_AUTHORIZATION': return approvals!.cancel({ tabId, origin, documentUrl }, value.payload?.approvalId);
          case 'DISCONNECT': {
            cancelOriginAuthorization(origin);
            await sessions.grant(origin, false, 'revoked', value.payload?.revision);
            await transport.reset();
            return null;
          }
        }
      })().then(result => {
        if (!controller.signal.aborted && send({ channel: LOCAL_LOGIN_CHANNEL, direction: 'response', requestId: value.requestId, ok: true, result }))
          operation.audioLeaseId = undefined;
        else releaseUndeliveredAudio();
      }, failure => {
        // Finish cancelled requests while the bridge is still connected so a
        // page-side caller never waits for an RPC timeout after revocation or
        // disconnect. A closed bridge simply drops this best-effort response.
        if (controller.signal.aborted) {
          send({ channel: LOCAL_LOGIN_CHANNEL, direction: 'response', requestId: value.requestId, ok: false,
            error: { code: 'UNAVAILABLE', message: '请求已取消' } });
          return;
        }
        const known = failure instanceof BrokerError;
        send({ channel: LOCAL_LOGIN_CHANNEL, direction: 'response', requestId: value.requestId, ok: false,
          error: { code: known ? failure.code : 'UNAVAILABLE', message: known ? failure.message : `${LOCAL_LOGIN_EXTENSION_NAME} 浏览器扩展暂不可用，请重试`,
            ...(known && failure.retryAfter ? { retryAfter: failure.retryAfter } : {}) } });
      }).finally(() => {
        controller.signal.removeEventListener('abort', releaseUndeliveredAudio);
        releaseUndeliveredAudio();
        pending.delete(value.requestId);
      });
    });
  });
  browser.runtime.onMessage.addListener((message: unknown, sender, respond) => {
    if (sender.id !== browser.runtime.id) return;
    const popupSender = sender.url === browser.runtime.getURL('/popup.html');
    let approvalId: string | null = null;
    try {
      const url = new URL(sender.url ?? '');
      const extension = new URL(browser.runtime.getURL('/'));
      if (url.protocol === extension.protocol && url.host === extension.host && url.pathname === '/approval.html') approvalId = url.searchParams.get('request');
    } catch { /* untrusted sender */ }
    if (!popupSender && !approvalId) return;
    const command = message as { action?: string; tabId?: number; revision?: number; confirmUid?: string; authEpoch?: string };
    void (async () => {
      await ready;
      if (approvalId) {
        if (command.action === 'APPROVAL_STATE') return { ok: true, approval: await approvals!.view(approvalId) };
        if (command.action === 'APPROVAL_ALLOW') await initializeTransport();
        if (command.action === 'APPROVAL_ALLOW' || command.action === 'APPROVAL_CANCEL')
          return { ok: true, approval: await approvals!.decide(approvalId, command.action === 'APPROVAL_ALLOW') };
        throw new BrokerError('INVALID_REQUEST', '确认操作无效');
      }
      if (command.action === 'OPEN_BILIBILI') { await browser.tabs.create({ url: 'https://www.bilibili.com/', ...(firefox ? { cookieStoreId: FIREFOX_DEFAULT_STORE } : {}) }); return { ok: true }; }
      if (command.action === 'OPEN_MONITOR') { await browser.tabs.create({ url: MONITOR_URL, ...(firefox ? { cookieStoreId: FIREFOX_DEFAULT_STORE } : {}) }); return { ok: true }; }
      if (!['STATE', 'AUTHORIZE', 'REVOKE', 'CHECK'].includes(command.action ?? '') || !Number.isInteger(command.tabId)) throw new Error();
      const tab = await browser.tabs.get(command.tabId!);
      const unsupported = contextError(tab);
      if (unsupported) throw new BrokerError('UNAUTHORIZED', unsupported);
      if (!allowedPage(tab.url)) throw new BrokerError('UNAUTHORIZED', '请先打开 BWatch monitor 页面');
      const origin = new URL(tab.url!).origin;
      if (command.action === 'AUTHORIZE') {
        await initializeTransport();
        const tabId = command.tabId!, documentUrl = new URL(tab.url!).href;
        if (popupAuthorizations.has(tabId)) throw new BrokerError('STATE_CONFLICT', '此页面正在确认账号，请稍候');
        const controller = new AbortController(); popupAuthorizations.set(tabId, { origin, controller });
        try {
          await sessions.authorize(origin, { revision: command.revision ?? sessions.read(origin).revision,
            ...(command.confirmUid ? { uid: command.confirmUid, authEpoch: command.authEpoch } : {}) }, controller.signal,
          async () => {
            const currentTab = await browser.tabs.get(tabId).catch(() => undefined);
            return allowedPage(currentTab?.url) && !contextError(currentTab!) && new URL(currentTab!.url!).href === documentUrl;
          });
        } finally { if (popupAuthorizations.get(tabId)?.controller === controller) popupAuthorizations.delete(tabId); }
      }
      if (command.action === 'REVOKE') { cancelOriginAuthorization(origin); await sessions.grant(origin, false); await transport.reset(); }
      // Opening STATE never migrates an old grant into connection intent.
      try {
        const session = await sessions.get(origin, undefined, command.action === 'CHECK');
        return { ok: true, origin, account: session.account, preferences: session.preferences, session };
      } catch (failure) {
        return { ok: true, origin, preferences: sessions.read(origin), accountUnavailable: true,
          message: failure instanceof BrokerError ? failure.message : '暂时无法检查 B站账号，请稍后重试' };
      }
    })().then(respond, failure => respond({ ok: false, message: failure instanceof BrokerError ? failure.message : `${LOCAL_LOGIN_EXTENSION_NAME} 浏览器扩展暂不可用，请稍后重试` }));
    return true;
  });
  let verifyTimer: ReturnType<typeof setTimeout> | undefined;
  credentialEvents = new CredentialCookieEvents({ ...(firefox ? { storeId: FIREFOX_DEFAULT_STORE } : {}), writesChanged: () => transport.invalidateWrites(), identityChanged: () => {
    broker.invalidate();
    approvals!.invalidateAll();
    danmaku.invalidate();
    following.invalidate();
    medals.invalidate();
    sessions.credentialsChanged();
    clearTimeout(verifyTimer);
    verifyTimer = setTimeout(() => {
      verifyTimer = undefined;
      void ready.then(() => Promise.allSettled(sessions.connectedOrigins().map(origin => sessions.get(origin))));
    }, 550);
  } });
  browser.cookies.onChanged.addListener(change => credentialEvents!.changed(change));
  browser.permissions.onRemoved.addListener(removed => {
    if (audioOnlyPermissionRemoval(removed)) {
      for (const context of ports.values()) for (const item of context.pending.values()) if (item.action === 'RESOLVE_AUDIO_PLAYBACK') item.controller.abort();
      void audioMedia.reset().catch(() => {});
      return;
    }
    transportInitialization = undefined;
    approvals!.invalidateAll();
    broker.invalidate();
    danmaku.invalidate();
    following.invalidate();
    medals.invalidate();
    void audioMedia.reset().catch(() => {});
    for (const context of ports.values()) for (const item of context.pending.values()) item.controller.abort();
    void ready.then(() => sessions.revokeAll()).then(() => transport.reset()).catch(() => {});
  });
  browser.windows.onRemoved.addListener(windowId => approvals!.windowClosed(windowId));
  browser.tabs.onRemoved.addListener(tabId => { approvals!.invalidateTab(tabId); cancelPopupAuthorization(tabId); void audioMedia.releaseTab(tabId).catch(() => {}); });
  browser.tabs.onUpdated.addListener((tabId, change) => {
    if (change.url) { approvals!.invalidateTab(tabId); cancelPopupAuthorization(tabId); }
    if (change.url || change.status === 'loading') void audioMedia.releaseTab(tabId).catch(() => {});
  });
} });
