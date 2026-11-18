import { LOCAL_LOGIN_CHANNEL } from '../../shared/localLogin';
export const MONITOR_BRIDGE_PING = 'bwatch-monitor-companion-bridge-ping';

interface Listener<T> { addListener(listener: (value: T) => void): void; removeListener(listener: (value: T) => void): void; }
export interface BridgePort {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: Listener<any>;
  onDisconnect: Listener<unknown>;
}
interface BridgeInstance { version: string; id: string; active: boolean; announce(): void; dispose(): void; }
export interface BridgeRegistry { current?: BridgeInstance; }
interface BridgeOptions {
  registry: BridgeRegistry;
  version: string;
  id(): string;
  allowed(): boolean;
  post(message: unknown): void;
  connect(): BridgePort;
  consumeLastError(): void;
  onMessage(listener: (message: any) => void): () => void;
  onPageHide(listener: () => void): () => void;
  onPing(listener: () => { extensionVersion: string; bridgeId: string } | undefined): () => void;
  onInvalidated(listener: () => void): void;
}

/** One live bridge per isolated document, including manual and event-based reinjection. */
export function mountContentBridge(options: BridgeOptions): BridgeInstance {
  const previous = options.registry.current;
  if (previous?.active && previous.version === options.version) { previous.announce(); return previous; }
  previous?.dispose();
  let port: BridgePort | undefined;
  let removePortListeners = () => {};
  const id = options.id();
  const post = (message: unknown) => { if (instance.active && options.allowed()) options.post(message); };
  const pagehide = () => { try { port?.postMessage({ internal: 'audio-pagehide' }); } catch { /* document is leaving */ } };
  const connect = () => {
    if (port) return port;
    const current = options.connect(); port = current;
    const onMessage = (message: any) => {
      if (message?.channel === LOCAL_LOGIN_CHANNEL && ['response', 'event'].includes(message.direction)) post(message);
    };
    const onDisconnect = () => {
      options.consumeLastError();
      if (port === current) { removePortListeners(); port = undefined; post({ channel: LOCAL_LOGIN_CHANNEL, direction: 'event', event: 'disconnected' }); }
    };
    removePortListeners = () => { current.onMessage.removeListener(onMessage); current.onDisconnect.removeListener(onDisconnect); };
    current.onMessage.addListener(onMessage); current.onDisconnect.addListener(onDisconnect);
    current.postMessage({ internal: 'audio-document', documentToken: id });
    return current;
  };
  let removeMessage = () => {}, removePageHide = () => {}, removePing = () => {};
  const instance: BridgeInstance = {
    version: options.version, id, active: true,
    announce: () => post({ channel: LOCAL_LOGIN_CHANNEL, direction: 'event', event: 'bridge-ready', extensionVersion: options.version, bridgeId: id }),
    dispose: () => {
      if (!instance.active) return;
      pagehide(); instance.active = false;
      removeMessage(); removePageHide(); removePing(); removePortListeners();
      try { port?.disconnect(); } catch { /* extension context already invalidated */ }
      port = undefined;
      if (options.registry.current === instance) options.registry.current = undefined;
    }
  };
  options.registry.current = instance;
  removeMessage = options.onMessage(message => {
    if (!instance.active || !options.allowed() || message?.channel !== LOCAL_LOGIN_CHANNEL || message.direction !== 'request' || 'internal' in message) return;
    try {
      if (JSON.stringify(message).length > 4096) return;
      connect().postMessage(message);
    } catch {
      removePortListeners();
      try { port?.disconnect(); } catch { /* invalidated context */ }
      port = undefined;
      post({ channel: LOCAL_LOGIN_CHANNEL, direction: 'event', event: 'disconnected' });
    }
  });
  removePageHide = options.onPageHide(pagehide);
  removePing = options.onPing(() => {
    if (!instance.active || !options.allowed()) return undefined;
    instance.announce();
    return { extensionVersion: instance.version, bridgeId: instance.id };
  });
  options.onInvalidated(() => {
    if (!instance.active) return;
    instance.dispose();
    if (options.allowed()) options.post({ channel: LOCAL_LOGIN_CHANNEL, direction: 'event', event: 'disconnected' });
  });
  instance.announce();
  return instance;
}
