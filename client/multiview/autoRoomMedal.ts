import { LocalMedalNotDispatchedError, type LocalMedalStore } from './localMedalClient';

type Intent = { roomId: string; store: LocalMedalStore; done: boolean };
/** One user-enabled intent per room visit. No timers, retry loop, or unknown reconciliation. */
export class AutoRoomMedal {
  private intent?: Intent;
  private enabled = false;
  private active = false;
  private sends = 0;
  private stop?: () => void;
  private manual = 0;
  private work?: { controller: AbortController; dispatched: boolean; promise?: Promise<void> };
  update(enabled: boolean, active: boolean, roomId: string | null, store?: LocalMedalStore): void {
    const changed = enabled !== this.enabled || roomId !== this.intent?.roomId || store !== this.intent?.store;
    if (changed) {
      this.stop?.(); this.cancel();
      this.intent = enabled && roomId && store ? { roomId, store, done: false } : undefined;
      if (this.intent) {
        this.manual = store!.getSnapshot().manualRevision ?? 0;
        this.stop = store!.subscribe(() => {
          const manual = store!.getSnapshot().manualRevision ?? 0;
          if (manual !== this.manual) { this.manual = manual; if (this.intent) this.intent.done = true; this.cancel(); }
          this.pump();
        });
      }
    }
    this.enabled = enabled; this.active = active;
    if (!enabled || !active) this.cancel();
    this.pump();
  }
  private cancel(): void { if (this.work && !this.work.dispatched) this.work.controller.abort(); }
  private pump(): void {
    const intent = this.intent;
    if (!intent || intent.done || !this.enabled || !this.active || this.sends || this.work) return;
    const state = intent.store.getSnapshot();
    if (state.changing || state.unknown) return;
    const work = { controller: new AbortController(), dispatched: false, promise: undefined as Promise<void> | undefined };
    this.work = work;
    const valid = () => !work.controller.signal.aborted && this.intent === intent && this.enabled && this.active && !this.sends && !intent.done;
    work.promise = (async () => {
      try {
        await Promise.all([intent.store.load(1, work.controller.signal), intent.store.loadRoom(work.controller.signal)]);
        if (!valid()) return;
        const current = intent.store.getSnapshot();
        if (current.changing || current.unknown) return;
        const medal = current.roomItems?.find(item => item.targetUid === current.roomTargetUid) ?? current.items.find(item => item.targetUid === current.roomTargetUid);
        if (!medal || current.selectedMedalId === medal.id || current.selectedMedal?.targetUid === current.roomTargetUid) { intent.done = true; return; }
        await intent.store.selectAuto(medal.id, work.controller.signal, () => {
          if (!valid()) throw new LocalMedalNotDispatchedError('自动切换已取消');
          work.dispatched = true; intent.done = true;
        });
        if (valid()) intent.done = true;
      } catch { if (valid()) intent.done = true; }
      finally { if (this.work === work) this.work = undefined; this.pump(); }
    })();
  }
  /** Reserve sending synchronously; an already submitted medal write keeps its ACK. */
  async acquireSend(signal: AbortSignal): Promise<() => void> {
    this.sends++; this.cancel();
    let released = false;
    const release = () => { if (!released) { released = true; this.sends--; this.pump(); } };
    try {
      const waiting = this.work?.promise;
      if (waiting) await new Promise<void>((resolve, reject) => {
        const abort = () => { signal.removeEventListener('abort', abort); reject(new DOMException('发言已取消', 'AbortError')); };
        if (signal.aborted) { abort(); return; }
        signal.addEventListener('abort', abort, { once: true });
        void waiting.then(() => { signal.removeEventListener('abort', abort); resolve(); });
      });
      if (signal.aborted) throw new DOMException('发言已取消', 'AbortError');
      return release;
    } catch (error) { release(); throw error; }
  }
  dispose(): void { this.enabled = false; this.intent = undefined; this.stop?.(); this.stop = undefined; this.cancel(); }
}
