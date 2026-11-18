import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LocalLoginSession } from '../../shared/localLogin';
import { ChatApprovals } from '../lib/chatApprovals';
import { BrokerError } from '../lib/broker';

const binding = { tabId: 1, origin: 'https://bwatch.icu', documentUrl: 'https://dumpling233.github.io/bwatch-monitor' };
function fixture() {
  let now = 1_000, url: string | undefined = binding.documentUrl, nextWindow = 10, enables = 0;
  const closed: number[] = [], opened: string[] = [];
  let session: LocalLoginSession = { preferences: { schemaVersion: 1, revision: 4, granted: true,
    connectionWanted: true, playbackWanted: false, chatWanted: false, expectedUid: '123' },
    account: { state: 'logged-in', uid: '123', name: '测试账号', authEpoch: 'epoch-1' }, verifiedAt: now,
    playbackAllowed: false, chatAllowed: false, reason: 'ready' };
  let wait: (() => Promise<void>) | undefined, openWait: (() => Promise<void>) | undefined;
  const approvals = new ChatApprovals({ now: () => now,
    session: async (_origin, signal) => { await wait?.(); if (signal?.aborted) throw new DOMException('cancelled', 'AbortError'); return structuredClone(session); },
    enable: async (_origin, expected, signal) => {
      assert.equal(signal.aborted, false); if (expected.uid) assert.equal(expected.uid, session.account?.uid);
      assert.equal(expected.revision, session.preferences.revision); assert.equal(expected.authEpoch, session.account?.authEpoch);
      enables++; session = { ...session, preferences: { ...session.preferences, revision: 5, chatWanted: true }, chatAllowed: true };
      return structuredClone(session);
    }, currentPage: async () => url,
    open: async id => { opened.push(id); await openWait?.(); return nextWindow++; }, close: async id => { closed.push(id); }
  });
  return { approvals, closed, opened, enables: () => enables, setTime: (value: number) => { now = value; },
    setUrl: (value?: string) => { url = value; }, setSession: (value: Partial<LocalLoginSession>) => { session = { ...session, ...value }; },
    setWait: (value?: () => Promise<void>) => { wait = value; }, setOpenWait: (value?: () => Promise<void>) => { openWait = value; },
    session: () => structuredClone(session) };
}

test('opening and polling never grants; only the trusted account-bound decision enables once', async () => {
  const f = fixture(), request = await f.approvals.request(binding);
  assert.equal(request.status, 'pending'); assert.equal(f.enables(), 0);
  assert.equal((await f.approvals.result(binding, request.approvalId)).status, 'pending');
  assert.deepEqual(await f.approvals.view(request.approvalId), { ...request, origin: binding.origin, name: '测试账号', uid: '123' });
  assert.equal((await f.approvals.decide(request.approvalId, true)).status, 'approved');
  assert.equal(f.enables(), 1); assert.equal(f.session().preferences.playbackWanted, false);
  await assert.rejects(f.approvals.decide(request.approvalId, true)); assert.equal(f.enables(), 1);
});

test('cancel, closing the confirmation window, expiry and page departure cannot enable', async () => {
  for (const action of ['cancel', 'window', 'expiry', 'navigate', 'port', 'cookie', 'revoke'] as const) {
    const f = fixture(), request = await f.approvals.request(binding);
    if (action === 'cancel') await f.approvals.cancel(binding, request.approvalId);
    if (action === 'window') f.approvals.windowClosed(10);
    if (action === 'expiry') f.setTime(121_001);
    if (action === 'navigate') f.setUrl('https://bwatch.icu/');
    if (action === 'port') f.approvals.invalidateTab(binding.tabId);
    if (action === 'cookie') f.approvals.invalidateAll();
    if (action === 'revoke') f.approvals.invalidateOrigin(binding.origin);
    const result = await f.approvals.result(binding, request.approvalId);
    assert.notEqual(result.status, 'pending', action);
    await assert.rejects(f.approvals.decide(request.approvalId, true));
    assert.equal(f.enables(), 0, action);
  }
});

test('changed UID, authentication epoch, or revision invalidates a consent without transferring it', async () => {
  for (const field of ['uid', 'authEpoch', 'revision'] as const) {
    const f = fixture(), request = await f.approvals.request(binding), current = f.session();
    if (field === 'revision') f.setSession({ preferences: { ...current.preferences, revision: 6 } });
    else f.setSession({ account: { ...current.account!, [field]: field === 'uid' ? '456' : 'epoch-2' } });
    await assert.rejects(f.approvals.decide(request.approvalId, true));
    assert.equal((await f.approvals.result(binding, request.approvalId)).status, 'invalidated'); assert.equal(f.enables(), 0);
  }
});

test('duplicate and concurrent web starts share one pending window; foreign tabs cannot consume it', async () => {
  const f = fixture(), [one, two] = await Promise.all([f.approvals.request(binding), f.approvals.request(binding)]);
  assert.equal(one.approvalId, two.approvalId); assert.equal(f.opened.length, 1);
  await assert.rejects(f.approvals.result({ ...binding, tabId: 2 }, one.approvalId));
  await assert.rejects(f.approvals.cancel({ ...binding, origin: 'https://foreign.example' }, one.approvalId));
  assert.equal((await f.approvals.result(binding, one.approvalId)).status, 'pending');
  await f.approvals.cancel(binding, one.approvalId);
});

test('worker restart loses unfinished consent and queries only return invalidated', async () => {
  const f = fixture(), request = await f.approvals.request(binding), restarted = fixture();
  assert.equal((await restarted.approvals.result(binding, request.approvalId)).status, 'invalidated');
  assert.equal(restarted.enables(), 0); f.approvals.invalidateAll();
});

test('cookie invalidation while trusted verification is pending aborts before enable', async () => {
  const f = fixture(), request = await f.approvals.request(binding);
  let resume!: () => void;
  f.setWait(() => new Promise<void>(resolve => { resume = resolve; }));
  const approval = f.approvals.decide(request.approvalId, true);
  await new Promise(resolve => setImmediate(resolve));
  f.approvals.invalidateAll(); resume();
  await assert.rejects(approval); assert.equal(f.enables(), 0);
});

test('an ungranted page may request trusted confirmation without reading or granting an account', async () => {
  const f = fixture(); f.setSession({ preferences: { ...f.session().preferences, granted: false, connectionWanted: false }, account: undefined });
  const pending = await f.approvals.request(binding);
  assert.equal(pending.status, 'pending'); assert.equal(f.enables(), 0);
  assert.match((await f.approvals.view(pending.approvalId)).name, /将验证/);
  await f.approvals.cancel(binding, pending.approvalId); assert.equal(f.enables(), 0);
});

test('the pending prompt budget is bounded across tabs', async () => {
  const f = fixture();
  for (let tabId = 1; tabId <= 8; tabId++) await f.approvals.request({ ...binding, tabId });
  await assert.rejects(f.approvals.request({ ...binding, tabId: 9 }), (error: unknown) => error instanceof BrokerError && error.code === 'RATE_LIMITED');
  assert.equal(f.opened.length, 8); f.approvals.invalidateAll();
});

test('cancelling the web request while the browser opens its window cannot leave an approvable prompt', async () => {
  const f = fixture(), controller = new AbortController();
  let release!: () => void;
  f.setOpenWait(() => new Promise<void>(resolve => { release = resolve; }));
  const pending = f.approvals.request({ ...binding, requestId: 'opening-request' }, controller.signal);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(); release();
  const result = await pending;
  assert.equal(result.status, 'cancelled'); assert.ok(f.closed.includes(10));
  await assert.rejects(f.approvals.decide(result.approvalId, true)); assert.equal(f.enables(), 0);
});

test('a late transport CANCEL can close a prompt after the short response but before the page handles its ID', async () => {
  const f = fixture(), response = await f.approvals.request({ ...binding, requestId: 'already-replied' });
  f.approvals.cancelRequest({ ...binding, tabId: 2 }, 'already-replied');
  assert.equal((await f.approvals.result(binding, response.approvalId)).status, 'pending');
  f.approvals.cancelRequest(binding, 'already-replied');
  assert.equal((await f.approvals.result(binding, response.approvalId)).status, 'cancelled');
  await assert.rejects(f.approvals.decide(response.approvalId, true)); assert.equal(f.enables(), 0);
});

test('a repeated opening request retains a bounded cancellation association for the shared prompt', async () => {
  const f = fixture(), first = await f.approvals.request({ ...binding, requestId: 'first-open' });
  const second = await f.approvals.request({ ...binding, requestId: 'second-open' });
  assert.equal(first.approvalId, second.approvalId);
  f.approvals.cancelRequest(binding, 'second-open');
  assert.equal((await f.approvals.result(binding, first.approvalId)).status, 'cancelled'); assert.equal(f.enables(), 0);
});

test('explicit revocation aborts trusted verification even after Allow was clicked', async () => {
  const f = fixture(), request = await f.approvals.request(binding);
  let resume!: () => void;
  f.setWait(() => new Promise<void>(resolve => { resume = resolve; }));
  const confirming = f.approvals.decide(request.approvalId, true);
  await new Promise(resolve => setImmediate(resolve));
  f.approvals.invalidateOrigin(binding.origin, true); resume();
  await assert.rejects(confirming); assert.equal(f.enables(), 0);
  assert.equal((await f.approvals.result(binding, request.approvalId)).status, 'invalidated');
});
