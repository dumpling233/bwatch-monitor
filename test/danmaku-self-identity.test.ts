import assert from 'node:assert/strict';
import test from 'node:test';
import { isOwnDanmaku, reliableDanmakuUid } from '../client/multiview/danmaku/selfIdentity';
import { measureDanmakuText } from '../client/multiview/danmaku/textSprite';
import type { DanmakuMessage } from '../client/multiview/danmaku/types';

const identity = (extra: Partial<DanmakuMessage> = {}): DanmakuMessage => ({ id: 'message', roomId: '1', kind: 'danmaku',
  text: '相同内容', userName: '同一个昵称', userId: '123', userIdentity: 'full', color: '#ffffff', sourceTime: 1, receivedAt: 1, ...extra });

test('own identity requires the verified account and the exact reliable message UID', () => {
  assert.equal(isOwnDanmaku(identity(), '123'), true);
  assert.equal(isOwnDanmaku(identity({ userName: '昵称中有*也不代表脱敏' }), '123'), true);
  assert.equal(isOwnDanmaku(identity({ userId: '456' }), '123'), false, 'same text and nickname never identify the sender');
  assert.equal(isOwnDanmaku(identity(), undefined), false);
  assert.equal(isOwnDanmaku(identity(), '456'), false);
  assert.equal(isOwnDanmaku(identity(), '123'), true, 'restoring the same verified account does not mutate the message');
  assert.equal(isOwnDanmaku(identity({ userId: '456' }), '456'), true, 'a new account is checked against its own reliable UID');
});

test('privacy veto and malformed or missing UIDs cannot acquire a self frame', () => {
  for (const value of [undefined, '', '0', '000123', '-123', '123.0', '1e2', ' 123', '123 ', '123456789012345678901']) {
    assert.equal(reliableDanmakuUid(identity({ userId: value })), undefined, String(value));
    assert.equal(isOwnDanmaku(identity({ userId: value }), '123'), false);
  }
  for (const privateMessage of [identity({ userIdentity: 'masked' }), identity({ isMystery: true })]) {
    assert.equal(reliableDanmakuUid(privateMessage), undefined);
    assert.equal(isOwnDanmaku(privateMessage, '123'), false);
  }
  assert.equal(isOwnDanmaku(identity({ userIdentity: 'unknown' }), '123'), true, 'a missing display name does not invalidate a supplied reliable UID');
});

test('frame padding is included in lane and sprite budgets and keeps glyphs inside a thin rectangular frame', () => {
  for (const px of [10, 28, 56]) for (const effect of ['none', 'stroke', 'heavy', 'projection'] as const) {
    const context = { font: '', measureText: () => ({ width: px * 4, actualBoundingBoxLeft: 2, actualBoundingBoxRight: px * 4,
      actualBoundingBoxAscent: px * 0.8, actualBoundingBoxDescent: px * 0.2 }) } as unknown as CanvasRenderingContext2D;
    const padding = Math.ceil(Math.max(2, px * 0.08));
    const normal = measureDanmakuText(context, '本人弹幕', `${px}px SimHei`, px, effect);
    const framed = measureDanmakuText(context, '本人弹幕', `${px}px SimHei`, px, effect, padding);
    assert.equal(normal.frame, undefined);
    assert.equal(framed.width, normal.width + padding * 2);
    assert.equal(framed.height, normal.height + padding * 2);
    assert.equal(framed.laneHeight, normal.laneHeight + padding * 2, 'collision detection includes the frame inset');
    assert.equal(framed.drawOffsetY, normal.drawOffsetY, 'text effects keep their original outer insets');
    assert.ok(framed.frame);
    const frame = framed.frame!;
    assert.ok(frame.x > 0 && frame.x + frame.width < framed.width);
    assert.ok(frame.y > 0 && frame.y + frame.height < framed.height);
    assert.ok(framed.x - 2 > frame.x);
    assert.ok(framed.baseline - px * 0.8 > frame.y);
    assert.ok(framed.baseline + px * 0.2 < frame.y + frame.height);
  }
});
