interface HealthClock {
  now(): number;
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
}

interface HealthEnvironment {
  clock?: HealthClock;
  hidden?: () => boolean;
  document?: Pick<Document, 'addEventListener' | 'removeEventListener'>;
  window?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
}

export function createPlaybackHealthRuntime(environment: HealthEnvironment = {}) {
  const clock = environment.clock ?? {
    now: Date.now,
    setTimeout: (callback: () => void, delay: number) => globalThis.setTimeout(callback, delay),
    clearTimeout: (handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const observers = new Set<(resumed: boolean) => void>();
  let healthTimer: unknown;
  let lastTick = clock.now();
  const hidden = () => environment.hidden?.() ?? false;
  const notify = (resumed: boolean) => {
    for (const observer of observers) {
      try { observer(resumed); } catch {}
    }
  };
  const scheduleHealth = () => {
    if (!observers.size || healthTimer !== undefined) return;
    healthTimer = clock.setTimeout(() => {
      healthTimer = undefined;
      const now = clock.now();
      notify(now - lastTick > 6_000);
      lastTick = now;
      scheduleHealth();
    }, hidden() ? 5_000 : 1_000);
  };
  const wake = () => {
    if (hidden()) return;
    if (healthTimer !== undefined) clock.clearTimeout(healthTimer);
    healthTimer = undefined;
    lastTick = clock.now();
    notify(true);
    scheduleHealth();
  };
  type Recovery = { action(): void; signal: AbortSignal; active: boolean; cancelled: boolean; release(): void };
  const queue: Recovery[] = [];
  let activeRecoveries = 0;
  let nextRecoveryAt = 0;
  let recoveryTimer: unknown;
  const pump = () => {
    if (recoveryTimer !== undefined || activeRecoveries >= 2 || !queue.length) return;
    recoveryTimer = clock.setTimeout(() => {
      recoveryTimer = undefined;
      const entry = queue.shift();
      if (entry && !entry.cancelled && !entry.signal.aborted) {
        entry.active = true;
        activeRecoveries++;
        nextRecoveryAt = clock.now() + 1_000;
        try { entry.action(); } catch { entry.release(); }
      }
      pump();
    }, Math.max(0, nextRecoveryAt - clock.now()));
  };
  return {
    observe(check: (resumed: boolean) => void): () => void {
      if (!observers.size) {
        lastTick = clock.now();
        environment.document?.addEventListener('visibilitychange', wake);
        environment.window?.addEventListener('focus', wake);
      }
      observers.add(check);
      scheduleHealth();
      return () => {
        observers.delete(check);
        if (observers.size) return;
        if (healthTimer !== undefined) clock.clearTimeout(healthTimer);
        healthTimer = undefined;
        environment.document?.removeEventListener('visibilitychange', wake);
        environment.window?.removeEventListener('focus', wake);
      };
    },
    enqueue(action: () => void, signal: AbortSignal): () => void {
      const entry: Recovery = { action, signal, active: false, cancelled: false, release() {
        if (entry.cancelled) return;
        entry.cancelled = true;
        signal.removeEventListener('abort', entry.release);
        if (entry.active) activeRecoveries--;
        const index = queue.indexOf(entry);
        if (index >= 0) queue.splice(index, 1);
        if (!queue.length && recoveryTimer !== undefined) {
          clock.clearTimeout(recoveryTimer);
          recoveryTimer = undefined;
        }
        pump();
      } };
      if (signal.aborted) return entry.release;
      signal.addEventListener('abort', entry.release, { once: true });
      queue.push(entry);
      pump();
      return entry.release;
    },
  };
}

const runtime = createPlaybackHealthRuntime({
  hidden: () => typeof document !== 'undefined' && document.hidden,
  document: typeof document === 'undefined' ? undefined : document,
  window: typeof window === 'undefined' ? undefined : window,
});

export const observePlaybackHealth = runtime.observe;
export const enqueuePlaybackRecovery = runtime.enqueue;
