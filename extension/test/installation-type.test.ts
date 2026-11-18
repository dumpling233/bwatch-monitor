import assert from 'node:assert/strict';
import test from 'node:test';
import { createInstallationTypeReader, normalizeInstallationType } from '../lib/installationType';

test('installation classification only projects known browser values and never infers a store', () => {
  for (const value of ['development', 'normal', 'sideload'] as const) assert.equal(normalizeInstallationType(value), value);
  assert.equal(normalizeInstallationType('admin'), 'other'); assert.equal(normalizeInstallationType('other'), 'other');
  for (const value of [undefined, null, 'store', 'chrome_web_store', '', {}, 1]) assert.equal(normalizeInstallationType(value), 'unknown');
});

test('HELLO installation reads are lazy, share in-flight work and reuse one projected result', async () => {
  let calls = 0, release!: (value: unknown) => void;
  const getSelf = new Promise<unknown>(resolve => { release = resolve; });
  const read = createInstallationTypeReader(() => { calls++; return getSelf; });
  assert.equal(calls, 0);
  const first = read(), second = read(); assert.equal(first, second);
  await Promise.resolve(); assert.equal(calls, 1);
  release({ installType: 'development', id: 'private-extension-id', name: 'irrelevant', permissions: ['irrelevant'] });
  assert.equal(await first, 'development'); assert.equal(await read(), 'development'); assert.equal(calls, 1);
});

test('unavailable or malformed getSelf becomes unknown without failing HELLO or repeated probing', async () => {
  for (const source of [() => { throw new Error('not supported'); }, () => Promise.reject(new Error('unavailable')),
    () => Promise.resolve(undefined), () => Promise.resolve({ installType: 'future-type' }), () => Promise.resolve([])]) {
    let calls = 0;
    const read = createInstallationTypeReader(async () => { calls++; return source(); });
    assert.equal(await read(), 'unknown'); assert.equal(await read(), 'unknown'); assert.equal(calls, 1);
  }
});

test('a stalled browser read times out once and a late result cannot change the cached classification', async () => {
  let release!: (value: unknown) => void, calls = 0;
  const read = createInstallationTypeReader(() => { calls++; return new Promise(resolve => { release = resolve; }); }, 5);
  assert.equal(await read(), 'unknown');
  release({ installType: 'normal' }); await Promise.resolve();
  assert.equal(await read(), 'unknown'); assert.equal(calls, 1);
});
