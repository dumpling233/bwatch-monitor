import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mountContentBridge, type BridgePort, type BridgeRegistry } from '../lib/contentBridge';
import { LOCAL_LOGIN_CHANNEL } from '../../shared/localLogin';

function fixture() {
  const registry: BridgeRegistry = {}, messages = new Set<(value: any) => void>(), hides = new Set<() => void>();
  const pings = new Set<() => { extensionVersion: string; bridgeId: string } | undefined>();
  const invalidations: Array<() => void> = [], posted: any[] = [], ports: Array<BridgePort & { sent: any[]; disconnected: boolean; replies: Set<(value: any) => void>; disconnects: Set<(value: any) => void> }> = [];
  let ids = 0, allowed = true;
  const options = (version = '0.1.2') => ({ registry, version, id: () => `document-${++ids}`,
    allowed: () => allowed, post: (value: unknown) => { posted.push(value); }, consumeLastError: () => {},
    connect: () => {
      const replies = new Set<(value: any) => void>(), disconnects = new Set<(value: any) => void>();
      const port = { sent: [] as any[], disconnected: false, replies, disconnects,
        postMessage(value: unknown) { this.sent.push(value); },
        disconnect() { this.disconnected = true; for (const listener of disconnects) listener(undefined); },
        onMessage: { addListener: (listener: (value: any) => void) => { replies.add(listener); }, removeListener: (listener: (value: any) => void) => { replies.delete(listener); } },
        onDisconnect: { addListener: (listener: (value: any) => void) => { disconnects.add(listener); }, removeListener: (listener: (value: any) => void) => { disconnects.delete(listener); } }
      };
      ports.push(port); return port;
    },
    onMessage: (listener: (value: any) => void) => { messages.add(listener); return () => { messages.delete(listener); }; },
    onPageHide: (listener: () => void) => { hides.add(listener); return () => { hides.delete(listener); }; },
    onPing: (listener: () => { extensionVersion: string; bridgeId: string } | undefined) => { pings.add(listener); return () => { pings.delete(listener); }; },
    onInvalidated: (listener: () => void) => { invalidations.push(listener); }
  });
  const request = (extra: object = {}) => { for (const listener of messages) listener({ channel: LOCAL_LOGIN_CHANNEL, direction: 'request', action: 'HELLO', requestId: 'hello', ...extra }); };
  return { options, request, registry, messages, hides, pings, invalidations, posted, ports, disallow: () => { allowed = false; } };
}

test('same-version reinjection only announces the existing bridge, without extra listeners, port, or document token', () => {
  const f = fixture(), first = mountContentBridge(f.options());
  assert.equal(f.ports.length, 0, 'announcement must not open a worker port or verify an account');
  f.request();
  const second = mountContentBridge(f.options()); f.request();
  assert.equal(first, second); assert.equal(f.messages.size, 1); assert.equal(f.hides.size, 1); assert.equal(f.pings.size, 1); assert.equal(f.invalidations.length, 1);
  assert.equal(f.ports.length, 1);
  assert.deepEqual(f.ports[0].sent.filter(value => value.internal), [{ internal: 'audio-document', documentToken: first.id }]);
  assert.deepEqual(f.posted.map(value => value.bridgeId), [first.id, first.id]);
});

test('a newer bridge replaces and cleans its predecessor, and late old invalidation cannot disconnect it', () => {
  const f = fixture(), old = mountContentBridge(f.options('0.1.1')); f.request();
  const next = mountContentBridge(f.options()); f.request();
  assert.equal(old.active, false); assert.equal(next.active, true); assert.notEqual(old.id, next.id);
  assert.equal(f.messages.size, 1); assert.equal(f.hides.size, 1); assert.equal(f.ports.length, 2);
  assert.equal(f.ports[0].disconnected, true); assert.equal(f.ports[0].replies.size, 0); assert.equal(f.ports[0].disconnects.size, 0);
  assert.equal(f.ports[0].sent.at(-1).internal, 'audio-pagehide');
  f.invalidations[0](); assert.equal(next.active, true); assert.equal(f.ports[1].disconnected, false);
  f.invalidations[1]();
  assert.equal(next.active, false); assert.equal(f.messages.size, 0); assert.equal(f.hides.size, 0); assert.equal(f.pings.size, 0); assert.equal(f.registry.current, undefined);
  assert.equal(f.ports[1].disconnected, true);
});

test('ordinary port sleep reconnects on the next request with the same document token and no timer', () => {
  const f = fixture(), instance = mountContentBridge(f.options()); f.request();
  f.ports[0].disconnect(); f.request();
  assert.equal(f.ports.length, 2);
  assert.deepEqual(f.ports[1].sent[0], { internal: 'audio-document', documentToken: instance.id });
  assert.equal(f.messages.size, 1); assert.equal(f.hides.size, 1);
});

test('internal control messages and requests after leaving monitor are not bridged', () => {
  const f = fixture(); mountContentBridge(f.options());
  f.request({ internal: 'audio-pagehide' }); assert.equal(f.ports.length, 0);
  f.disallow(); f.request(); assert.equal(f.ports.length, 0);
});

test('internal ping announces readiness without opening a port, and its listener is removed on invalidation', () => {
  const f = fixture(), instance = mountContentBridge(f.options());
  const ping = [...f.pings][0];
  assert.deepEqual(ping(), { extensionVersion: '0.1.2', bridgeId: instance.id });
  assert.equal(f.posted.length, 2); assert.equal(f.ports.length, 0);
  f.invalidations[0](); assert.equal(f.pings.size, 0); assert.equal(ping(), undefined);
});
