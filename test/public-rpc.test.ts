import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalLoginClient, type LoginMessageWindow } from '../client/multiview/localLoginClient.js';
import { LOCAL_LOGIN_CHANNEL, type LocalLoginRequest } from '../shared/localLogin.js';
import { MONITOR_URL } from '../shared/site.js';

class MessageWindow implements LoginMessageWindow {
  location = { origin: new URL(MONITOR_URL).origin, pathname: new URL(MONITOR_URL).pathname };
  top: unknown = this;
  readonly requests: LocalLoginRequest[] = [];
  readonly listeners = new Set<(event: MessageEvent) => void>();
  postMessage(message: unknown, origin: string) { assert.equal(origin, this.location.origin); this.requests.push(message as LocalLoginRequest); }
  addEventListener(_type: 'message', listener: (event: MessageEvent) => void) { this.listeners.add(listener); }
  removeEventListener(_type: 'message', listener: (event: MessageEvent) => void) { this.listeners.delete(listener); }
  emit(data: unknown, origin = this.location.origin, source: unknown = this) {
    for (const listener of this.listeners) listener({ data, origin, source } as MessageEvent);
  }
  respond(request: LocalLoginRequest, result: unknown, origin?: string) {
    this.emit({ channel: LOCAL_LOGIN_CHANNEL, direction: 'response', requestId: request.requestId, ok: true, result }, origin);
  }
  accountChanged() { this.emit({ channel: LOCAL_LOGIN_CHANNEL, direction: 'event', event: 'account-changed', authEpoch: 'new-account' }); }
}
const playback = (roomId = '123', patch: Record<string, unknown> = {}) => ({ roomId, status: 'live', requestedQuality: 250,
  qualities: [{ qn: 250, label: '高清' }], resolvedAt: 1_000,
  sources: [{ id: 'hls', url: 'https://cn-test.bilivideo.com/live/index.m3u8?sign=test',
    protocol: 'hls', format: 'ts', codec: 'avc', actualQuality: 250 }], ...patch });

test('public metadata survives an account change while personal playback is invalidated', async () => {
  const target = new MessageWindow(), client = new LocalLoginClient(target);
  try {
    const signal = new AbortController().signal;
    const publicWork = client.publicRoom('123', signal);
    const personalWork = client.playback('123', 250, false, 'old-account', signal);
    const rejected = assert.rejects(personalWork, { code: 'ACCOUNT_CHANGED' });
    const request = target.requests.find(item => item.action === 'RESOLVE_PUBLIC_ROOM')!;
    assert.deepEqual(request.payload, { roomId: '123' });
    target.accountChanged(); await rejected;
    target.respond(request, { roomId: '123', anchorName: '匿名可读' });
    assert.deepEqual(await publicWork, { roomId: '123', anchorName: '匿名可读' });
  } finally { client.destroy(); }
});

test('public playback uses no account identity and validates its returned CDN projection', async () => {
  const target = new MessageWindow(), client = new LocalLoginClient(target);
  try {
    const work = client.publicPlayback('123', 250, true, new AbortController().signal);
    const request = target.requests.at(-1)!;
    assert.equal(request.action, 'RESOLVE_PUBLIC_PLAYBACK');
    assert.deepEqual(request.payload, { roomId: '123', qn: 250, force: true });
    target.accountChanged(); target.respond(request, { ...playback(), cookie: 'never-copy', authEpoch: 'never-copy' });
    const result = await work;
    assert.equal(result.sources[0].url, playback().sources[0].url);
    assert.equal('cookie' in result, false); assert.equal('authEpoch' in result, false);
    const invalid = client.publicPlayback('123', 250, false, new AbortController().signal);
    const rejected = assert.rejects(invalid, { code: 'UNAVAILABLE' });
    target.respond(target.requests.at(-1)!, playback('123', { sources: [{ ...playback().sources[0],
      url: 'https://bilivideo.com.evil.invalid/live/index.m3u8' }] }));
    await rejected;
  } finally { client.destroy(); }
});

test('public RPC cancellation sends CANCEL and late responses cannot settle the next request', async () => {
  const target = new MessageWindow(), client = new LocalLoginClient(target);
  try {
    const controller = new AbortController(), work = client.publicRoom('123', controller.signal);
    const request = target.requests.at(-1)!;
    const rejected = assert.rejects(work, { name: 'AbortError' });
    controller.abort(); await rejected;
    assert.equal(target.requests.at(-1)!.action, 'CANCEL');
    assert.deepEqual(target.requests.at(-1)!.payload, { targetId: request.requestId });
    const fresh = client.publicRoom('123', new AbortController().signal), next = target.requests.at(-1)!;
    target.respond(request, { roomId: '123', title: '旧响应' });
    target.respond(next, { roomId: '123', title: '新响应' });
    assert.deepEqual(await fresh, { roomId: '123', title: '新响应' });
  } finally { client.destroy(); }
});

test('foreign origin messages and unrelated Pages paths cannot operate the public bridge', async () => {
  const target = new MessageWindow(), client = new LocalLoginClient(target);
  try {
    const work = client.publicRoom('123', new AbortController().signal), request = target.requests.at(-1)!;
    target.respond(request, { title: '伪造' }, 'https://example.invalid');
    target.respond(request, { title: '可信' });
    assert.deepEqual(await work, { title: '可信' });
    target.location.pathname = '/another-project/';
    await assert.rejects(client.publicRoom('123', new AbortController().signal), { code: 'UNAVAILABLE' });
    assert.equal(target.requests.length, 1);
    target.location.pathname = new URL(MONITOR_URL).pathname; target.top = {};
    await assert.rejects(client.publicRoom('123', new AbortController().signal), { code: 'UNAVAILABLE' });
    assert.equal(target.requests.length, 1);
  } finally { client.destroy(); }
});

test('invalid public room identifiers and qualities never reach the extension', async () => {
  const target = new MessageWindow(), client = new LocalLoginClient(target);
  try {
    const signal = new AbortController().signal;
    await assert.rejects(client.publicRoom('0', signal));
    await assert.rejects(client.publicRoom('https://example.invalid', signal));
    await assert.rejects(client.publicPlayback('123', 0, false, signal));
    await assert.rejects(client.publicPlayback('123', 100_001, false, signal));
    assert.equal(target.requests.length, 0);
  } finally { client.destroy(); }
});
