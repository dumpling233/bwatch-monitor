import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DANMAKU_V2_LIMITS as limits, decodeDanmakuV2 } from '../client/multiview/danmaku/dmV2.js';

// Independently encode only the documented wire fields, without an upstream runtime.
const utf8 = new TextEncoder();
const varint = (value: number): number[] => {
  const bytes: number[] = [];
  do { const byte = value % 128; value = Math.floor(value / 128); bytes.push(byte | (value ? 0x80 : 0)); } while (value);
  return bytes;
};
const scalar = (number: number, value: number): number[] => [...varint(number * 8), ...varint(value)];
const field = (number: number, bytes: readonly number[]): number[] => [...varint(number * 8 + 2), ...varint(bytes.length), ...bytes];
const string = (number: number, value: string): number[] => field(number, [...utf8.encode(value)]);
const encode = (bytes: readonly number[]): string => Buffer.from(bytes).toString('base64');
const image = (key: string, fields: readonly number[]): number[] => field(14, [...string(1, key), ...field(2, fields)]);
const big = (key = 'room_123_456', url = 'https://i0.hdslb.com/bfs/live/emote.png'): number[] => [
  ...string(6, key), ...scalar(13, 1), ...image(key, [...string(1, key), ...string(2, url), ...scalar(3, 0), ...scalar(4, 0), ...scalar(5, 1), ...scalar(6, 100), ...scalar(7, 110)]),
];

test('known live Dm schema decodes large emoticons and preserves explicit false and zero', () => {
  const value = decodeDanmakuV2(encode(big()))!;
  assert.equal(value.content, 'room_123_456');
  assert.equal(value.dmType, 1);
  assert.deepEqual(value.emoticons.room_123_456, { unique: 'room_123_456', url: 'https://i0.hdslb.com/bfs/live/emote.png', is_dynamic: false, in_player_area: 0, bulge_display: 1, height: 100, width: 110 });
  assert.equal(Object.getPrototypeOf(value.emoticons), null);
  const normal = decodeDanmakuV2(encode([...string(6, '普通文字'), ...scalar(13, 0)]))!;
  assert.equal(normal.dmType, 0);
  assert.equal(Object.hasOwn(normal, 'content'), true);
  assert.equal(Object.keys(normal.emoticons).length, 0);
});

test('inline emoticons use their wire map keys and retain mixed text verbatim', () => {
  const body = '你好[笑]再见[哭]';
  const result = decodeDanmakuV2(encode([...scalar(13, 0), ...string(6, body),
    ...image('[笑]', [...string(1, 'emoji_1'), ...string(2, '//i0.hdslb.com/smile.png'), ...scalar(3, 1)]),
    ...image('[哭]', [...string(2, '//i0.hdslb.com/cry.png')])]))!;
  assert.equal(result.content, body);
  assert.equal(result.dmType, 0);
  assert.equal(result.emoticons['[笑]'].is_dynamic, true);
  assert.equal(result.emoticons['[哭]'].unique, undefined);
  assert.equal(Object.hasOwn(result.emoticons['[哭]'], 'is_dynamic'), false);
});

test('unknown scalar, fixed and length fields are skipped at every supported nesting level', () => {
  const unknown = [...scalar(100, 12), ...varint(101 * 8 + 1), ...Array(8).fill(255), ...field(102, [0, 255]), ...varint(103 * 8 + 5), 1, 2, 3, 4];
  const value = decodeDanmakuV2(encode([...unknown, ...string(6, '文字'), ...scalar(13, 0),
    ...field(14, [...unknown, ...string(1, '[笑]'), ...field(2, [...unknown, ...string(2, '//i0.hdslb.com/a.png')])])]))!;
  assert.equal(value.content, '文字');
  assert.equal(value.emoticons['[笑]'].url, '//i0.hdslb.com/a.png');
  assert.equal(decodeDanmakuV2(encode(unknown))?.content, undefined, 'missing fields do not invent defaults');
  assert.equal(decodeDanmakuV2(encode([...scalar(100, 0).slice(0, -1), ...Array(9).fill(0xff), 1, ...string(6, '仍可接收')]))?.content, '仍可接收', 'unknown uint64 fields need no lossy numeric conversion');
});

test('invalid base64, noncanonical trailing bits and input byte budgets fail closed', () => {
  for (const value of [null, {}, 123, '', 'a', 'abcd-', 'abcd_', ' YQ==', 'YQ==\n', 'abc\n', 'YQ', 'YR==', 'YWJ=', '====', 'AA==AA==']) assert.equal(decodeDanmakuV2(value), undefined, String(value));
  assert.equal(decodeDanmakuV2('A'.repeat(Math.ceil(limits.bytes / 3) * 4 + 4)), undefined);
  assert.equal(decodeDanmakuV2(encode(Array(limits.bytes + 1).fill(1))), undefined);
  const maximumPacket = field(100, Array(limits.bytes - 5).fill(0));
  assert.equal(maximumPacket.length, limits.bytes);
  assert.ok(decodeDanmakuV2(encode(maximumPacket)), 'a valid packet at the exact wire byte limit remains decodable');
});

test('truncated and malformed varints, lengths, wires and utf8 reject the entire projection', () => {
  const valid = big();
  const mapStart = string(6, 'room_123_456').length + scalar(13, 1).length;
  for (let length = 1; length < valid.length; length++) {
    // A prefix ending exactly between complete optional fields can be valid;
    // these deliberately cut inside the declared map submessage.
    if (length > mapStart + 1) assert.equal(decodeDanmakuV2(encode(valid.slice(0, length))), undefined, `map prefix ${length}`);
  }
  const bad = [[0], [0x80], [0x80, 0], Array(11).fill(0x80), [...varint(8), ...Array(9).fill(0x80), 2], [0x33], [0x34], [0x36], [0x37], [0x32, 10, 65], [0x32, 1, 0xff], [0x68, 0x80, 0], [0x69, ...Array(8).fill(0)], [0x32, 0x80, 0]];
  for (const bytes of bad) assert.equal(decodeDanmakuV2(encode(bytes)), undefined, JSON.stringify(bytes));
  assert.equal(decodeDanmakuV2(encode([...valid, ...string(6, '不得覆盖前半成功数据')])), undefined);
});

test('duplicate fields, map entries and dangerous keys never produce partial or prototype data', () => {
  const icon = [...string(2, '//i0.hdslb.com/a.png')];
  for (const key of ['', '__proto__', 'constructor', 'prototype']) assert.equal(decodeDanmakuV2(encode(image(key, icon))), undefined);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(decodeDanmakuV2(encode([...image('same', icon), ...image('same', icon)])), undefined);
  assert.equal(decodeDanmakuV2(encode([...scalar(13, 0), ...scalar(13, 1)])), undefined);
  assert.equal(decodeDanmakuV2(encode(image('[笑]', [...icon, ...icon]))), undefined);
  assert.equal(decodeDanmakuV2(encode(field(14, [...string(1, 'x'), ...string(1, 'y'), ...field(2, icon)]))), undefined);
  assert.equal(decodeDanmakuV2(encode(field(14, [...string(1, 'x')]))), undefined);
  assert.equal(decodeDanmakuV2(encode(field(14, [...field(2, icon)]))), undefined);
});

test('string, metadata, item and field limits reject oversized decoration atomically', () => {
  assert.equal(decodeDanmakuV2(encode(string(6, 'a'.repeat(limits.content + 1)))), undefined);
  assert.equal(decodeDanmakuV2(encode(string(6, '😀'.repeat(Math.floor(limits.content / 4) + 1)))), undefined);
  assert.equal(decodeDanmakuV2(encode(image('x'.repeat(limits.key + 1), []))), undefined);
  assert.equal(decodeDanmakuV2(encode(image('x', string(1, 'u'.repeat(limits.unique + 1))))), undefined);
  assert.equal(decodeDanmakuV2(encode(image('x', string(2, 'u'.repeat(limits.url + 1))))), undefined);
  assert.equal(decodeDanmakuV2(encode(Array.from({ length: limits.emoticons + 1 }, (_, index) => image(String(index), [])).flat())), undefined);
  assert.equal(decodeDanmakuV2(encode(Array.from({ length: limits.fields + 1 }, () => scalar(100, 0)).flat())), undefined);
  assert.ok(decodeDanmakuV2(encode(Array.from({ length: limits.fields }, () => scalar(100, 0)).flat())));
  assert.equal(decodeDanmakuV2(encode(image('x', Array.from({ length: limits.fields }, () => scalar(100, 0)).flat()))), undefined, 'nested fields share the total field budget');
  assert.equal(decodeDanmakuV2(encode(Array.from({ length: 20 }, (_, index) => image(String(index), string(2, 'u'.repeat(1000)))).flat())), undefined);
  const within = decodeDanmakuV2(encode([...string(6, 'a'.repeat(limits.content)), ...scalar(13, 0)]));
  assert.equal(within?.content?.length, limits.content);
});

test('known numeric fields reject invalid booleans, excessive dimensions and unsafe integer varints', () => {
  for (const bytes of [scalar(13, 256), image('x', scalar(3, 2)), image('x', scalar(4, 2)), image('x', scalar(5, 2)), image('x', scalar(6, limits.dimension + 1)), image('x', scalar(7, limits.dimension + 1)), image('x', [...varint(6 * 8), ...Array(7).fill(0xff), 0x1f])]) assert.equal(decodeDanmakuV2(encode(bytes)), undefined);
  assert.equal(decodeDanmakuV2(encode(image('x', [...scalar(6, 0), ...scalar(7, limits.dimension)])))?.emoticons.x.height, 0);
});
