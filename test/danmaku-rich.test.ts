import assert from 'node:assert/strict';
import { test } from 'node:test';
import { danmakuAssetUrl, normalizeDanmaku } from '../client/multiview/danmaku/normalize.js';
import { DanmakuImageBudget, DANMAKU_IMAGE_LIMITS, DANMAKU_IMAGE_LOAD_TIMEOUT_MS, isDanmakuPickerPreview } from '../client/multiview/danmaku/DanmakuImage.js';
import type { DanmakuMessage } from '../client/multiview/danmaku/types.js';

const normalized = (value: unknown): DanmakuMessage => {
  const event = normalizeDanmaku('10', value, 2_000_000)[0];
  assert.equal(event?.type, 'message');
  if (event.type !== 'message') throw new Error('Expected message');
  return event.message;
};
const dm = (user: unknown[], extra?: unknown, more: unknown[] = []) => ({ cmd: 'DANMU_MSG', info: [[0, 1, 25, 0xffffff, 1000, 'id', 0, 0, 0, 0, 0, 0, 0, 0, 0, extra], '正文', user, ...more] });
class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sources: string[] = [];
  removed: string[] = [];
  private source?: string;
  get src() { return this.source ?? ''; }
  set src(value: string) { this.source = value; this.sources.push(value); }
  removeAttribute(name: string) { this.removed.push(name); if (name === 'src') this.source = undefined; }
}

test('rich sender projection preserves unknown versus explicit role and distinguishes a medal from this room role', () => {
  const unknown = normalized(dm([123, '正常*名字']));
  assert.equal(unknown.userIdentity, 'full');
  assert.equal(unknown.userId, '123');
  assert.equal(unknown.guardLevel, undefined);
  assert.equal(unknown.isModerator, undefined);
  const info: unknown[] = [[], '正文', [123, '昵称', 0], [20, '他房勋章', '', 99, 0xff00ff, '', 0, 0, 0, 0, 3, 1, 456], [], [], [], 0];
  const explicit = normalized({ cmd: 'DANMU_MSG', info });
  assert.equal(explicit.guardLevel, 0);
  assert.equal(explicit.isModerator, false);
  assert.equal(explicit.medal?.guardLevel, 3);
  assert.equal(explicit.medal?.targetRoomId, '99');
  assert.equal(explicit.roleRoomId, '10');
});

test('mystery identity cannot be restored with legacy UID, public face or structured real name', () => {
  const message = normalized(dm([123, '旧实名', 1], { user: { uid: 123, base: { name: '神秘人', is_mystery: true, face: 'https://i0.hdslb.com/avatar.jpg' } } }));
  assert.equal(message.userName, '神秘人');
  assert.equal(message.userIdentity, 'masked');
  assert.equal(message.userId, undefined);
  assert.equal(message.avatarUrl, undefined);
  assert.equal(message.isModerator, undefined);
  assert.equal(message.medal, undefined);
});

test('sender identity never borrows a conflicting UID and room mirror roles retain their source', () => {
  const message = normalized(dm([456, 'legacy'], { user: { uid: 123, base: { name: 'structured' } }, source_room_id: 99, is_mirror: 1 }));
  assert.equal(message.userName, 'structured');
  assert.equal(message.userId, '123');
  assert.equal(message.roleRoomId, '99');
  assert.equal(message.sourceRoomId, '99');
  const anonymous = normalized(dm([0, '用户*'], { extra: JSON.stringify({ is_mystery: true, user: { uid: 0, base: { name: '不得替换的后备昵称' } } }) }));
  assert.equal(anonymous.userName, '用户*');
  assert.equal(anonymous.userIdentity, 'masked');
});

test('asset URLs stay on direct HTTPS Bilibili CDNs and reject credential, fragment, proxy and malformed URLs', () => {
  assert.equal(danmakuAssetUrl('//i0.hdslb.com/a.png'), 'https://i0.hdslb.com/a.png');
  assert.equal(danmakuAssetUrl('https://i0.biliimg.com/a.webp'), 'https://i0.biliimg.com/a.webp');
  assert.equal(danmakuAssetUrl('http://i0.hdslb.com/a'), 'https://i0.hdslb.com/a');
  assert.equal(danmakuAssetUrl('http://i0.biliimg.com:80/a'), 'https://i0.biliimg.com/a');
  const longUrl = 'https://i0.biliimg.com/bfs/live/' + 'a'.repeat(1300) + '.png';
  assert.equal(danmakuAssetUrl(longUrl), longUrl, 'valid catalogue URLs are accepted by the rendering layer too');
  for (const value of [longUrl + 'a'.repeat(800), 'https://i0.hdslb.com/a b.png', 'https://i0.hdslb.com\\a.png']) assert.equal(danmakuAssetUrl(value), undefined);
  for (const url of ['http://i0.hdslb.com:443/a', 'http://i0.hdslb.com:8080/a', 'http://name@i0.hdslb.com/a', 'http://i0.hdslb.com/a#x', 'https://i0.hdslb.com:444/a', 'https://name@i0.hdslb.com/a', 'https://i0.hdslb.com/a#x', 'https://hdslb.com.evil.test/a', '/api/avatar?uid=1', 'data:image/png;base64,x', 'https://evil.test/a']) assert.equal(danmakuAssetUrl(url), undefined, url);
});

test('rich text keeps a bounded segment list and falls back to readable plain text', () => {
  const text = '[笑]abc'.repeat(70);
  const message = normalized({ cmd: 'DANMU_MSG', info: [[0, 0, 0, 0, 0, 'id', 0, 0, 0, 0, 0, 0, 0, 0, 0, { extra: JSON.stringify({ emots: { '[笑]': { url: '//i0.hdslb.com/emote.png', width: 20, height: 20 } } }) }], text, []] });
  assert.ok(message.segments!.length <= 32);
  assert.equal(message.segments!.map(part => part.text).join(''), text);
  assert.ok(new TextEncoder().encode(JSON.stringify(message)).length <= 16 * 1024);
  const invalid = normalized({ cmd: 'DANMU_MSG', info: [[0, 0, 0, 0, 0, '', 0, 0, 0, 0, 0, 0, 1, { url: 'https://evil.test/emote' }], '[图片表情]', []] });
  assert.equal(invalid.segments?.[0].type, 'emote');
  assert.equal(invalid.segments?.[0].url, undefined);
  assert.equal(invalid.segments?.[0].text, '[图片表情]');
  assert.deepEqual(normalizeDanmaku('10', { cmd: 'DANMU_MSG', dm_v2: 'unrecognized-protobuf' }), []);
});

test('ordinary messages avoid serialization allocations while oversized rich messages still keep the exact limit', t => {
  const stringify = JSON.stringify.bind(JSON);
  let serializations = 0;
  t.mock.method(JSON, 'stringify', (...args: Parameters<typeof JSON.stringify>) => { serializations++; return stringify(...args); });
  for (const text of ['普通文字'.repeat(100), '\u0000'.repeat(500), '\ud800'.repeat(500), '😀'.repeat(250)]) {
    const message = normalized({ cmd: 'DANMU_MSG', info: [[], text, [123, '完整昵称']] });
    assert.equal(message.text, text);
    assert.ok(new TextEncoder().encode(stringify(message)).length <= 16 * 1024);
  }
  assert.equal(serializations, 0, 'plain text requires no JSON string or UTF-8 allocation');
  const content = '[笑]'.repeat(100), url = `https://i0.hdslb.com/${'a'.repeat(970)}.png`;
  const message = normalized({ cmd: 'DANMU_MSG', info: [[0, 0, 0, 0, 0, '', 0, 0, 0, 0, 0, 0, 0, 0, 0,
    { extra: { emots: { '[笑]': { url } } } }], content, [123, '昵称']] });
  assert.equal(serializations, 1, 'only a potentially oversized rich projection needs the exact check');
  assert.equal(message.text, content);
  assert.equal(message.segments, undefined);
  assert.ok(new TextEncoder().encode(stringify(message)).length <= 16 * 1024);
});

test('SC highlight end times and durations never become a chat-history expiry', () => {
  const sc = (extra: object) => normalized({ cmd: 'SUPER_CHAT_MESSAGE', data: { id: 1, message: 'SC', start_time: 1000, user_info: { uname: '昵称' }, ...extra } });
  for (const extra of [{ end_time: 1100 }, { end_time: 900, time: 60 }, { time: 60 }, { price: 30, time: 60 }, { price: 1000, time: 1800 }, {}]) {
    const message = sc(extra);
    assert.equal('expiresAt' in message, false);
    assert.equal(message.sourceTime, 1_000_000);
    assert.equal(message.text, 'SC');
  }
});

test('image loader bounds loading, active and dynamic slots and retains detached in-flight requests', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const created: FakeImage[] = [];
  const budget = new DanmakuImageBudget(() => { const image = new FakeImage(); created.push(image); return image as unknown as HTMLImageElement; });
  const releases = Array.from({ length: 80 }, (_, i) => budget.request(`https://i0.hdslb.com/${i}.png`, false, () => {}));
  assert.equal(budget.snapshot().loading, 4);
  releases[0]();
  assert.equal(budget.snapshot().loading, 4, 'unmounted loading image still occupies its network slot');
  for (let cycle = 0; cycle < 20; cycle++) {
    for (const image of created) image.onload?.();
    await Promise.resolve();
    assert.ok(budget.snapshot().loading <= 4);
    assert.ok(budget.snapshot().active <= 64);
  }
  assert.equal(budget.snapshot().active, DANMAKU_IMAGE_LIMITS.active - DANMAKU_IMAGE_LIMITS.avatarReserved);
  for (const release of releases) release();
  for (const image of created) image.onload?.();
  await Promise.resolve();
  assert.equal(budget.snapshot().active, 0);
  const dynamicBudget = new DanmakuImageBudget(() => new FakeImage() as unknown as HTMLImageElement);
  const dynamicReleases = Array.from({ length: 300 }, (_, i) => dynamicBudget.request(`https://i0.hdslb.com/${i}.gif`, true, () => {}));
  assert.equal(dynamicBudget.snapshot().dynamic, DANMAKU_IMAGE_LIMITS.dynamic);
  assert.equal(dynamicBudget.snapshot().waiting, DANMAKU_IMAGE_LIMITS.waiting);
  for (const release of dynamicReleases) release();
  t.mock.timers.tick(DANMAKU_IMAGE_LOAD_TIMEOUT_MS);
  await Promise.resolve();
  assert.deepEqual(dynamicBudget.snapshot(), { loading: 0, active: 0, dynamic: 0, waiting: 0 });
});

test('stalled images expire, cancel their resource without a site request, release every slot and ignore late callbacks', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const created: FakeImage[] = [];
  let ready = 0;
  const budget = new DanmakuImageBudget(() => { const image = new FakeImage(); created.push(image); return image as unknown as HTMLImageElement; });
  for (let i = 0; i < 4; i++) budget.request(`https://i0.hdslb.com/stalled-${i}.gif`, true, () => { ready++; });
  const lateLoad = created[0].onload!, lateError = created[0].onerror!;
  t.mock.timers.tick(DANMAKU_IMAGE_LOAD_TIMEOUT_MS - 1);
  assert.equal(budget.snapshot().loading, 4);
  t.mock.timers.tick(1);
  await Promise.resolve();
  assert.deepEqual(budget.snapshot(), { loading: 0, active: 0, dynamic: 0, waiting: 0 });
  for (const image of created) {
    assert.equal(image.onload, null); assert.equal(image.onerror, null); assert.equal(image.src, '');
    assert.deepEqual(image.removed, ['src']);
    assert.equal(image.sources.length, 1, 'cancel by removing src, never assigning empty/current-page URL');
    assert.match(image.sources[0], /^https:\/\/i0\.hdslb\.com\//);
  }
  lateLoad(); lateError();
  assert.equal(ready, 0, 'a timed out image must keep its text/avatar placeholder');
  const release = budget.request('https://i0.hdslb.com/recovered.png', false, () => { ready++; }, 'content');
  assert.equal(budget.snapshot().loading, 1);
  created.at(-1)!.onload!();
  assert.equal(ready, 1);
  release();
  t.mock.timers.tick(DANMAKU_IMAGE_LOAD_TIMEOUT_MS);
  await Promise.resolve();
  assert.deepEqual(budget.snapshot(), { loading: 0, active: 0, dynamic: 0, waiting: 0 });
});

test('message emotes overtake queued avatars and picker images even when the waiting queue is full', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const created: FakeImage[] = [];
  const budget = new DanmakuImageBudget(() => { const image = new FakeImage(); created.push(image); return image as unknown as HTMLImageElement; });
  const releases = Array.from({ length: 4 + DANMAKU_IMAGE_LIMITS.waiting }, (_, i) => budget.request(`https://i0.hdslb.com/avatar-${i}.png`, false, () => {}, 'decorative'));
  assert.equal(budget.snapshot().waiting, DANMAKU_IMAGE_LIMITS.waiting);
  releases.push(budget.request('https://i0.hdslb.com/message-emote.png', false, () => {}, 'content'));
  assert.equal(budget.snapshot().waiting, DANMAKU_IMAGE_LIMITS.waiting, 'admission replaces only a waiting decorative ticket');
  assert.equal(created.length, 4, 'priority does not cancel an already loading resource');
  created[0].onload!();
  await Promise.resolve();
  assert.equal(created[4].src, 'https://i0.hdslb.com/message-emote.png');
  assert.ok(budget.snapshot().loading <= 4); assert.ok(budget.snapshot().active <= 64); assert.ok(budget.snapshot().dynamic <= 4);
  for (const release of releases) release();
  t.mock.timers.tick(DANMAKU_IMAGE_LOAD_TIMEOUT_MS);
  await Promise.resolve();
  assert.deepEqual(budget.snapshot(), { loading: 0, active: 0, dynamic: 0, waiting: 0 });
});

test('visible avatars retain reserved active slots after message images fill their budget', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const created: FakeImage[] = [];
  const budget = new DanmakuImageBudget(() => { const image = new FakeImage(); created.push(image); return image as unknown as HTMLImageElement; });
  const releases = Array.from({ length: 80 }, (_, index) => budget.request(`https://i0.hdslb.com/content-${index}.png`, false, () => {}, 'content'));
  for (let cycle = 0; cycle < 20; cycle++) { for (const image of created) image.onload?.(); await Promise.resolve(); }
  assert.equal(budget.snapshot().active, 32);
  let ready = false;
  releases.push(budget.request('https://i0.hdslb.com/current-avatar.png', false, () => { ready = true; }, 'avatar'));
  assert.equal(created.at(-1)!.src, 'https://i0.hdslb.com/current-avatar.png');
  created.at(-1)!.onload!(); assert.equal(ready, true);
  assert.equal(budget.snapshot().active, 33);
  for (const release of releases) release();
  t.mock.timers.tick(DANMAKU_IMAGE_LOAD_TIMEOUT_MS); await Promise.resolve();
  assert.deepEqual(budget.snapshot(), { loading: 0, active: 0, dynamic: 0, waiting: 0 });
});


test('native preview detection only accepts bounded direct CDN still URLs', () => {
  assert.equal(isDanmakuPickerPreview('https://i0.hdslb.com/bfs/emote/safe.webp@96w_96h.png?version=1'), true);
  for (const value of ['https://evil.test/bfs/a.png@96w_96h.png', 'https://i0.hdslb.com/bfs/emote/raw.png',
    'https://i0.hdslb.com/bfs/emote/a.webp', '/api/emote']) assert.equal(isDanmakuPickerPreview(value), false, value);
});

test('originals share an in-flight image and cancelled consumers cannot receive late completion', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const created: FakeImage[] = [];
  const budget = new DanmakuImageBudget(() => { const image = new FakeImage(); created.push(image); return image as unknown as HTMLImageElement; });
  let ready = 0;
  const url = 'https://i0.hdslb.com/bfs/emote/original.png';
  const closed = budget.request(url, false, () => { ready++; }, 'decorative');
  const visible = budget.request(url, false, () => { ready++; }, 'content');
  closed();
  const reopened = budget.request(url, false, () => { ready++; }, 'decorative');
  assert.equal(created.length, 1);
  assert.equal(budget.snapshot().loading, 1);
  created[0].onload!();
  assert.equal(ready, 2, 'only the two mounted consumers receive the shared result');
  visible(); reopened(); await Promise.resolve();
  assert.deepEqual(budget.snapshot(), { loading: 0, active: 0, dynamic: 0, waiting: 0 });
});

test('a picker original blocked by active content ends in capacity fallback after twelve seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const created: FakeImage[] = [], failures: string[] = [];
  const budget = new DanmakuImageBudget(() => { const image = new FakeImage(); created.push(image); return image as unknown as HTMLImageElement; });
  const releases = Array.from({ length: 32 }, (_, index) => budget.request('https://i0.hdslb.com/content-' + index + '.png', false, () => {}, 'content'));
  for (let cycle = 0; cycle < 8; cycle++) { for (const image of created) image.onload?.(); await Promise.resolve(); }
  assert.equal(budget.snapshot().active, 32);
  const before = created.length;
  releases.push(budget.request('https://i0.hdslb.com/bfs/emote/raw.png', false, () => assert.fail('blocked original must not become ready'), 'picker', reason => failures.push(reason)));
  assert.equal(budget.snapshot().waiting, 1);
  t.mock.timers.tick(DANMAKU_IMAGE_LOAD_TIMEOUT_MS - 1);
  assert.deepEqual(failures, []);
  t.mock.timers.tick(1); await Promise.resolve();
  assert.deepEqual(failures, ['capacity']);
  assert.equal(created.length, before, 'an expired waiting original never starts a network request');
  assert.equal(budget.snapshot().waiting, 0);
  for (const release of releases) release();
  assert.deepEqual(budget.snapshot(), { loading: 0, active: 0, dynamic: 0, waiting: 0 });
});

test('closing fallback images cancels waiting work but retains four detached network slots until settlement', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const created: FakeImage[] = [];
  const budget = new DanmakuImageBudget(() => { const image = new FakeImage(); created.push(image); return image as unknown as HTMLImageElement; });
  let ready = 0;
  const releases = Array.from({ length: 80 }, (_, index) => budget.request('https://i0.hdslb.com/original-' + index + '.png', false, () => { ready++; }, 'picker'));
  const late = created[0].onload!;
  for (const release of releases) release();
  assert.deepEqual(budget.snapshot(), { loading: 4, active: 4, dynamic: 0, waiting: 0 });
  t.mock.timers.tick(DANMAKU_IMAGE_LOAD_TIMEOUT_MS); await Promise.resolve();
  late();
  assert.equal(ready, 0);
  assert.equal(created.length, 4, 'closed consumers never launch the cancelled queue');
  assert.deepEqual(budget.snapshot(), { loading: 0, active: 0, dynamic: 0, waiting: 0 });
});
