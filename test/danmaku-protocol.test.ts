import assert from 'node:assert/strict';
import { test } from 'node:test';
import { brotliCompressSync, deflateSync } from 'node:zlib';
// Exercise the installed, patched browser entry, not a duplicate decoder.
import { LiveWS } from '@laplace.live/ws/browser';

function packet(operation: number, data: unknown, protocol = 0): Uint8Array<ArrayBuffer> {
  const body = data instanceof Uint8Array ? data : new TextEncoder().encode(JSON.stringify(data));
  const bytes = new Uint8Array(16 + body.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, bytes.length); view.setUint16(4, 16); view.setUint16(6, protocol); view.setUint32(8, operation); view.setUint32(12, 1);
  bytes.set(body, 16); return bytes;
}
function concat(...buffers: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(buffers.reduce((sum, b) => sum + b.length, 0));
  let offset = 0; for (const buffer of buffers) { bytes.set(buffer, offset); offset += buffer.length; } return bytes;
}
class Socket extends EventTarget {
  readyState = 1;
  binaryType = '';
  sent: unknown[] = [];
  close(): void { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  send(data: unknown): void { this.sent.push(data); }
  message(bytes: Uint8Array): void { this.dispatchEvent(new MessageEvent('message', { data: Uint8Array.from(bytes).buffer })); }
}
const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 20));
async function until(predicate: () => boolean, deadlineMs = 5000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail('Timed out waiting for browser protocol event');
    await tick();
  }
}
function connection() {
  const socket = new Socket();
  const live = new LiveWS(5440, { createWebSocket: () => socket as unknown as WebSocket, key: 'test', buvid: 'anonymous-test' });
  const messages: unknown[] = [];
  let errors = 0; let joins = 0;
  live.addEventListener('msg', event => messages.push(event.data));
  live.addEventListener('error', () => errors++); live.addEventListener('live', () => joins++);
  return { socket, live, messages, get errors() { return errors; }, get joins() { return joins; } };
}

test('patched browser client accepts only authentication code zero, including protocol 1 JSON', async () => {
  for (const code of [-101, -352, 1, undefined]) {
    const c = connection();
    c.socket.message(packet(8, code === undefined ? {} : { code }, 1));
    c.socket.message(packet(5, { cmd: 'DANMU_MSG', text: 'must not escape' }));
    await until(() => c.errors > 0); assert.equal(c.joins, 0); assert.equal(c.live.live, false); assert.equal(c.errors, 1); assert.equal(c.messages.length, 0);
    c.live.close();
  }
  const c = connection(); c.socket.message(packet(8, { code: 0 }, 1)); await until(() => c.joins > 0);
  assert.equal(c.joins, 1); assert.equal(c.live.live, true); c.live.close();
});

test('patched browser client serializes compressed frames and plain frames in arrival order', async () => {
  for (const protocol of [2, 3]) {
    const c = connection(); c.socket.message(packet(8, { code: 0 }));
    const first = packet(5, { cmd: 'DANMU_MSG', sequence: 1 });
    c.socket.message(packet(5, protocol === 2 ? deflateSync(first) : brotliCompressSync(first), protocol));
    c.socket.message(packet(5, { cmd: 'DANMU_MSG', sequence: 2 }));
    await until(() => c.messages.length >= 2); assert.deepEqual(c.messages.map((m: any) => m.sequence), [1, 2]); assert.equal(c.errors, 0); c.live.close();
  }
});

test('patched decoder closes malformed, zero-size, truncated, oversized and excessive packet frames', async () => {
  const zero = packet(5, {}); new DataView(zero.buffer).setUint32(0, 0);
  const header = packet(5, {}); new DataView(header.buffer).setUint16(4, 15);
  const pastEnd = packet(5, {}); new DataView(pastEnd.buffer).setUint32(0, 99999);
  const tooMany = concat(...Array.from({ length: 4097 }, () => packet(5, {})));
  for (const bytes of [zero, header, pastEnd, new Uint8Array(0), new Uint8Array(15), new Uint8Array(2097153), tooMany]) {
    const c = connection(); c.socket.message(bytes); await until(() => c.errors > 0); assert.equal(c.errors, 1); assert.equal(c.live.closed, true); c.live.close();
  }
});

test('patched decoder bounds nested compression and streaming deflate/Brotli output', async () => {
  let nested = packet(5, { cmd: 'DANMU_MSG' });
  for (let i = 0; i < 5; i++) nested = packet(5, deflateSync(nested), 2);
  const bomb = new Uint8Array(8388609);
  for (const bytes of [nested, packet(5, deflateSync(bomb), 2), packet(5, brotliCompressSync(bomb), 3)]) {
    const c = connection(); c.socket.message(bytes); await until(() => c.errors > 0);
    assert.equal(c.errors, 1); assert.equal(c.live.closed, true); c.live.close();
  }
});

test('close invalidates an outstanding asynchronous decode', async () => {
  const c = connection(); c.socket.message(packet(8, { code: 0 })); await tick();
  c.socket.message(packet(5, deflateSync(packet(5, { cmd: 'DANMU_MSG', text: 'late' })), 2));
  c.live.close(); await tick(); assert.deepEqual(c.messages, []); assert.equal(c.live.live, false);
});

test('patched client bounds aggregate raw frames awaiting serial decode', async () => {
  const c = connection();
  const bytes = packet(5, { cmd: 'DANMU_MSG', text: 'a'.repeat(1900000) });
  for (let i = 0; i < 5; i++) c.socket.message(bytes);
  await until(() => c.errors > 0);
  assert.equal(c.errors, 1); assert.equal(c.live.closed, true); assert.equal(c.messages.length, 0);
});

test('patched decoder shares an output budget across compressed siblings', async () => {
  const c = connection();
  const content = packet(5, { cmd: 'DANMU_MSG', text: 'a'.repeat(4500000) });
  c.socket.message(concat(packet(5, deflateSync(content), 2), packet(5, deflateSync(content), 2)));
  await until(() => c.errors > 0);
  assert.equal(c.errors, 1); assert.equal(c.live.closed, true); assert.equal(c.messages.length, 0);
});
