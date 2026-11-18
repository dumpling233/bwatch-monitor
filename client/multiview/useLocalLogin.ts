import { createContext, createElement, useCallback, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { LocalLoginClient, type LoginMessageWindow } from './localLoginClient';
import { LocalLoginController } from './localLoginController';
import type { PlaybackResolveRequest } from './localLoginProvider';

const LoginContext = createContext<LocalLoginController | null>(null);
const LoginTransportContext = createContext<(() => LocalLoginClient) | null>(null);

function createBrowserController() {
  // Construction during React render must not attach a global message listener.
  let client: LocalLoginClient | undefined;
  const current = () => client ??= new LocalLoginClient(window as unknown as LoginMessageWindow);
  const controller = new LocalLoginController({
    hello: (...args) => current().hello(...args), session: (...args) => current().session(...args),
    playback: (...args) => current().playback(...args),
    requestAuthorization: (...args) => current().requestAuthorization(...args), authorization: (...args) => current().authorization(...args),
    cancelAuthorization: (...args) => current().cancelAuthorization(...args),
    disconnect: (...args) => current().disconnect(...args), onEvent: (...args) => current().onEvent(...args)
  });
  return { controller, current, dispose: () => { client?.destroy(); client = undefined; } };
}

/** Keep browser identity above permission-driven MultiviewPanel remounts. */
export function LocalLoginProvider({ children }: { children: ReactNode }) {
  const [{ controller, current, dispose }] = useState(createBrowserController);
  useEffect(() => {
    const visible = () => controller.setForeground(!document.hidden);
    const online = () => controller.setOnline(navigator.onLine);
    const leave = () => controller.leave();
    controller.setOnline(navigator.onLine); controller.start(); visible();
    window.addEventListener('focus', visible); window.addEventListener('online', online); window.addEventListener('offline', online);
    window.addEventListener('pageshow', visible); window.addEventListener('pagehide', leave);
    document.addEventListener('visibilitychange', visible);
    return () => {
      controller.stop(); dispose();
      window.removeEventListener('focus', visible); window.removeEventListener('online', online); window.removeEventListener('offline', online);
      window.removeEventListener('pageshow', visible); window.removeEventListener('pagehide', leave);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [controller, dispose]);
  return createElement(LoginContext.Provider, { value: controller },
    createElement(LoginTransportContext.Provider, { value: current }, children));
}

/** Chat shares the existing document bridge; it never creates another account controller. */
export function useLocalLoginTransport(): () => LocalLoginClient {
  const transport = useContext(LoginTransportContext);
  if (!transport) throw new Error('LocalLoginProvider is required');
  return transport;
}

export function useLocalLogin() {
  const controller = useContext(LoginContext);
  if (!controller) throw new Error('LocalLoginProvider is required');
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const getTransport = useLocalLoginTransport();
  const resolvePlayback = useCallback((request: PlaybackResolveRequest) => {
    if (controller.getSnapshot().enabled) return controller.resolvePlayback(request);
    return getTransport().publicPlayback(request.roomId, request.qn, request.force, request.signal);
  }, [controller, getTransport]);
  return { ...state, resolvePlayback,
    readAccount: controller.readAccount, prepareAccount: controller.prepareAccount, currentState: controller.getSnapshot, accountFailed: controller.accountFailed,
    refresh: controller.refresh, checkExtension: controller.checkExtension, disconnect: controller.disconnect, authorize: controller.authorize,
    cancelAuthorization: controller.cancelAuthorization };
}
export type LocalLoginState = ReturnType<typeof useLocalLogin>;
