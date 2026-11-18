import type { LocalAccount } from '../../shared/localLogin';
import { LocalLoginClientError } from './localLoginClient';

const cancelled = () => new DOMException('Local login changed', 'AbortError');

interface RecoveryRequest<T> {
  scope: string;
  account: LocalAccount;
  signal: AbortSignal;
  currentAccount(): LocalAccount | null;
  active(): boolean;
  recoverable(error: unknown): boolean;
  verify(signal: AbortSignal): Promise<LocalAccount>;
  adopt(account: LocalAccount): void;
  resolve(epoch: string): Promise<T>;
}

/** A sleeping worker may lose its epoch while the browser account stays the same. */
export class LocalLoginRecovery {
  private generation = 0;
  private pending?: { scope: string; epoch: string; controller: AbortController; promise: Promise<LocalAccount> };

  invalidate(): void {
    this.generation++;
    this.pending?.controller.abort();
    this.pending = undefined;
  }

  private verify<T>(request: RecoveryRequest<T>): Promise<LocalAccount> {
    if (!this.pending || this.pending.scope !== request.scope || this.pending.epoch !== request.account.authEpoch) {
      this.pending?.controller.abort();
      const controller = new AbortController();
      const entry = { scope: request.scope, epoch: request.account.authEpoch, controller, promise: Promise.resolve(request.account) };
      // Retain the completed renewal for late failures from the same old worker.
      entry.promise = request.verify(controller.signal).catch(failure => {
        if (this.pending === entry) this.pending = undefined;
        throw failure;
      });
      this.pending = entry;
    }
    const pending = this.pending.promise;
    return new Promise((resolve, reject) => {
      const abort = () => reject(cancelled());
      request.signal.addEventListener('abort', abort, { once: true });
      pending.then(resolve, reject).finally(() => request.signal.removeEventListener('abort', abort));
      if (request.signal.aborted) abort();
    });
  }

  async run<T>(request: RecoveryRequest<T>): Promise<T> {
    const generation = this.generation;
    const check = () => {
      if (generation !== this.generation || request.signal.aborted || !request.active()) throw cancelled();
    };
    check();
    try {
      const result = await request.resolve(request.account.authEpoch);
      check();
      return result;
    } catch (failure) {
      check();
      let current = request.currentAccount();
      const renewed = current?.state === 'logged-in' && current.uid === request.account.uid && current.authEpoch !== request.account.authEpoch;
      if (!renewed && !request.recoverable(failure)) throw failure;
      if (!renewed) {
        current = await this.verify(request);
        check();
        if (current.state !== 'logged-in' || !current.uid || current.uid !== request.account.uid) {
          this.invalidate();
          throw new LocalLoginClientError(current.state === 'unauthorized' ? 'UNAUTHORIZED' : current.state === 'logged-out' ? 'LOGGED_OUT' : 'ACCOUNT_CHANGED',
            'B站账号或授权已变化，请重新连接本机账号');
        }
        request.adopt(current);
      }
      check();
      // Retry outside the catch body: a second failure must never start another handshake.
      const result = await request.resolve(current!.authEpoch);
      check();
      return result;
    }
  }
}
