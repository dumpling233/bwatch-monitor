import assert from 'node:assert/strict';
import test from 'node:test';
import type { LocalAccount } from '../shared/localLogin.js';
import { LocalLoginClientError } from '../client/multiview/localLoginClient.js';
import { LocalLoginRecovery } from '../client/multiview/localLoginRecovery.js';

const workerChanged = () => new LocalLoginClientError('ACCOUNT_CHANGED', 'worker restarted');
const abortError = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
function fixture() {
  const state = {
    account: { state: 'logged-in', uid: '42', name: '用户', authEpoch: 'old-worker' } as LocalAccount,
    active: true, verifications: 0, adoptions: 0, epochs: [] as string[]
  };
  const request = () => ({
    scope: 'same-media-session', account: state.account, signal: new AbortController().signal,
    currentAccount: () => state.account,
    active: () => state.active,
    recoverable: (error: unknown) => error instanceof LocalLoginClientError && error.code === 'ACCOUNT_CHANGED',
    verify: async (_signal: AbortSignal) => { state.verifications++; return { ...state.account, authEpoch: 'new-worker' }; },
    adopt: (account: LocalAccount) => { state.adoptions++; state.account = account; },
    resolve: async (epoch: string) => { state.epochs.push(epoch); if (epoch === 'old-worker') throw workerChanged(); return epoch; }
  });
  return { state, request };
}

test('parallel source renewals share one handshake and retry with the same verified UID', async () => {
  const recovery = new LocalLoginRecovery(), { state, request } = fixture();
  const jobs = Array.from({ length: 4 }, () => recovery.run(request()));
  assert.deepEqual(await Promise.all(jobs), Array(4).fill('new-worker'));
  assert.equal(state.verifications, 1);
  assert.equal(state.account.uid, '42');
  assert.equal(state.epochs.filter(epoch => epoch === 'old-worker').length, 4);
  assert.equal(state.epochs.filter(epoch => epoch === 'new-worker').length, 4);
  // A late failure from a request created before renewal reuses the verified epoch.
  const late = { ...request(), account: { ...state.account, authEpoch: 'old-worker' } };
  assert.equal(await recovery.run(late), 'new-worker');
  assert.equal(state.verifications, 1);
});

test('a different UID, logout or revoked authorization is never retried or adopted', async () => {
  for (const next of [
    { state: 'logged-in', uid: '99', name: '另一账号', authEpoch: 'new-worker' },
    { state: 'logged-out', authEpoch: 'new-worker' },
    { state: 'unauthorized', authEpoch: 'new-worker' }
  ] as LocalAccount[]) {
    const recovery = new LocalLoginRecovery(), { state, request } = fixture();
    await assert.rejects(recovery.run({ ...request(), verify: async () => next }), error => error instanceof LocalLoginClientError);
    assert.deepEqual(state.epochs, ['old-worker']);
    assert.equal(state.adoptions, 0);
  }
});

test('a source request retries at most once even if the worker changes again', async () => {
  const recovery = new LocalLoginRecovery(), { state, request } = fixture();
  await assert.rejects(recovery.run({ ...request(), resolve: async epoch => { state.epochs.push(epoch); throw workerChanged(); } }),
    error => error instanceof LocalLoginClientError && error.code === 'ACCOUNT_CHANGED');
  assert.equal(state.verifications, 1);
  assert.deepEqual(state.epochs, ['old-worker', 'new-worker']);
});

test('disconnect or a real account event during renewal prevents adoption and retry', async () => {
  for (const disconnect of [false, true]) {
    const recovery = new LocalLoginRecovery(), { state, request } = fixture();
    let complete!: (value: LocalAccount) => void;
    let verificationSignal: AbortSignal | undefined;
    const pending = recovery.run({ ...request(), verify: signal => {
      verificationSignal = signal;
      return new Promise(resolve => { complete = resolve; });
    } });
    await Promise.resolve();
    if (disconnect) state.active = false;
    recovery.invalidate();
    assert.equal(verificationSignal?.aborted, true);
    complete({ ...state.account, authEpoch: 'new-worker' });
    await assert.rejects(pending, abortError);
    assert.equal(state.adoptions, 0);
    assert.deepEqual(state.epochs, ['old-worker']);
  }
});

test('cancelling one tile does not cancel another tile sharing worker verification', async () => {
  const recovery = new LocalLoginRecovery(), { state, request } = fixture(), abort = new AbortController();
  let complete!: (value: LocalAccount) => void;
  let verificationSignal: AbortSignal | undefined;
  const first = recovery.run({ ...request(), signal: abort.signal, verify: signal => {
    state.verifications++; verificationSignal = signal;
    return new Promise(resolve => { complete = resolve; });
  } });
  const second = recovery.run(request());
  await Promise.resolve();
  abort.abort();
  await assert.rejects(first, abortError);
  assert.equal(verificationSignal?.aborted, false);
  complete({ ...state.account, authEpoch: 'new-worker' });
  assert.equal(await second, 'new-worker');
  assert.equal(state.verifications, 1);
});
