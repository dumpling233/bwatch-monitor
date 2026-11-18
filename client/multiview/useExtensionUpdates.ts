import { useCallback, useEffect, useRef, useState } from 'react';
import { checkExtensionPackages, extensionPackagesCache, getExtensionBrowser,
  type ExtensionBrowser } from './extensionDistribution';
import { describeExtensionUpdate } from './extensionUpdates';

export interface ExtensionUpdatesOptions {
  active: boolean;
  browser?: ExtensionBrowser;
  installedVersion: string;
  capabilities?: readonly string[];
  installationType?: string;
}

/** Checks the small static download manifest only while the view is visible. */
export function useExtensionUpdates(options: ExtensionUpdatesOptions) {
  const origin = window.location.origin;
  const [result, setResult] = useState(() => extensionPackagesCache.getSnapshot(origin));
  const [packageChecking, setPackageChecking] = useState(false);
  const [foreground, setForeground] = useState(() => !document.hidden && navigator.onLine);
  const generation = useRef(0);
  const pending = useRef<{ controller: AbortController; promise: Promise<void> } | null>(null);
  const check = useCallback((force = false): Promise<void> => {
    if (!options.active || !foreground) return Promise.resolve();
    if (pending.current) return pending.current.promise;
    const controller = new AbortController(), id = ++generation.current;
    setPackageChecking(true);
    const promise = checkExtensionPackages(controller.signal, force).then(value => {
      if (!controller.signal.aborted && id === generation.current) setResult(value);
    }).catch(() => { /* Cancellation is expected when leaving the visible view. */ }).finally(() => {
      if (id === generation.current) { setPackageChecking(false); pending.current = null; }
    });
    pending.current = { controller, promise }; return promise;
  }, [options.active, foreground]);
  useEffect(() => {
    const stop = () => { ++generation.current; pending.current?.controller.abort(); pending.current = null; setPackageChecking(false); };
    const update = () => {
      const visible = !document.hidden && navigator.onLine;
      if (!visible) stop();
      setForeground(visible);
    };
    const leave = () => { stop(); setForeground(false); };
    window.addEventListener('online', update); window.addEventListener('offline', update); window.addEventListener('pageshow', update);
    window.addEventListener('pagehide', leave); document.addEventListener('visibilitychange', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update);
      window.removeEventListener('pageshow', update); window.removeEventListener('pagehide', leave); document.removeEventListener('visibilitychange', update); };
  }, []);
  useEffect(() => {
    if (options.active && foreground) void check();
    return () => { ++generation.current; pending.current?.controller.abort(); pending.current = null; };
  }, [options.active, foreground, check]);
  const visible = options.active && foreground;
  const browser = options.browser ?? getExtensionBrowser(navigator.userAgent);
  const status: 'idle' | 'checking' | 'ready' | 'error' = visible && packageChecking ? 'checking'
    : result.error ? 'error' : result.checkedAt !== null ? 'ready' : 'idle';
  return { ...describeExtensionUpdate({ ...options, browser, packages: result.packages }),
    status, checking: visible && packageChecking, error: result.error, checkedAt: result.checkedAt, stale: result.stale, check };
}

export type ExtensionUpdatesView = ReturnType<typeof useExtensionUpdates>;
