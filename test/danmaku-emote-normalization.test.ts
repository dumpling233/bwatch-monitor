import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeDanmaku } from '../client/multiview/danmaku/normalize.js';
import type { DanmakuMessage } from '../client/multiview/danmaku/types.js';

// Encode public wire field numbers independently of the production decoder.
const varint = (value: number): number[] => {
  const bytes: number[] = [];
  do { const byte = value % 128; value = Math.floor(value / 128); bytes.push(byte | (value ? 128 : 0)); } while (value);
  return bytes;
};
const scalar = (field: number, value: number) => [...varint(field * 8), ...varint(value)];
const binary = (field: number, body: number[]) => [...varint(field * 8 + 2), ...varint(body.length), ...body];
const string = (field: number, value: string) => binary(field, [...new TextEncoder().encode(value)]);
const icon = (key: string, url: string, unique = 'room-emote', moving = false) => binary(14, [
  ...string(1, key), ...binary(2, [...string(1, unique), ...string(2, url), ...scalar(3, Number(moving)), ...scalar(6, 100), ...scalar(7, 100)]),
]);
const v2 = (...bytes: number[][]) => Buffer.from(bytes.flat()).toString('base64');
const legacy = (body = '房间表情', url = 'http://i0.hdslb.com/bfs/live/room.png') => ({
  cmd: 'DANMU_MSG', info: [[0, 1, 25, 0xffffff, 1000, 'sample-id', 0, 0, 0, 0, 0, 0, 1,
    { url, emoticon_unique: 'room-emote', width: 100, height: 100 }, 0, {}], body, [123, '完整昵称', 0]],
});
const message = (value: unknown): DanmakuMessage => {
  const event = normalizeDanmaku('10', value, 2000000)[0];
  assert.equal(event?.type, 'message');
  if (event.type !== 'message') throw new Error('Expected message');
  return event.message;
};

test('legacy HTTP large emotes upgrade safely and retain their explicit type and identifier', () => {
  const result = message(legacy());
  assert.equal(result.text, '房间表情');
  assert.equal(result.segments?.[0].type, 'emote');
  assert.equal(result.segments?.[0].unique, 'room-emote');
  assert.equal(result.segments?.[0].url, 'https://i0.hdslb.com/bfs/live/room.png');
  assert.equal(result.userId, '123');
  assert.equal(result.userName, '完整昵称');
});

test('dm_v2-only large messages obtain content, dimensions and image from their own map', () => {
  const result = message({ cmd: 'DANMU_MSG', dm_v2: v2(string(6, '柚雨应援'), scalar(13, 1), icon('柚雨应援', 'http://i0.hdslb.com/bfs/live/cheer.webp', 'emote-cheer', true)) });
  assert.equal(result.text, '柚雨应援');
  assert.deepEqual(result.segments, [{ type: 'emote', emoteSize: 'large', text: '柚雨应援', unique: 'emote-cheer', url: 'https://i0.hdslb.com/bfs/live/cheer.webp', width: 100, height: 100, dynamic: true }]);
  assert.equal(result.userId, undefined, 'emote decoding does not invent a sender identity');
});

test('v2 inline tokens preserve mixed text, prefer explicit ordinary type and do not replace bare names', () => {
  const result = message({ ...legacy('旧描述'), dm_v2: v2(string(6, '你好[笑]，房间表情[哭]'), scalar(13, 0),
    icon('[笑]', '//i0.hdslb.com/bfs/live/smile.png', 'small-1'), icon('[哭]', '//i0.hdslb.com/bfs/live/cry.png', 'small-2')) });
  assert.equal(result.text, '你好[笑]，房间表情[哭]');
  assert.deepEqual(result.segments?.map(part => part.type), ['text', 'emote', 'text', 'emote']);
  assert.equal(result.segments?.map(part => part.text).join(''), result.text);
  assert.equal(result.segments?.[1].dynamic, false);
  assert.equal(result.segments?.[1].emoteSize, 'small');
  assert.equal(result.userId, '123', 'legacy identity remains available with v2 content');
  const plain = message({ cmd: 'DANMU_MSG', dm_v2: v2(string(6, '房间表情'), scalar(13, 0)) });
  assert.equal(plain.segments, undefined);
});

test('missing or malformed v2 metadata preserves complete legacy images and never aborts reception', () => {
  for (const dm_v2 of ['not-base64', v2(binary(14, [10, 255])), v2(scalar(100, 7)), v2(string(6, 'x'.repeat(2049)))]) {
    const result = message({ ...legacy(), dm_v2 });
    assert.equal(result.text, '房间表情');
    assert.equal(result.segments?.[0].url, 'https://i0.hdslb.com/bfs/live/room.png');
    assert.equal(result.segments?.[0].unique, 'room-emote');
  }
  assert.deepEqual(normalizeDanmaku('10', { cmd: 'DANMU_MSG', dm_v2: 'not-base64' }), []);
  assert.equal(message(legacy()).userId, '123');
});

test('partial valid v2 uses existing content and inline maps without inventing defaults', () => {
  const old = { cmd: 'DANMU_MSG', info: [[0, 0, 0, 0, 0, 'id', 0, 0, 0, 0, 0, 0, 0, 0, 0,
    { extra: { emots: { '[笑]': { url: '//i0.hdslb.com/smile.png' } } } }], '你好[笑]', [123, '昵称']] };
  const first = message({ ...old, dm_v2: v2(scalar(13, 0)) });
  assert.equal(first.segments?.[1].url, 'https://i0.hdslb.com/smile.png');
  const second = message({ ...old, dm_v2: v2(icon('[笑]', '//i0.hdslb.com/new-smile.png')) });
  assert.equal(second.text, '你好[笑]');
  assert.equal(second.segments?.[1].url, 'https://i0.hdslb.com/new-smile.png');
});

test('partial matching emotes fall back per field without overriding explicit false or zero', () => {
  for (const url of [undefined, '', 'https://evil.test/wrong.png']) {
    const fields = [...string(1, 'room-emote'), ...scalar(3, 0), ...scalar(7, 0), ...(url === undefined ? [] : string(2, url))];
    const result = message({ ...legacy(), dm_v2: v2(string(6, '房间表情'), scalar(13, 1), binary(14, [
      ...string(1, '房间表情'), ...binary(2, fields),
    ])) });
    assert.equal(result.segments?.[0].url, 'https://i0.hdslb.com/bfs/live/room.png');
    assert.equal(result.segments?.[0].unique, 'room-emote');
    assert.equal(result.segments?.[0].height, 100);
    assert.equal(result.segments?.[0].width, undefined, 'explicit zero must not inherit the legacy width');
    assert.equal(result.segments?.[0].dynamic, false);
  }
  const old = { cmd: 'DANMU_MSG', info: [[0, 0, 0, 0, 0, 'id', 0, 0, 0, 0, 0, 0, 0, 0, 0,
    { extra: { emots: {
      '[笑]': { url: '//i0.hdslb.com/smile.png', emoticon_unique: 'same-id', is_dynamic: true },
      '[哭]': { url: '//i0.hdslb.com/cry.png' },
    } } }], '[笑][哭]', [123, '昵称']] };
  const result = message({ ...old, dm_v2: v2(binary(14, [
    ...string(1, '[笑]'), ...binary(2, [...string(1, 'same-id'), ...scalar(3, 0)]),
  ])) });
  assert.deepEqual(result.segments?.map(part => part.url), ['https://i0.hdslb.com/smile.png', 'https://i0.hdslb.com/cry.png']);
  assert.equal(result.segments?.[0].dynamic, false);
});

test('conflicting emote identifiers never borrow another projection image', () => {
  const result = message({ ...legacy(), dm_v2: v2(string(6, '房间表情'), scalar(13, 1), binary(14, [
    ...string(1, '房间表情'), ...binary(2, string(1, 'different-id')),
  ])) });
  assert.equal(result.segments?.[0].unique, 'different-id');
  assert.equal(result.segments?.[0].url, undefined);
  const valid = message({ ...legacy(), dm_v2: v2(string(6, '房间表情'), scalar(13, 1), icon('房间表情', '//i0.hdslb.com/new.png', 'different-id')) });
  assert.equal(valid.segments?.[0].url, 'https://i0.hdslb.com/new.png');
});

test('invalid images keep known emote identity while never exposing an untrusted URL', () => {
  for (const url of ['https://evil.test/emote.png', 'http://i0.hdslb.com:8080/emote.png', 'javascript:alert(1)', 'data:image/png;base64,AA==']) {
    const result = message(legacy('图片描述', url));
    assert.equal(result.segments?.[0].type, 'emote');
    assert.equal(result.segments?.[0].unique, 'room-emote');
    assert.equal(result.segments?.[0].url, undefined);
    assert.equal(result.segments?.[0].text, '图片描述');
  }
  const missing = legacy(); missing.info[0][13] = {};
  assert.equal(message(missing).segments?.[0].type, 'emote');
  assert.equal(message(missing).segments?.[0].url, undefined);
});

test('v2 metadata cannot recover private identity or apply sender privileges', () => {
  const value = legacy();
  value.info[0][15] = { user: { uid: 123, base: { name: '隐私用户', is_mystery: true } } };
  const result = message({ ...value, dm_v2: v2(string(6, '房间表情'), scalar(13, 1), icon('房间表情', '//i0.hdslb.com/emote.png')) });
  assert.equal(result.userIdentity, 'masked');
  assert.equal(result.userId, undefined);
  assert.equal(result.guardLevel, undefined);
  assert.equal(result.segments?.[0].type, 'emote');
});

test('large image lookup uses its exact wire key while the same message retains its readable description', () => {
  const result = message({ ...legacy('柚雨应援'), dm_v2: v2(string(6, 'room_123_456'), scalar(13, 1), icon('room_123_456', '//i0.hdslb.com/cheer.png')) });
  assert.equal(result.text, '柚雨应援');
  assert.equal(result.segments?.[0].text, '柚雨应援');
  assert.equal(result.segments?.[0].url, 'https://i0.hdslb.com/cheer.png');
  const empty = message({ ...legacy('原始描述'), dm_v2: v2(string(6, ''), scalar(13, 1)) });
  assert.equal(empty.text, '原始描述');
  assert.equal(empty.segments?.[0].url, 'https://i0.hdslb.com/bfs/live/room.png');
});
