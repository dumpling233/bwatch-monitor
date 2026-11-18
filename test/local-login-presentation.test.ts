import assert from 'node:assert/strict';
import test from 'node:test';
import { localLoginPresentation } from '../client/multiview/localLoginPresentation.js';
import type { LocalLoginSnapshot } from '../client/multiview/localLoginController.js';

const snapshot = (patch: Partial<LocalLoginSnapshot> = {}): LocalLoginSnapshot => ({
  account: { state: 'logged-in', uid: '42', name: '完整昵称测试用户', authEpoch: 'epoch-1' },
  connected: true, enabled: true, wanted: true, busy: false, initialReady: true, status: 'active',
  verificationState: 'verified', lastVerifiedAt: 1000, extensionVersion: '0.2.0', message: '',
  authSessionKey: 'extension:epoch-1', resolutionScope: 'extension:epoch-1', chatEnabled: true, chatWanted: true,
  granted: true, connectionWanted: true, revocationState: 'idle', danmakuEnabled: true,
  authorizationSupported: true, authorizationPending: false, authorizationMessage: '', authorizationCurrent: true, ...patch
});

test('the account card describes unified authorization without turning media progress into account proof', () => {
  const authorized = localLoginPresentation(snapshot());
  assert.equal(authorized.label, '已连接 · 完整昵称测试用户');
  assert.equal(authorized.stage, 'ready');
  assert.equal(authorized.nextAction, null);
  assert.match(authorized.description, /账号支持的画质/);
  assert.match(authorized.description, /不会自动发言/);
  assert.equal(localLoginPresentation(snapshot({ enabled: false, chatEnabled: false })).label, authorized.label);
});

test('initial restoration does not flash missing authorization and temporary loss preserves safe intent', () => {
  const initial = localLoginPresentation(snapshot({ initialReady: false, granted: false, connectionWanted: false, extensionVersion: '', account: null, connected: false, authorizationCurrent: false }));
  assert.equal(initial.label, '正在检查连接…');
  assert.equal(initial.stage, 'preparing');
  assert.equal(initial.nextAction, null);
  const restoring = localLoginPresentation(snapshot({ status: 'recovering', verificationState: 'unavailable' }));
  assert.equal(restoring.label, '连接暂不可用，授权已保留');
  assert.match(restoring.description, /现有播放与弹幕继续/);
  assert.match(restoring.description, /下次使用账号功能时会尝试恢复/);
  assert.equal(restoring.stage, 'recover');
  assert.equal(restoring.nextAction, null);
  const unknown = localLoginPresentation(snapshot({ status: 'disconnected', verificationState: 'unavailable', authorizationCurrent: false, granted: false, account: null }));
  assert.equal(unknown.label, '暂时无法连接 B站账号', 'an unavailable session read does not prove missing authorization');
  assert.equal(unknown.stage, 'recover');
  assert.equal(unknown.nextAction, null);
});

test('missing extension, login and legacy partial grants require the relevant next step', () => {
  assert.equal(localLoginPresentation(snapshot({ extensionVersion: '', connected: false })).nextAction, 'install');
  assert.equal(localLoginPresentation(snapshot({ account: { state: 'logged-out', authEpoch: 'epoch-out' }, status: 'logged-out' })).nextAction, 'login');
  assert.equal(localLoginPresentation(snapshot({ granted: false, status: 'unauthorized', authorizationCurrent: false })).nextAction, 'authorize');
  const legacy = localLoginPresentation(snapshot({ authorizationCurrent: false }));
  assert.equal(legacy.nextAction, 'authorize', 'legacy read/playback access must not silently expand to sending');
  assert.match(legacy.label, /请重新授权/);
  assert.equal(localLoginPresentation(snapshot({ authorizationSupported: false })).nextAction, 'update');
});

test('pending confirmation and unacknowledged revocation cannot claim authorization success', () => {
  const pending = localLoginPresentation(snapshot({ authorizationCurrent: false, authorizationPending: true }));
  assert.equal(pending.label, '请在弹出的窗口确认');
  assert.equal(pending.stage, 'authorize');
  assert.equal(pending.nextAction, null);
  const revoking = localLoginPresentation(snapshot({ revocationState: 'unconfirmed' }));
  assert.equal(revoking.label, '撤销尚未确认');
  assert.equal(revoking.nextAction, null);
  assert.equal(revoking.revoking, true);
  const revoked = localLoginPresentation(snapshot({ granted: false, revocationState: 'revoked', authorizationCurrent: false }));
  assert.equal(revoked.label, '已停止使用 B站账号');
  assert.equal(revoked.nextAction, 'authorize');
});

test('account change and authorization-required both require a new unified confirmation', () => {
  const changed = localLoginPresentation(snapshot({ status: 'account-changed', authorizationCurrent: false }));
  assert.equal(changed.label, '请确认新账号 · 完整昵称测试用户');
  assert.equal(changed.nextAction, 'authorize');
  assert.match(changed.description, /重新确认当前账号/);
  const required = localLoginPresentation(snapshot({ status: 'authorization-required', authorizationCurrent: false }));
  assert.equal(required.label, '请重新授权 · 完整昵称测试用户');
  assert.equal(required.nextAction, 'authorize');
});

test('a retained authorization survives transport loss without being sent through installation again', () => {
  const retained = localLoginPresentation(snapshot({ status: 'disconnected', connected: false, extensionVersion: '',
    authorizationSupported: false, verificationState: 'unavailable' }));
  assert.equal(retained.stage, 'recover');
  assert.equal(retained.nextAction, null);
  assert.match(retained.label, /授权已保留/);
});

test('a cleared grant still explains account changes before generic authorization guidance', () => {
  const changed = localLoginPresentation(snapshot({ status: 'account-changed', authorizationCurrent: false, granted: false }));
  assert.equal(changed.stage, 'authorize');
  assert.match(changed.label, /请确认新账号/);
  const missingAfterRevoke = localLoginPresentation(snapshot({ status: 'disconnected', extensionVersion: '', connected: false,
    authorizationCurrent: false, authorizationSupported: false, granted: false, revocationState: 'revoked' }));
  assert.equal(missingAfterRevoke.stage, 'install');
  assert.equal(missingAfterRevoke.nextAction, 'install');
});
