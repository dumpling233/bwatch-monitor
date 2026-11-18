import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlaybackRequestBudget, PlaybackRequestPool } from '../client/multiview/playbackRequestPool';
import { validatePreferences } from '../client/multiview/preferences';
import type { PlaybackInfo } from '../shared/playback';
import type { PlaybackResolveRequest } from '../client/multiview/localLoginProvider';

const flush = () => new Promise(resolve => setImmediate(resolve));
const info = (id: string): PlaybackInfo => ({ roomId: id, status: 'live', requestedQuality: 250,
  qualities: [], sources: [], resolvedAt: 1 });
const request = (roomId: string, signal = new AbortController().signal): PlaybackResolveRequest =>
  ({ roomId, signal, source: 'custom', qn: 250, force: false });

test('page resolver merges same scope work and admits at most two requests', async () => {
  const calls: string[] = [], releases = new Map<string, (value: PlaybackInfo) => void>();
  const pool = new PlaybackRequestPool(req => { calls.push(req.roomId); return new Promise(resolve => releases.set(req.roomId, resolve)); });
  const first = pool.resolve(request('1')), duplicate = pool.resolve({ ...request('1'), force: true });
  const second = pool.resolve(request('2')), queued = pool.resolve(request('3'));
  await flush(); assert.deepEqual(calls, ['1', '2']);
  releases.get('1')!(info('1')); await first; await duplicate; await flush();
  assert.deepEqual(calls, ['1', '2', '3']);
  releases.get('2')!(info('2')); releases.get('3')!(info('3'));
  await Promise.all([second, queued]); pool.dispose();
});

test('one cancelled consumer does not cancel another sharing the same work', async () => {
  let signal: AbortSignal | undefined, release!: (value: PlaybackInfo) => void;
  const pool = new PlaybackRequestPool(req => { signal = req.signal; return new Promise(resolve => { release = resolve; }); });
  const abort = new AbortController();
  const cancelled = pool.resolve(request('1', abort.signal));
  const survivor = pool.resolve(request('1'));
  const rejection = assert.rejects(cancelled, { name: 'AbortError' });
  await flush(); abort.abort(); await rejection; assert.equal(signal!.aborted, false);
  release(info('1')); assert.equal((await survivor).roomId, '1'); pool.dispose();
});

test('cancelled uncooperative resolver releases the queue and its late result cannot overwrite new work', async () => {
  let late!: (value: PlaybackInfo) => void;
  const calls: string[] = [];
  const pool = new PlaybackRequestPool(req => {
    calls.push(req.roomId);
    return req.roomId === '1' ? new Promise(resolve => { late = resolve; }) : Promise.resolve(info(req.roomId));
  }, 1);
  const abort = new AbortController();
  const first = pool.resolve(request('1', abort.signal));
  const rejection = assert.rejects(first, { name: 'AbortError' });
  const next = pool.resolve(request('2')); await flush(); abort.abort(); await rejection;
  assert.equal((await next).roomId, '2'); late(info('1')); await flush();
  assert.deepEqual(calls, ['1', '2']); pool.dispose();
});

test('requested qualities isolate requests while equal requests merge and completed results are not cached', async () => {
  const calls: string[] = [];
  const pool = new PlaybackRequestPool(async req => { calls.push(`${req.source}:${req.qn}`); return info(req.roomId); });
  await Promise.all([pool.resolve(request('1')), pool.resolve(request('1')),
    pool.resolve({ ...request('1'), qn: 10000 })]);
  await pool.resolve(request('1'));
  assert.deepEqual(calls.sort(), ['custom:10000', 'custom:250', 'custom:250']); pool.dispose();
});

test('identity disposal rejects active and queued consumers and isolates replacement pool', async () => {
  let signal: AbortSignal | undefined;
  const old = new PlaybackRequestPool(req => { signal = req.signal; return new Promise(() => {}); }, 1);
  const first = old.resolve(request('1')), queued = old.resolve(request('2'));
  const rejections = Promise.all([assert.rejects(first, { name: 'AbortError' }), assert.rejects(queued, { name: 'AbortError' })]);
  await flush(); old.dispose(); await rejections; assert.equal(signal!.aborted, true);
  const fresh = new PlaybackRequestPool(async req => info(req.roomId));
  assert.equal((await fresh.resolve(request('1'))).roomId, '1');
  await assert.rejects(old.resolve(request('1')), { name: 'AbortError' }); fresh.dispose();
});

test('saved future quality survives while legacy format restrictions and route URLs are discarded', () => {
  const saved = validatePreferences({ version: 1, roomIds: ['1', '2'], rooms: {
    '1': { quality: 50000, format: 'hls-fmp4', url: 'https://example.invalid/private' },
    '2': { quality: -1, format: 'arbitrary' },
  } });
  assert.equal(saved.rooms['1'].quality, 50000); assert.equal('format' in saved.rooms['1'], false);
  assert.equal('url' in saved.rooms['1'], false);
  assert.equal(saved.rooms['2'].quality, 0); assert.equal('format' in saved.rooms['2'], false);
});

test('RPC epochs do not share in-flight work within the same verified media identity', async () => {
  let calls = 0;
  const pool = new PlaybackRequestPool(async req => { calls++; return info(req.roomId); });
  await Promise.all([pool.resolve(request('1'), 'worker-old'), pool.resolve(request('1'), 'worker-new')]);
  assert.equal(calls, 2); pool.dispose();
});

test('automatic metadata occupies at most one slot while queued playback has priority', async () => {
  const calls: string[] = [], releases = new Map<string, (value: PlaybackInfo) => void>();
  const pool = new PlaybackRequestPool(req => { calls.push(req.roomId); return new Promise(resolve => releases.set(req.roomId, resolve)); });
  const first = pool.resolve(request('1'), '', 'metadata');
  const nextMetadata = pool.resolve(request('2'), '', 'metadata');
  const media = pool.resolve(request('3'));
  const nextMedia = pool.resolve(request('4'));
  await flush(); assert.deepEqual(calls, ['1', '3']);
  releases.get('3')!(info('3')); await media; await flush();
  assert.deepEqual(calls, ['1', '3', '4']);
  releases.get('1')!(info('1')); await first; await flush();
  assert.deepEqual(calls, ['1', '3', '4', '2']);
  releases.get('2')!(info('2')); releases.get('4')!(info('4'));
  await Promise.all([nextMetadata, nextMedia]); pool.dispose();
});

test('metadata and playback share identical in-flight work without duplicating the request', async () => {
  let calls = 0, release!: (value: PlaybackInfo) => void;
  const pool = new PlaybackRequestPool(() => { calls++; return new Promise(resolve => { release = resolve; }); });
  const metadata = pool.resolve(request('1'), 'rpc', 'metadata');
  const media = pool.resolve(request('1'), 'rpc');
  await flush(); assert.equal(calls, 1); release(info('1')); await Promise.all([metadata, media]); pool.dispose();
});

test('upstream Retry-After blocks queued metadata and later playback without additional requests', async () => {
  let calls = 0;
  const pool = new PlaybackRequestPool(async () => { calls++; throw Object.assign(new Error('limited'), { status: 429, retryAfter: 30 }); });
  const first = pool.resolve(request('1'), '', 'metadata');
  const queued = pool.resolve(request('2'), '', 'metadata');
  await Promise.all([assert.rejects(first, { status: 429 }), assert.rejects(queued, { status: 429 })]);
  await assert.rejects(pool.resolve(request('3')), { status: 429 });
  assert.equal(calls, 1); pool.dispose();
});

test('page budget preserves API and CDN cooldown across identity or permission pool replacement', async () => {
  const budget = new PlaybackRequestBudget(); let calls = 0;
  const resolver = async (req: PlaybackResolveRequest) => { calls++; return info(req.roomId); };
  const old = new PlaybackRequestPool(resolver, 2, budget);
  old.block(45, 412); old.dispose();
  const fresh = new PlaybackRequestPool(resolver, 2, budget);
  await assert.rejects(fresh.resolve(request('1'), 'new-account', 'metadata'), error => {
    const detail = error as Error & { status: number; retryAfter: number };
    return detail.status === 412 && detail.retryAfter >= 44;
  });
  assert.equal(calls, 0); fresh.dispose();
});

test('rolling menu budget survives pool replacement, recovers on time, and reserves playback outside the menu budget', async () => {
  const originalNow = Date.now; let now = 1_000, calls = 0;
  Date.now = () => now;
  const budget = new PlaybackRequestBudget();
  let pool = new PlaybackRequestPool(async req => { calls++; return info(req.roomId); }, 2, budget);
  try {
    for (let i = 1; i <= 30; i++) await pool.resolve(request(String(i)), 'worker', 'metadata');
    pool.dispose(); pool = new PlaybackRequestPool(async req => { calls++; return info(req.roomId); }, 2, budget);
    await assert.rejects(pool.resolve(request('31'), 'new-worker', 'metadata'), error => {
      const detail = error as Error & { metadataBudget?: boolean; retryAfter?: number };
      return detail.metadataBudget === true && detail.retryAfter === 60;
    });
    assert.equal(calls, 30);
    await pool.resolve(request('32')); assert.equal(calls, 31);
    now += 60_000;
    await pool.resolve(request('33'), 'new-worker', 'metadata'); assert.equal(calls, 32);
  } finally { pool.dispose(); Date.now = originalNow; }
});
