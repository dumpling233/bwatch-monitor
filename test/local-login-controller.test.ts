import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import type { LocalChatApproval, LocalLoginEvent, LocalLoginHello, LocalLoginSession } from '../shared/localLogin.js';
import type { PlaybackInfo } from '../shared/playback.js';
import { LocalLoginController } from '../client/multiview/localLoginController.js';
import { LocalLoginClientError } from '../client/multiview/localLoginClient.js';

const hello: LocalLoginHello = { version: 1, extensionVersion: '0.2.0', runtimeEpoch: 'worker',
  capabilities: ['account', 'playback', 'session', 'danmaku', 'chat', 'unified-authorization'] };
const snapshot = (revision = 1, uid = '42'): LocalLoginSession => ({
  preferences: { schemaVersion: 1, revision, authorizationVersion: 2, granted: true, connectionWanted: true,
    playbackWanted: true, chatWanted: true, expectedUid: uid },
  account: { state: 'logged-in', uid, name: '测试用户', authEpoch: 'epoch-a' }, verifiedAt: 1000,
  playbackAllowed: true, chatAllowed: true, danmakuAllowed: true, reason: 'ready'
});
const anonymous = (revision = 0): LocalLoginSession => ({ preferences: { schemaVersion: 1, revision,
  granted: false, connectionWanted: false, playbackWanted: false, chatWanted: false },
  playbackAllowed: false, chatAllowed: false, danmakuAllowed: false, reason: 'unauthorized' });
const deferred = <T>() => { let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  return { promise: new Promise<T>((yes, no) => { resolve = yes; reject = no; }), resolve, reject }; };
const settle = async () => { await new Promise<void>(resolve => setImmediate(resolve)); await new Promise<void>(resolve => setImmediate(resolve)); };

class FakeClient {
  current = snapshot();
  greeting = hello;
  helloCalls = 0;
  helloResult?: (signal?: AbortSignal) => Promise<LocalLoginHello>;
  sessionCalls: boolean[] = [];
  disconnects: Array<number | undefined> = [];
  listeners = new Set<(event: LocalLoginEvent) => void>();
  sessionResult?: (force: boolean, signal?: AbortSignal) => Promise<LocalLoginSession>;
  disconnectResult?: () => Promise<void>;
  approval: LocalChatApproval = { approvalId: 'approval-1', status: 'pending', expiresAt: Date.now() + 120000 };
  starts = 0;
  cancelled: string[] = [];
  async hello(signal?: AbortSignal) { this.helloCalls++; return this.helloResult ? this.helloResult(signal) : this.greeting; }
  async session(force = false, signal?: AbortSignal) { this.sessionCalls.push(force); return this.sessionResult ? this.sessionResult(force, signal) : structuredClone(this.current); }
  async playback(): Promise<PlaybackInfo> { throw new Error('no media in lifecycle tests'); }
  async disconnect(revision?: number) {
    this.disconnects.push(revision);
    if (this.disconnectResult) await this.disconnectResult(); else this.current = anonymous(this.current.preferences.revision + 1);
  }
  async requestAuthorization() { this.starts++; return { ...this.approval }; }
  async authorization() { return { ...this.approval }; }
  async cancelAuthorization(id: string) { this.cancelled.push(id); this.approval.status = 'cancelled'; }
  approve(uid = '42') { this.current = snapshot(this.current.preferences.revision + 1, uid); this.approval.status = 'approved'; }
  onEvent(listener: (event: LocalLoginEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event: LocalLoginEvent['event'], extra: Partial<LocalLoginEvent> = {}) {
    for (const listener of this.listeners) listener({ channel: 'bwatch.local-login.v1', direction: 'event', event, ...extra });
  }
}

test('installation wakes discovery immediately without authorizing or forcing account verification', async t => {
  const client = new FakeClient(); client.current = anonymous();
  client.helloResult = async () => { throw new LocalLoginClientError('NOT_INSTALLED', 'not installed'); };
  const controller = new LocalLoginController(client); t.after(() => controller.stop());
  controller.start(); await settle(); assert.equal(controller.getSnapshot().connected, false);
  client.helloResult = undefined;
  client.greeting = { ...hello, extensionVersion: '0.5.0', capabilities: [...hello.capabilities, 'audio-playback'] };
  client.emit('bridge-ready', { bridgeId: 'new-document', extensionVersion: 'untrusted-version' }); await settle();
  assert.equal(controller.getSnapshot().connected, true);
  assert.equal(controller.getSnapshot().extensionVersion, '0.5.0');
  assert.equal(controller.getSnapshot().bridgeReadyId, 'new-document');
  assert.equal(controller.getSnapshot().capabilities?.includes('audio-playback'), true);
  assert.deepEqual(client.sessionCalls, [false]);
  assert.equal(controller.getSnapshot().authorizationCurrent, false); assert.equal(client.starts, 0);
  for (let index = 0; index < 12; index++) client.emit('bridge-ready', { bridgeId: 'new-document', extensionVersion: '0.5.0' });
  await settle(); assert.equal(client.helloCalls, 2); assert.deepEqual(client.sessionCalls, [false]);
});

test('bridge readiness preserves an in-flight read and follows a HELLO missed before installation once', async t => {
  const client = new FakeClient(), missed = deferred<LocalLoginHello>(); let firstSignal: AbortSignal | undefined;
  client.current = anonymous();
  client.helloResult = signal => { firstSignal = signal; return missed.promise; };
  const controller = new LocalLoginController(client); t.after(() => controller.stop()); controller.start();
  for (let index = 0; index < 12; index++) client.emit('bridge-ready', { bridgeId: 'installed-during-hello', extensionVersion: '0.5.0' });
  await settle(); assert.equal(client.helloCalls, 1); assert.equal(firstSignal?.aborted, false);
  assert.equal(controller.getSnapshot().bridgeReadyId, undefined);
  client.helloResult = undefined; missed.reject(new LocalLoginClientError('NOT_INSTALLED', 'missed before install')); await settle();
  assert.equal(client.helloCalls, 2); assert.deepEqual(client.sessionCalls, [false]);
  assert.equal(controller.getSnapshot().bridgeReadyId, 'installed-during-hello'); assert.equal(firstSignal?.aborted, false);
});

test('new bridge capabilities are verified while a healthy same-UID media identity remains stable', async t => {
  const client = new FakeClient(), controller = new LocalLoginController(client); t.after(() => controller.stop()); controller.start(); await settle();
  const key = controller.getSnapshot().authSessionKey;
  const pending = deferred<LocalLoginHello>(); client.helloResult = () => pending.promise;
  client.emit('bridge-ready', { bridgeId: 'upgraded-content', extensionVersion: '0.5.0' }); await settle();
  assert.equal(controller.getSnapshot().bridgeReadyId, undefined);
  assert.equal(controller.getSnapshot().busy, false); assert.equal(controller.getSnapshot().authSessionKey, key);
  client.current.account!.authEpoch = 'fresh-worker';
  pending.resolve({ ...hello, extensionVersion: '0.5.0', capabilities: [...hello.capabilities, 'audio-playback'] }); await settle();
  assert.equal(controller.getSnapshot().bridgeReadyId, 'upgraded-content');
  assert.equal(controller.getSnapshot().authSessionKey, key); assert.equal(controller.getSnapshot().authorizationCurrent, true);
  assert.equal(client.sessionCalls.at(-1), false); assert.equal(client.starts, 0);
});

test('bridge replacement follows rather than aborts an in-flight session read', async t => {
  const client = new FakeClient(), controller = new LocalLoginController(client); t.after(() => controller.stop()); controller.start(); await settle();
  const pending = deferred<LocalLoginSession>(); let pendingSignal: AbortSignal | undefined;
  client.sessionResult = (_force, signal) => { pendingSignal = signal; return pending.promise; };
  const reading = controller.refresh(); await settle();
  client.emit('bridge-ready', { bridgeId: 'replacement-while-reading', extensionVersion: '0.5.0' }); await settle();
  assert.equal(pendingSignal?.aborted, false); assert.equal(client.sessionCalls.length, 2);
  client.sessionResult = undefined; pending.resolve(snapshot()); await reading; await settle();
  assert.equal(pendingSignal?.aborted, false); assert.deepEqual(client.sessionCalls, [false, true, false]);
  assert.equal(controller.getSnapshot().bridgeReadyId, 'replacement-while-reading');
});

test('installing an updated bridge can leave update-required without granting an account', async t => {
  const client = new FakeClient(); client.current = anonymous();
  client.greeting = { ...hello, capabilities: ['account', 'playback'] };
  const controller = new LocalLoginController(client); t.after(() => controller.stop()); controller.start(); await settle();
  assert.equal(controller.getSnapshot().status, 'update-required'); assert.deepEqual(client.sessionCalls, []);
  client.greeting = { ...hello, extensionVersion: '0.5.0', capabilities: [...hello.capabilities, 'audio-playback'] };
  client.emit('bridge-ready', { bridgeId: 'updated-extension', extensionVersion: '0.5.0' }); await settle();
  assert.equal(controller.getSnapshot().status, 'unauthorized'); assert.equal(controller.getSnapshot().authorizationCurrent, false);
  assert.equal(controller.getSnapshot().bridgeReadyId, 'updated-extension'); assert.equal(client.starts, 0);
  assert.deepEqual(client.sessionCalls, [false]);
});

test('bridge discovery defers offline or hidden documents and never bypasses request cooldown', async t => {
  let now = 1000;
  const client = new FakeClient(), controller = new LocalLoginController(client, { now: () => now }); t.after(() => controller.stop()); controller.start(); await settle();
  controller.setForeground(false); controller.setOnline(false);
  client.emit('bridge-ready', { bridgeId: 'queued-ready', extensionVersion: '0.5.0' }); await settle();
  assert.equal(client.helloCalls, 1);
  controller.setOnline(true); await settle(); assert.equal(client.helloCalls, 1);
  controller.setForeground(true); await settle(); assert.equal(client.helloCalls, 2);
  client.sessionResult = async () => { throw new LocalLoginClientError('RATE_LIMITED', 'cooldown', 60); };
  await controller.refresh(); const calls = client.helloCalls;
  client.emit('bridge-ready', { bridgeId: 'ready-in-cooldown', extensionVersion: '0.5.0' }); await settle();
  assert.equal(client.helloCalls, calls); assert.equal(controller.getSnapshot().bridgeReadyId, 'queued-ready');
  now += 60001; client.sessionResult = undefined; controller.setForeground(true); await settle();
  assert.equal(client.helloCalls, calls + 1); assert.equal(controller.getSnapshot().bridgeReadyId, 'ready-in-cooldown');
});

test('bridge announcement cannot interfere with pending revocation or restore personal authority', async t => {
  const client = new FakeClient(), controller = new LocalLoginController(client); t.after(() => controller.stop()); controller.start(); await settle();
  const ack = deferred<void>(); client.disconnectResult = () => ack.promise;
  const revoke = controller.disconnect(); const calls = client.helloCalls;
  client.emit('bridge-ready', { bridgeId: 'ready-during-revocation', extensionVersion: '0.5.0' }); await settle();
  assert.equal(client.helloCalls, calls); assert.equal(controller.getSnapshot().authorizationCurrent, false);
  client.current = anonymous(2); ack.resolve(); await revoke;
  controller.setForeground(true); await settle();
  assert.equal(controller.getSnapshot().authorizationCurrent, false); assert.equal(client.starts, 0);
});

test('extension update checks share HELLO without revalidating the account or changing media identity', async t => {
  const client = new FakeClient(), controller = new LocalLoginController(client); t.after(() => controller.stop());
  controller.start(); await settle();
  const before = controller.getSnapshot(), pending = deferred<LocalLoginHello>();
  client.helloResult = () => pending.promise;
  const checking = controller.checkExtension(), duplicate = controller.checkExtension();
  assert.equal(checking, duplicate); assert.equal(client.helloCalls, 2);
  pending.resolve({ ...hello, extensionVersion: '0.3.0', installationType: 'development', capabilities: [...hello.capabilities, 'following'] });
  await checking;
  const after = controller.getSnapshot();
  assert.equal(after.extensionVersion, '0.3.0'); assert.equal(after.installationType, 'development');
  assert.equal(after.capabilities?.includes('following'), true);
  for (const key of ['authorizationCurrent', 'status', 'authSessionKey', 'resolutionScope', 'lastVerifiedAt', 'verificationState'] as const)
    assert.equal(after[key], before[key]);
  assert.deepEqual(client.sessionCalls, [false]); assert.equal(client.starts, 0);
});

test('extension update discovery failure leaves verified authorization and playback unchanged', async t => {
  const client = new FakeClient(), controller = new LocalLoginController(client); t.after(() => controller.stop());
  controller.start(); await settle(); const before = controller.getSnapshot();
  client.helloResult = async () => { throw new LocalLoginClientError('UNAVAILABLE', '检查失败'); };
  await assert.rejects(controller.checkExtension(), /检查失败/);
  assert.equal(controller.getSnapshot(), before); assert.deepEqual(client.sessionCalls, [false]);
});

test('migration confirmation requires a newly successful account read rather than retained authorization', async t => {
  const client = new FakeClient(); let now = 1000;
  const controller = new LocalLoginController(client, { now: () => now }); t.after(() => controller.stop());
  controller.start(); await settle();
  client.sessionResult = async () => { throw new LocalLoginClientError('UNAVAILABLE', '暂时无法确认新版授权'); };
  assert.equal(await controller.refresh(), false);
  assert.equal(controller.getSnapshot().authorizationCurrent, true);
  assert.equal(await controller.refresh(), false); // A cooldown also supplies no new proof.
  now += 6000; client.sessionResult = undefined;
  assert.equal(await controller.refresh(), true);
  assert.deepEqual(client.sessionCalls, [false, true, true]);
  client.current = snapshot(0);
  assert.equal(await controller.refresh(), false); // A stale revision is not adopted as new evidence.
  assert.equal(controller.getSnapshot().authorizationCurrent, true);
  client.current = anonymous(2);
  assert.equal(await controller.refresh(), false);
  assert.equal(controller.getSnapshot().authorizationCurrent, false);
});

test('extension update checks reuse a running account handshake instead of adding a second read', async t => {
  const client = new FakeClient(), pending = deferred<LocalLoginHello>();
  client.helloResult = () => pending.promise;
  const controller = new LocalLoginController(client); t.after(() => controller.stop()); controller.start();
  const checking = controller.checkExtension();
  pending.resolve({ ...hello, installationType: 'normal' }); await checking;
  assert.equal(client.helloCalls, 1); assert.deepEqual(client.sessionCalls, [false]);
  assert.equal(controller.getSnapshot().installationType, 'normal');
});

test('a HELLO-only update can unlock the authorization entry but cannot grant an account', async t => {
  const client = new FakeClient(); client.current = anonymous(); client.greeting = { ...hello, capabilities: ['account', 'playback'] };
  const controller = new LocalLoginController(client); t.after(() => controller.stop()); controller.start(); await settle();
  assert.equal(controller.getSnapshot().status, 'update-required');
  client.greeting = { ...hello, installationType: 'normal' }; await controller.checkExtension();
  assert.equal(controller.getSnapshot().authorizationSupported, true); assert.equal(controller.getSnapshot().status, 'not-connected');
  assert.equal(controller.getSnapshot().authorizationCurrent, false); assert.deepEqual(client.sessionCalls, []); assert.equal(client.starts, 0);
});

test('background, offline, page leave, revocation and unmount discard late extension update results', async t => {
  for (const change of ['background', 'offline', 'leave', 'disconnect', 'stop'] as const) await t.test(change, async sub => {
    const client = new FakeClient(), controller = new LocalLoginController(client); sub.after(() => controller.stop());
    controller.start(); await settle(); const pending = deferred<LocalLoginHello>(); let signal: AbortSignal | undefined;
    client.helloResult = current => { signal = current; return pending.promise; };
    const rejected = assert.rejects(controller.checkExtension(), error => error instanceof DOMException && error.name === 'AbortError');
    if (change === 'background') controller.setForeground(false);
    else if (change === 'offline') controller.setOnline(false);
    else if (change === 'leave') controller.leave();
    else if (change === 'disconnect') await controller.disconnect();
    else controller.stop();
    assert.equal(signal?.aborted, true);
    pending.resolve({ ...hello, extensionVersion: '9.9.9', installationType: 'normal' }); await rejected;
    assert.equal(controller.getSnapshot().extensionVersion, hello.extensionVersion);
  });
});

test('verified unified authorization restores all capabilities without replaying consent', async t => {
  const client = new FakeClient(), controller = new LocalLoginController(client); t.after(() => controller.stop());
  controller.start(); await settle();
  const state = controller.getSnapshot();
  assert.equal(state.initialReady, true); assert.equal(state.authorizationCurrent, true);
  assert.equal(state.enabled, true); assert.equal(state.chatEnabled, true); assert.equal(state.danmakuEnabled, true);
  assert.equal(client.starts, 0);
  controller.stop();
  const reloaded = new LocalLoginController(client); t.after(() => reloaded.stop()); reloaded.start(); await settle();
  assert.equal(reloaded.getSnapshot().authorizationCurrent, true); assert.equal(client.starts, 0);
});

test('no authorization and legacy partial authorization never acquire personal capabilities by inspection', async t => {
  const client = new FakeClient(); client.current = anonymous();
  const controller = new LocalLoginController(client); t.after(() => controller.stop()); controller.start(); await settle();
  assert.equal(controller.getSnapshot().status, 'unauthorized'); assert.equal(controller.getSnapshot().revocationState, 'idle');
  await controller.refresh(); assert.equal(client.starts, 0);
  client.current = snapshot(2); delete client.current.preferences.authorizationVersion;
  client.emit('session-changed', { revision: 2, reason: 'preferences-changed' }); await settle();
  assert.equal(controller.getSnapshot().status, 'authorization-required');
  assert.equal(controller.getSnapshot().enabled, false); assert.equal(controller.getSnapshot().chatEnabled, false);
});

test('one trusted confirmation activates all capabilities; pending and cancellation activate none', async t => {
  const client = new FakeClient(); client.current = anonymous();
  const controller = new LocalLoginController(client, { approvalPollMs: 2 }); t.after(() => controller.stop()); controller.start(); await settle();
  const first = controller.authorize(); await settle();
  assert.equal(controller.getSnapshot().authorizationPending, true); assert.equal(controller.getSnapshot().enabled, false);
  await controller.authorize(); assert.equal(client.starts, 1);
  await controller.cancelAuthorization(); await first;
  assert.deepEqual(client.cancelled, ['approval-1']); assert.equal(controller.getSnapshot().authorizationCurrent, false);
  client.approval = { ...client.approval, approvalId: 'approval-2', status: 'pending' };
  const second = controller.authorize(); await settle(); client.approve(); await second;
  assert.equal(controller.getSnapshot().enabled, true); assert.equal(controller.getSnapshot().chatEnabled, true);
  assert.equal(controller.getSnapshot().danmakuEnabled, true); assert.equal(controller.getSnapshot().authorizationPending, false);
});

test('a successful trusted grant wins a cancellation race by resynchronizing authoritative consent', async t => {
  const client = new FakeClient(); client.current = anonymous();
  const controller = new LocalLoginController(client, { approvalPollMs: 2 }); t.after(() => controller.stop()); controller.start(); await settle();
  const pending = controller.authorize(); await settle(); client.approve();
  await controller.cancelAuthorization(); await pending;
  assert.equal(controller.getSnapshot().authorizationCurrent, true);
});

test('pending consent is invalidated by account changes and is never transferred to the new UID', async t => {
  const client = new FakeClient(); client.current = anonymous();
  const controller = new LocalLoginController(client, { approvalPollMs: 2 }); t.after(() => controller.stop()); controller.start(); await settle();
  const pending = controller.authorize(); await settle();
  client.current = { ...snapshot(2, '99'), playbackAllowed: false, chatAllowed: false, danmakuAllowed: false, reason: 'account-changed' };
  client.current.preferences.expectedUid = '42';
  client.emit('session-changed', { revision: 2, reason: 'account-changed' }); await pending; await settle();
  assert.equal(controller.getSnapshot().authorizationCurrent, false); assert.equal(controller.getSnapshot().account?.uid, '99');
  assert.deepEqual(client.cancelled, ['approval-1']);
});

test('verified logout stops all authority and later same-UID login still requires fresh authorization', async t => {
  const client = new FakeClient(), controller = new LocalLoginController(client); t.after(() => controller.stop()); controller.start(); await settle();
  client.current = { ...anonymous(2), preferences: { ...anonymous(2).preferences, granted: true, connectionWanted: true },
    account: { state: 'logged-out', authEpoch: 'logout' }, reason: 'logged-out' };
  client.emit('session-changed', { revision: 2, reason: 'logged-out' });
  assert.equal(controller.getSnapshot().enabled, false); assert.equal(controller.getSnapshot().chatEnabled, false); await settle();
  client.current = { ...client.current, account: snapshot().account, reason: 'ready' };
  await controller.refresh();
  assert.equal(controller.getSnapshot().authorizationCurrent, false);
  assert.equal(controller.getSnapshot().status, 'authorization-required');
});

test('an idle worker disconnect keeps capabilities and only the next read restores the same UID', async t => {
  const client = new FakeClient(), controller = new LocalLoginController(client); t.after(() => controller.stop()); controller.start(); await settle();
  const key = controller.getSnapshot().authSessionKey;
  const checks = client.sessionCalls.length;
  client.emit('disconnected');
  assert.equal(controller.getSnapshot().enabled, true); assert.equal(controller.getSnapshot().chatEnabled, true);
  assert.equal(controller.getSnapshot().danmakuEnabled, true);
  assert.equal(controller.getSnapshot().authorizationCurrent, true);
  client.current.account!.authEpoch = 'new-worker'; controller.setForeground(true); await settle();
  assert.equal(client.sessionCalls.length, checks, 'focus is not an account keepalive');
  assert.equal(await controller.readAccount(new AbortController().signal, async account => account.authEpoch), 'new-worker');
  assert.equal(controller.getSnapshot().authSessionKey, key); assert.equal(controller.getSnapshot().resolutionScope, 'extension:new-worker');
  assert.equal(controller.getSnapshot().chatEnabled, true); assert.equal(controller.getSnapshot().danmakuEnabled, true);
});

test('an explicit send prepares a cold worker epoch before one write, including an unobserved disconnect', async t => {
  const client = new FakeClient(), controller = new LocalLoginController(client); t.after(() => controller.stop());
  controller.start(); await settle();
  const key = controller.getSnapshot().authSessionKey, reads = client.sessionCalls.length;
  client.greeting = { ...hello, runtimeEpoch: 'new-runtime' };
  client.current.account!.authEpoch = 'cold-worker';
  const account = await controller.prepareAccount(new AbortController().signal);
  const posts: string[] = []; posts.push(account.authEpoch);
  assert.deepEqual(posts, ['cold-worker']);
  assert.equal(client.sessionCalls.length, reads + 1);
  assert.equal(client.sessionCalls.at(-1), false, 'cached inspection, not forced NAV');
  assert.equal(controller.getSnapshot().authSessionKey, key);
});

test('concurrent explicit preparations share one session read without creating an idle keepalive', async t => {
  const client = new FakeClient(), controller = new LocalLoginController(client); t.after(() => controller.stop());
  controller.start(); await settle();
  const gate = deferred<LocalLoginSession>(), reads = client.sessionCalls.length;
  client.sessionResult = () => gate.promise;
  const signal = new AbortController().signal;
  const one = controller.prepareAccount(signal), two = controller.prepareAccount(signal);
  await settle(); assert.equal(client.sessionCalls.length, reads + 1);
  const next = snapshot(); next.account!.authEpoch = 'renewed'; gate.resolve(next);
  assert.deepEqual((await Promise.all([one, two])).map(account => account.authEpoch), ['renewed', 'renewed']);
  controller.setForeground(true); await settle();
  assert.equal(client.sessionCalls.length, reads + 1);
});

test('a credential event replacing preparation is followed before writing without dropping the user action', async t => {
  const client = new FakeClient(), controller = new LocalLoginController(client); t.after(() => controller.stop());
  controller.start(); await settle();
  const old = deferred<LocalLoginSession>(), renewed = deferred<LocalLoginSession>();
  let calls = 0; client.sessionResult = () => ++calls === 1 ? old.promise : renewed.promise;
  const preparation = controller.prepareAccount(new AbortController().signal); await settle();
  client.emit('account-changed', { authEpoch: 'rotated', reason: 'credentials-changed' }); await settle();
  old.resolve(snapshot()); await settle();
  const next = snapshot(); next.account!.authEpoch = 'rotated'; renewed.resolve(next);
  assert.equal((await preparation).authEpoch, 'rotated');
  assert.equal(calls, 2);
});

test('a cancelled preparation or changed UID cannot reach a write', async t => {
  const client = new FakeClient(), controller = new LocalLoginController(client); t.after(() => controller.stop());
  controller.start(); await settle();
  let posts = 0;
  const gate = deferred<LocalLoginSession>(), signal = new AbortController(); client.sessionResult = () => gate.promise;
  const cancelled = controller.prepareAccount(signal.signal).then(() => { posts++; });
  signal.abort(); gate.resolve(snapshot());
  await assert.rejects(cancelled, { name: 'AbortError' });
  client.sessionResult = undefined;
  client.current = { ...snapshot(2, '99'), playbackAllowed: false, chatAllowed: false, danmakuAllowed: false, reason: 'account-changed' };
  client.current.preferences.expectedUid = '42';
  await assert.rejects(controller.prepareAccount(new AbortController().signal).then(() => { posts++; }));
  assert.equal(posts, 0);
  assert.equal(controller.getSnapshot().authorizationCurrent, false);
});

test('a failed preparation is an unsent action and respects recovery cooldown', async t => {
  const client = new FakeClient(), controller = new LocalLoginController(client); t.after(() => controller.stop());
  controller.start(); await settle();
  let posts = 0;
  client.sessionResult = async () => { throw new LocalLoginClientError('UNAVAILABLE', '本机连接暂不可用'); };
  await assert.rejects(controller.prepareAccount(new AbortController().signal).then(() => { posts++; }), /本机连接暂不可用/);
  const calls = client.sessionCalls.length;
  await assert.rejects(controller.prepareAccount(new AbortController().signal));
  assert.equal(client.sessionCalls.length, calls);
  assert.equal(posts, 0);
});

test('credential updates reject obsolete validation responses without tearing down healthy same-UID media', async t => {
  const client = new FakeClient(), controller = new LocalLoginController(client); t.after(() => controller.stop()); controller.start(); await settle();
  const key = controller.getSnapshot().authSessionKey, old = deferred<LocalLoginSession>(), replacement = deferred<LocalLoginSession>();
  let calls = 0;
  client.sessionResult = () => ++calls === 1 ? old.promise : replacement.promise;
  const refresh = controller.refresh(); await settle();
  client.emit('account-changed', { authEpoch: 'changed', reason: 'credentials-changed' });
  const obsolete = snapshot(); obsolete.account!.uid = '777'; old.resolve(obsolete); await refresh; await settle();
  assert.equal(controller.getSnapshot().account?.uid, '42'); assert.equal(controller.getSnapshot().authSessionKey, key);
  const rotated = snapshot(); rotated.account!.authEpoch = 'rotated'; replacement.resolve(rotated); await settle();
  assert.equal(controller.getSnapshot().authSessionKey, key); assert.equal(controller.getSnapshot().resolutionScope, 'extension:rotated');
});

test('revocation priority invalidates late checks and only reports success after acknowledgement', async t => {
  const client = new FakeClient(), controller = new LocalLoginController(client); t.after(() => controller.stop()); controller.start(); await settle();
  const check = deferred<LocalLoginSession>(); client.sessionResult = () => check.promise;
  const refresh = controller.refresh(); await settle();
  const ack = deferred<void>(); client.disconnectResult = () => ack.promise;
  const revoke = controller.disconnect();
  assert.equal(controller.getSnapshot().enabled, false); assert.equal(controller.getSnapshot().chatEnabled, false);
  assert.equal(controller.getSnapshot().danmakuEnabled, false); assert.equal(controller.getSnapshot().revocationState, 'pending');
  check.resolve(snapshot()); await refresh;
  assert.equal(controller.getSnapshot().authorizationCurrent, false);
  ack.resolve(); await revoke; assert.equal(controller.getSnapshot().revocationState, 'revoked');
});

test('lost revocation acknowledgement remains stopped through focus and retries the original revision', async t => {
  let now = 1000;
  const client = new FakeClient(), controller = new LocalLoginController(client, { now: () => now }); t.after(() => controller.stop()); controller.start(); await settle();
  client.disconnectResult = async () => { throw Error('lost port'); };
  await controller.disconnect(); const checks = client.sessionCalls.length;
  client.emit('disconnected'); controller.setForeground(true); await settle();
  assert.equal(controller.getSnapshot().revocationState, 'unconfirmed'); assert.equal(client.sessionCalls.length, checks);
  now += 6000; client.disconnectResult = undefined; controller.setForeground(true); await settle();
  assert.deepEqual(client.disconnects, [1, 1]); assert.equal(controller.getSnapshot().revocationState, 'revoked');
});

test('an old revocation retry cannot revoke a newer trusted grant in another tab', async t => {
  let now = 1000;
  const client = new FakeClient(), controller = new LocalLoginController(client, { now: () => now }); t.after(() => controller.stop()); controller.start(); await settle();
  client.disconnectResult = async () => { throw new LocalLoginClientError('UNAVAILABLE', 'lost ack'); };
  await controller.disconnect();
  client.current = snapshot(7); client.disconnectResult = async () => { throw new LocalLoginClientError('STATE_CONFLICT', 'new grant'); };
  now += 6000; controller.setForeground(true); await settle();
  assert.deepEqual(client.disconnects, [1, 1]); assert.equal(client.current.preferences.revision, 7);
  assert.equal(controller.getSnapshot().authorizationCurrent, true, 'new explicit complete grant is synchronized');
});

test('verification failures retain all established capabilities and retry only on actual use after cooldown', async t => {
  let now = 1000;
  const client = new FakeClient(), controller = new LocalLoginController(client, { now: () => now }); t.after(() => controller.stop()); controller.start(); await settle();
  const key = controller.getSnapshot().authSessionKey;
  client.sessionResult = async () => { throw new LocalLoginClientError('RATE_LIMITED', 'retry later', 90); };
  await controller.refresh(); const checks = client.sessionCalls.length;
  assert.equal(controller.getSnapshot().authorizationCurrent, true); assert.equal(controller.getSnapshot().authSessionKey, key);
  assert.equal(controller.getSnapshot().chatEnabled, true); assert.equal(controller.getSnapshot().danmakuEnabled, true);
  controller.setForeground(true); controller.setOnline(false); controller.setOnline(true); await settle(); assert.equal(client.sessionCalls.length, checks);
  now += 91000; client.sessionResult = undefined; controller.setForeground(true); await settle();
  assert.equal(client.sessionCalls.length, checks, 'cooldown expiry does not schedule NAV');
  await controller.readAccount(new AbortController().signal, async account => account.uid);
  assert.equal(controller.getSnapshot().status, 'active'); assert.equal(controller.getSnapshot().chatEnabled, true);
});

test('background and network return preserve authorization without scheduling checks', async t => {
  let now = 1000;
  const client = new FakeClient(), controller = new LocalLoginController(client, { now: () => now }); t.after(() => controller.stop()); controller.start(); await settle();
  const checks = client.sessionCalls.length;
  controller.setForeground(false); now += 600000; controller.setOnline(false); controller.setForeground(true); await settle();
  assert.equal(client.sessionCalls.length, checks); assert.equal(controller.getSnapshot().chatEnabled, true);
  let reads = 0;
  await assert.rejects(controller.readAccount(new AbortController().signal, async () => { reads++; }), /网络已断开/);
  assert.equal(reads, 0);
  controller.setOnline(true); controller.setForeground(true); controller.setForeground(true); await settle();
  assert.equal(client.sessionCalls.length, checks);
  assert.equal(controller.getSnapshot().chatEnabled, true);
});

test('healthy authorization has no periodic verification timer even after a day', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 1000;
  const client = new FakeClient(), controller = new LocalLoginController(client, { now: () => now });
  t.after(() => controller.stop()); controller.start(); await settle();
  const checks = client.sessionCalls.length;
  now += 86_400_000; t.mock.timers.tick(86_400_000); await settle();
  for (let i = 0; i < 8; i++) { controller.setForeground(false); controller.setForeground(true); controller.setOnline(false); controller.setOnline(true); }
  await settle();
  assert.equal(client.sessionCalls.length, checks); assert.equal(controller.getSnapshot().status, 'active');
  assert.equal(controller.getSnapshot().verificationState, 'verified');
});

test('concurrent failed reads share one same-account recovery and retry each read only once', async t => {
  const client = new FakeClient(), controller = new LocalLoginController(client); t.after(() => controller.stop());
  controller.start(); await settle(); const checks = client.sessionCalls.length;
  const key = controller.getSnapshot().authSessionKey;
  client.current.account!.authEpoch = 'new-worker';
  let reads = 0;
  const run = async (account: NonNullable<LocalLoginSession['account']>) => {
    reads++; if (account.authEpoch === 'epoch-a') throw new LocalLoginClientError('ACCOUNT_CHANGED', 'worker restarted');
    return account.uid;
  };
  const signal = new AbortController().signal;
  assert.deepEqual(await Promise.all([controller.readAccount(signal, run), controller.readAccount(signal, run)]), ['42', '42']);
  assert.equal(client.sessionCalls.length, checks + 1); assert.equal(client.sessionCalls.at(-1), false);
  assert.equal(reads, 4); assert.equal(controller.getSnapshot().authSessionKey, key);
  await assert.rejects(controller.readAccount(signal, async () => { throw new LocalLoginClientError('UNAVAILABLE', 'room unavailable'); }), /room unavailable/);
  assert.equal(controller.getSnapshot().authorizationCurrent, true, 'room failure does not revoke the site');
});

test('an unverified snapshot cannot turn a confirmed authorization into anonymous playback', async t => {
  const client = new FakeClient(), controller = new LocalLoginController(client); t.after(() => controller.stop());
  controller.start(); await settle(); const key = controller.getSnapshot().authSessionKey;
  client.current = { ...snapshot(), account: undefined, verifiedAt: undefined, playbackAllowed: false, chatAllowed: false, danmakuAllowed: false, reason: 'unverified' };
  await controller.refresh();
  assert.equal(controller.getSnapshot().authSessionKey, key); assert.equal(controller.getSnapshot().account?.uid, '42');
  assert.equal(controller.getSnapshot().chatEnabled, true); assert.equal(controller.getSnapshot().danmakuEnabled, true);
});

test('pagehide cancels pending work; pageshow revalidates before restoring authority', async t => {
  const client = new FakeClient(), pending = deferred<LocalLoginSession>(); client.sessionResult = () => pending.promise;
  const controller = new LocalLoginController(client); t.after(() => controller.stop()); controller.start(); await settle(); controller.leave();
  pending.resolve(snapshot()); await settle(); assert.equal(controller.getSnapshot().enabled, false);
  client.sessionResult = undefined; controller.setForeground(true); await settle(); assert.equal(controller.getSnapshot().enabled, true);
});

test('a temporary BFCache verification failure retains chat capabilities for recovery on actual use', async t => {
  let now = 1000;
  const client = new FakeClient(), controller = new LocalLoginController(client, { now: () => now });
  t.after(() => controller.stop()); controller.start(); await settle();
  const key = controller.getSnapshot().authSessionKey;
  controller.leave();
  client.sessionResult = async () => { throw new LocalLoginClientError('UNAVAILABLE', 'temporary NAV failure'); };
  controller.setForeground(true); await settle();
  assert.equal(controller.getSnapshot().authorizationCurrent, true);
  assert.equal(controller.getSnapshot().chatEnabled, true); assert.equal(controller.getSnapshot().danmakuEnabled, true);
  assert.equal(controller.getSnapshot().authSessionKey, key);
  const checks = client.sessionCalls.length;
  now += 6000; client.sessionResult = undefined;
  controller.setForeground(true); await settle();
  assert.equal(client.sessionCalls.length, checks, 'no account retry timer or focus polling');
  assert.equal(await controller.readAccount(new AbortController().signal, async account => account.uid), '42');
  assert.equal(controller.getSnapshot().status, 'active');
  assert.equal(controller.getSnapshot().chatEnabled, true); assert.equal(controller.getSnapshot().danmakuEnabled, true);
});

test('initial restoration has a bounded anonymous fallback and can later adopt verified consent', async t => {
  const client = new FakeClient(), pending = deferred<LocalLoginSession>(); client.sessionResult = () => pending.promise;
  const controller = new LocalLoginController(client, { gateMs: 5 }); t.after(() => controller.stop()); controller.start();
  await wait(15); assert.equal(controller.getSnapshot().initialReady, true); assert.equal(controller.getSnapshot().enabled, false);
  pending.resolve(snapshot()); await settle(); assert.equal(controller.getSnapshot().enabled, true);
});

test('old extensions keep anonymous operation and request an update without inheriting partial consent', async t => {
  const client = new FakeClient(); client.greeting = { ...hello, capabilities: ['account', 'playback', 'session'] };
  const controller = new LocalLoginController(client); t.after(() => controller.stop()); controller.start(); await settle();
  assert.equal(controller.getSnapshot().status, 'update-required'); assert.equal(controller.getSnapshot().enabled, false);
  assert.equal(client.sessionCalls.length, 0);
});

test('another tab revokes every capability immediately and a newer explicit full grant restores all', async t => {
  const client = new FakeClient(), controller = new LocalLoginController(client); t.after(() => controller.stop()); controller.start(); await settle();
  client.current = anonymous(3); client.emit('session-changed', { revision: 3, reason: 'revoked' });
  assert.equal(controller.getSnapshot().authorizationCurrent, false); assert.equal(controller.getSnapshot().chatEnabled, false); await settle();
  client.current = snapshot(4); client.emit('session-changed', { revision: 4, reason: 'preferences-changed' }); await settle();
  assert.equal(controller.getSnapshot().enabled, true); assert.equal(controller.getSnapshot().chatEnabled, true); assert.equal(controller.getSnapshot().danmakuEnabled, true);
  await controller.disconnect();
  client.current = snapshot(7); client.emit('session-changed', { revision: 7, reason: 'preferences-changed' }); await settle();
  assert.equal(controller.getSnapshot().authorizationCurrent, true, 'a new cross-tab grant also clears a previous local revocation stop');
});
