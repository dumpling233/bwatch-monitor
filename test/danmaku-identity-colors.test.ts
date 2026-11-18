import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeDanmaku } from '../client/multiview/danmaku/normalize';
import { resolveSuperChatColors, superChatTextColor } from '../client/multiview/danmaku/superChatColors';

const normalizedMessage = (value: unknown) => {
  const event = normalizeDanmaku('1', value, 1000000)[0];
  assert.equal(event?.type, 'message');
  if (event?.type !== 'message') throw new Error('Expected a normalized message');
  return event.message;
};

test('normalizer retains the complete available name and exact UID, including modern user metadata', () => {
  const info: unknown[] = [[], 'hello', [0, '用***']];
  const meta = info[0] as unknown[];
  meta[15] = { user: { uid: '18446744073709551614', base: { name: '完整的用户名_不会只保留首字' } } };
  const message = normalizedMessage({ cmd: 'DANMU_MSG', info });
  assert.equal(message.userName, '完整的用户名_不会只保留首字');
  assert.equal(message.userId, '18446744073709551614');
  assert.equal(message.userIdentity, 'full');

  const legacy = normalizedMessage({ cmd: 'DANMU_MSG', info: [[], 'hello', [123456, '原始完整用户']] });
  assert.equal(legacy.userId, '123456');
  assert.equal(legacy.userName, '原始完整用户');
});

test('masked upstream identity stays masked and unavailable or inexact UIDs are not invented', () => {
  for (const uid of [0, -10, Number.MAX_SAFE_INTEGER + 1, '0', '123***', 'crc32abcd', 'https://example.com']) {
    const message = normalizedMessage({ cmd: 'DANMU_MSG', info: [[0, 0, 0, 0, 0, 0, 0, 'fake-hash'], 'hello', [uid, '某***']] });
    assert.equal(message.userName, '某***');
    assert.equal(message.userId, undefined);
    assert.equal(message.userIdentity, 'masked');
  }
  assert.equal(normalizedMessage({ cmd: 'DANMU_MSG', info: [[], 'hello', []] }).userIdentity, 'unknown');
});

test('conflicting metadata does not pair one candidate name with another candidate UID', () => {
  const meta: unknown[] = [];
  meta[15] = { user: { uid: 111, base: { name: '某***' } }, extra: { user: { uid: 333, base: { name: '其他***' } } } };
  const message = normalizedMessage({ cmd: 'DANMU_MSG', info: [meta, 'hello', [222, '完整用户']] });
  assert.equal(message.userName, '完整用户');
  assert.equal(message.userId, '222');
  meta[15] = { user: { base: { name: '完整新版用户' } }, extra: { user: { uid: 333, base: { name: '其他***' } } } };
  assert.equal(normalizedMessage({ cmd: 'DANMU_MSG', info: [meta, 'hello', [222, '旧***']] }).userId, undefined);
});

test('bounded optional metadata can enrich names, while malformed JSON does not discard a message', () => {
  const meta: unknown[] = [];
  meta[15] = { extra: JSON.stringify({ user: { uid: '000234', base: { name: '更完整的名称' } } }) };
  const enriched = normalizedMessage({ cmd: 'DANMU_MSG', info: [meta, 'hello', [0, '更***']] });
  assert.equal(enriched.userName, '更完整的名称');
  assert.equal(enriched.userId, '234');
  meta[15] = { extra: '{not json' };
  assert.equal(normalizedMessage({ cmd: 'DANMU_MSG', info: [meta, 'hello', [456, '原始名称']] }).userId, '456');
});

test('SC retains sender identity and validates official upstream colors before applying them', () => {
  const message = normalizedMessage({ cmd: 'SUPER_CHAT_MESSAGE', data: {
    id: 1, uid: '9876543210', message: 'SC 内容', price: 100,
    user_info: { uname: '完整SC用户' }, background_color: '#AABBCC',
    background_bottom_color: 'url(https://example.com/tracker)', background_price_color: '#123456',
  } });
  assert.equal(message.userId, '9876543210');
  assert.equal(message.userName, '完整SC用户');
  assert.deepEqual(message.scColors, { background: '#aabbcc', body: '#e2b52b', price: '#123456' });
});

test('SC fallback crosses all six Bilibili price bands at the correct boundary', () => {
  const bodies = [29, 30, 49, 50, 99, 100, 499, 500, 999, 1000, 1999, 2000, 30000].map(price => resolveSuperChatColors(price).body);
  assert.deepEqual(bodies, ['#2a60b2', '#2a60b2', '#2a60b2', '#427d9e', '#427d9e', '#e2b52b', '#e2b52b', '#e09443', '#e09443', '#e54d4d', '#e54d4d', '#ab1a32', '#ab1a32']);
  assert.equal(resolveSuperChatColors(Number.NaN).body, '#2a60b2');
  assert.equal(resolveSuperChatColors(50, { body: '#000000;display:none' }).body, '#427d9e');
  assert.equal(superChatTextColor('#ffffff'), '#111827');
  assert.equal(superChatTextColor('#000000'), '#ffffff');
  assert.equal(superChatTextColor('#e2b52b'), '#111827');
  assert.equal(superChatTextColor('#ab1a32'), '#ffffff');
});
