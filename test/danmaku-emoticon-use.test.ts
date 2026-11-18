import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LocalChatContext, LocalChatEmoticon } from '../shared/localDanmaku';
import { chatEmoticonsByUnique, emoticonUseRestriction } from '../client/multiview/danmaku/emoticonUse';
import { repeatContentRestriction, repeatMessageContent } from '../client/multiview/danmaku/repeatMessage';
import type { DanmakuMessage } from '../client/multiview/danmaku/types';

const image = (patch: Partial<LocalChatEmoticon> = {}): LocalChatEmoticon => ({ unique: 'room:large:1', text: '大表情',
  url: 'https://i0.hdslb.com/bfs/test/emote.png', packageName: '房间表情', kind: 'image', permitted: true, ...patch });
const context = (patch: Partial<LocalChatContext> = {}): LocalChatContext => ({ roomId: '1', accountUid: '123', authEpoch: 'epoch1',
  emoticons: [image()], emoticonsAvailable: true, emoticonPermissionsVerified: true, emoticonsCached: false, ...patch });
const restriction = (value: LocalChatContext | null, unique = 'room:large:1') => repeatContentRestriction({ emoticonUnique: unique }, value);

test('picker and repeat share cached permitted candidates without promoting the display snapshot to a write grant', () => {
  for (const flags of [{ emoticonsCached: true, emoticonPermissionsVerified: false },
    { emoticonsCached: false, emoticonPermissionsVerified: false },
    { emoticonsCached: undefined, emoticonPermissionsVerified: undefined }]) {
    const value = context(flags);
    assert.equal(emoticonUseRestriction(value, 'room:large:1', 'image'), undefined);
    assert.equal(restriction(value), undefined);
    assert.equal(value.emoticonPermissionsVerified, flags.emoticonPermissionsVerified);
    assert.equal(value.emoticonsCached, flags.emoticonsCached);
  }
});

test('explicit locked conditions remain identical for picker and repeat even in a cached catalogue', () => {
  const value = context({ emoticonsCached: true, emoticonPermissionsVerified: false,
    emoticons: [image({ permitted: false, unlockHint: '需要当前直播间舰长身份' })] });
  assert.equal(emoticonUseRestriction(value, 'room:large:1', 'image'), '需要当前直播间舰长身份');
  assert.equal(restriction(value), '需要当前直播间舰长身份');
});

test('missing, unavailable and muted contexts cannot be sent through either entry point', () => {
  for (const value of [null, context({ emoticons: [] }), context({ emoticonsAvailable: false }), context({ muted: true })]) {
    const expected = emoticonUseRestriction(value, 'room:large:1', 'image');
    assert.equal(typeof expected, 'string'); assert.equal(restriction(value), expected);
  }
});

test('large repeat requires the exact image unique and does not infer permission from a shared image or description', () => {
  const value = context({ emoticons: [image({ unique: 'another-room:large:1' }), image({ unique: 'small:1', kind: 'text' })] });
  assert.equal(restriction(value), '暂无法确认这条表情的使用权限');
  assert.equal(restriction(value, 'small:1'), '暂无法确认这条表情的使用权限');
  assert.equal(emoticonUseRestriction(value, 'small:1', 'text'), undefined);
});

test('a refreshed or switched context replaces prior eligibility, including explicit no-permission', () => {
  const before = context(), after = context({ accountUid: '456', authEpoch: 'epoch2',
    emoticons: [image({ permitted: false, unlockLabel: '未解锁' })] });
  assert.equal(restriction(before), undefined);
  assert.equal(restriction(after), '未解锁');
  assert.notEqual(chatEmoticonsByUnique(before), chatEmoticonsByUnique(after));
  before.emoticons[0].permitted = false;
  assert.equal(restriction(before), '尚未解锁这条表情', 'the index preserves explicit current false values');
});

test('one context index is reused by all rows without requests and duplicate identifiers follow extension first-entry semantics', () => {
  const value = context({ emoticons: [image({ permitted: false }), image()] });
  const index = chatEmoticonsByUnique(value);
  for (let count = 0; count < 100; count++) {
    assert.equal(chatEmoticonsByUnique(value), index); assert.equal(restriction(value), '尚未解锁这条表情');
  }
});

test('own-message history never grants eligibility and unsupported image identifiers cannot be submitted', () => {
  const message: DanmakuMessage = { id: 'message1', roomId: '1', kind: 'danmaku', text: '大表情', userName: '本人', userId: '123',
    color: '#ffffff', receivedAt: 1, sourceTime: 1, segments: [{ type: 'emote', text: '大表情', emoteSize: 'large', unique: 'room:large:1' }] };
  const candidate = repeatMessageContent(message);
  assert.deepEqual(candidate.content, { emoticonUnique: 'room:large:1' });
  assert.equal(repeatContentRestriction(candidate.content!, context({ emoticons: [] })), '暂无法确认这条表情的使用权限');
  message.segments![0].unique = 'x'.repeat(201);
  assert.equal(repeatMessageContent(message).reason, '这条表情缺少可靠的发送标识');
});
