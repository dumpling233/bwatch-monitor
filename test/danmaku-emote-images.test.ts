import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DanmakuImageBudget, DanmakuImageRecovery, DANMAKU_IMAGE_LIMITS, DANMAKU_IMAGE_LOAD_TIMEOUT_MS } from '../client/multiview/danmaku/DanmakuImage.js';
import { emotePreview } from '../client/multiview/danmaku/emotePreview.js';

class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  src = '';
  removeAttribute(name: string) { if (name === 'src') this.src = ''; }
}
const raw = 'https://i0.hdslb.com/bfs/emote/room.webp';
const still = `${raw}@96w_96h.png`;

test('message previews retain explicit animation while unknown WebP originals are conservatively bounded', () => {
  assert.deepEqual(emotePreview(undefined, false, true), { url: '', dynamic: false });
  assert.deepEqual(emotePreview(raw), { url: still, dynamic: false, fallbackUrl: raw, fallbackDynamic: true });
  assert.deepEqual(emotePreview(raw, true, true), { url: raw, dynamic: true, staticFallbackUrl: still, fallbackUrl: raw, fallbackDynamic: true });
  const gif = 'https://i0.hdslb.com/bfs/emote/room.gif';
  assert.equal(emotePreview(gif, false, true).dynamic, true, 'GIF remains animated even if its metadata omits the flag');
  assert.deepEqual(emotePreview(still), { url: still, dynamic: false }, 'already transformed URLs are not transformed twice');
  assert.equal(emotePreview('https://example.com/room.webp').url, '', 'no untrusted or site fallback image is constructed');
});

test('safe CDN size variants share one still URL without changing the origin, query or original fallback', () => {
  const base = 'https://i0.biliimg.com/bfs/emote/room.webp';
  const query = '?token=a%2Fb%2Bc&v=2&width=120';
  const expected = `${base}@96w_96h.png${query}`;
  for (const suffix of ['', '@100w_100h.webp', '@120w_120h_1c.png', '@!small-1.webp']) {
    const original = `${base}${suffix}${query}`;
    const preview = emotePreview(original);
    assert.equal(preview.url, expected, suffix);
    assert.equal(preview.dynamic, false);
    assert.equal(preview.fallbackUrl, original);
    assert.equal(preview.fallbackDynamic, !suffix.endsWith('.png'));
    assert.equal(new URL(preview.url).origin, new URL(original).origin);
    assert.equal(new URL(preview.url).search, query);
  }
  assert.deepEqual(emotePreview(expected), { url: expected, dynamic: false }, 'exactly sized inputs keep the existing object contract');
});

test('known animated size variants keep the upstream animation and only normalize their still fallback', () => {
  const original = 'https://i0.hdslb.com/bfs/emote/room.gif@100w_100h.webp?sign=keep%2Fbytes';
  const normalized = 'https://i0.hdslb.com/bfs/emote/room.gif@96w_96h.png?sign=keep%2Fbytes';
  assert.deepEqual(emotePreview(original, true, true), { url: original, dynamic: true, staticFallbackUrl: normalized,
    fallbackUrl: original, fallbackDynamic: true });
  assert.deepEqual(emotePreview(original, true), { url: normalized, dynamic: false, fallbackUrl: original, fallbackDynamic: true });
  const gif = 'https://i0.hdslb.com/bfs/emote/room.gif?filename=still.png';
  assert.equal(emotePreview(gif, false, true).url, gif, 'a query does not hide the source GIF type');
});

test('uncertain transform paths remain untouched rather than receiving a second suffix', () => {
  for (const url of ['https://i0.hdslb.com/bfs/emote/room.png@100w/100h.webp',
    'https://i0.hdslb.com/bfs/emote/room.png@100w%2F100h.webp',
    'https://i0.hdslb.com/bfs/emote/room.png@100w_100h.webp@80w.png',
    'https://i0.hdslb.com/assets/room.png@100w_100h.webp']) {
    const preview = emotePreview(url);
    assert.equal(preview.url, url);
    assert.equal(preview.fallbackUrl, undefined);
    assert.equal(preview.staticFallbackUrl, undefined);
  }
});

test('eight animated message owners keep four animations and send overflow to the native still path', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const created: FakeImage[] = [], releases: Array<() => void> = [], ready: string[] = [];
  const budget = new DanmakuImageBudget(() => { const image = new FakeImage(); created.push(image); return image as unknown as HTMLImageElement; });
  for (let index = 0; index < 8; index++) {
    const recovery = new DanmakuImageRecovery({ url: raw, dynamic: true }, 'content', { url: still, dynamic: false }, { url: raw, dynamic: true });
    const request = () => {
      const source = recovery.current;
      // Bounded stills belong to native img, not the fallback preloader budget.
      if (source.url === still && !source.dynamic) { ready.push(source.url); return; }
      releases.push(budget.request(source.url, source.dynamic, () => ready.push(source.url), 'content', reason => {
        const next = recovery.failure(reason);
        assert.equal(next.kind, 'source');
        request();
      }, true));
    };
    request();
  }
  await Promise.resolve();
  assert.equal(budget.snapshot().dynamic, DANMAKU_IMAGE_LIMITS.dynamic);
  for (let pass = 0; pass < 4; pass++) {
    for (const image of created) image.onload?.();
    await Promise.resolve();
    assert.ok(budget.snapshot().loading <= 4);
    assert.ok(budget.snapshot().active <= 64);
    assert.ok(budget.snapshot().dynamic <= 4);
  }
  assert.equal(ready.length, 8);
  assert.equal(ready.filter(url => url === raw).length, 4);
  assert.equal(ready.filter(url => url === still).length, 4);
  assert.equal(created.length, 1, 'only the animated URL uses an in-flight preloader');
  assert.equal(budget.snapshot().active, 4, 'native stills consume no original or animation admission');
  assert.equal(budget.snapshot().waiting, 0);
  for (const release of releases) release();
  assert.deepEqual(budget.snapshot(), { loading: 0, active: 0, dynamic: 0, waiting: 0 });
});

test('a cancelled overflow row cannot start a still request after its deferred admission callback', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const created: FakeImage[] = [], releases: Array<() => void> = [];
  const budget = new DanmakuImageBudget(() => { const image = new FakeImage(); created.push(image); return image as unknown as HTMLImageElement; });
  for (let index = 0; index < 4; index++) releases.push(budget.request(raw, true, () => {}, 'content'));
  let disposed = false;
  const release = budget.request(raw, true, () => {}, 'content', () => {
    if (!disposed) releases.push(budget.request(still, false, () => {}, 'content'));
  }, true);
  disposed = true; release();
  await Promise.resolve();
  assert.equal(created.length, 1, 'the four animation instances share a single URL load');
  assert.equal(budget.snapshot().waiting, 0);
  for (const stop of releases) stop();
  t.mock.timers.tick(DANMAKU_IMAGE_LOAD_TIMEOUT_MS);
  await Promise.resolve();
  assert.deepEqual(budget.snapshot(), { loading: 0, active: 0, dynamic: 0, waiting: 0 });
});

test('a failed converted still tries the original at most once and cannot loop through an exhausted animation budget', () => {
  const recovery = new DanmakuImageRecovery({ url: still, dynamic: false }, 'content', undefined, { url: raw, dynamic: true });
  assert.deepEqual(recovery.failure('error'), { kind: 'source' });
  assert.deepEqual(recovery.current, { url: raw, dynamic: true });
  assert.deepEqual(recovery.failure('dynamic'), { kind: 'stop', failed: true });
  assert.deepEqual(recovery.failure('error'), { kind: 'stop', failed: true });
  assert.deepEqual(recovery.failure('error'), { kind: 'stop', failed: true });
});

test('a full animation budget switches to a still without recording a CDN error, and a failed still can try one original', () => {
  const recovery = new DanmakuImageRecovery({ url: raw, dynamic: true }, 'content', { url: still, dynamic: false }, { url: raw, dynamic: true });
  assert.deepEqual(recovery.failure('dynamic'), { kind: 'source' });
  assert.deepEqual(recovery.current, { url: still, dynamic: false });
  assert.deepEqual(recovery.failure('error'), { kind: 'source' });
  assert.deepEqual(recovery.current, { url: raw, dynamic: true });
  assert.deepEqual(recovery.failure('dynamic'), { kind: 'stop', failed: true });
});

test('content recovery permits one finite retry and keeps admission pressure distinct from a failed URL', () => {
  const network = new DanmakuImageRecovery({ url: raw, dynamic: false }, 'content');
  assert.deepEqual(network.failure('error'), { kind: 'retry', delay: 3_000 });
  for (let index = 0; index < 8; index++) assert.deepEqual(network.failure('error'), { kind: 'stop', failed: true });
  const admission = new DanmakuImageRecovery({ url: raw, dynamic: false }, 'content');
  assert.deepEqual(admission.failure('budget'), { kind: 'retry', delay: 1_000 });
  assert.deepEqual(admission.failure('budget'), { kind: 'stop', failed: false });
});

test('picker network errors get one delayed retry while admission pressure is not marked as a CDN failure', () => {
  const recovery = new DanmakuImageRecovery({ url: still, dynamic: false }, 'picker');
  assert.deepEqual(recovery.failure('budget'), { kind: 'retry', delay: 1_000 });
  assert.deepEqual(recovery.failure('error'), { kind: 'retry', delay: 3_000 });
  assert.deepEqual(recovery.failure('error'), { kind: 'stop', failed: true });
  const waiting = new DanmakuImageRecovery({ url: raw, dynamic: false }, 'picker');
  assert.deepEqual(waiting.failure('capacity'), { kind: 'stop', failed: true }, 'an expired original displays readable fallback instead of retrying forever');
});

test('existing budget callers retain queued animation semantics unless they explicitly opt into a still fallback', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const created: FakeImage[] = [], releases: Array<() => void> = [], failures: string[] = [];
  const budget = new DanmakuImageBudget(() => { const image = new FakeImage(); created.push(image); return image as unknown as HTMLImageElement; });
  for (let index = 0; index < 5; index++) releases.push(budget.request(raw, true, () => {}, 'content', reason => failures.push(reason)));
  await Promise.resolve();
  assert.equal(budget.snapshot().dynamic, 4);
  assert.equal(budget.snapshot().waiting, 1);
  assert.deepEqual(failures, []);
  for (const release of releases) release();
  t.mock.timers.tick(DANMAKU_IMAGE_LOAD_TIMEOUT_MS);
  await Promise.resolve();
  assert.equal(budget.snapshot().active, 0);
});
