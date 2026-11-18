import assert from 'node:assert/strict';
import test from 'node:test';
import { findSafeDanmakuY, MAX_OVERLAY_COMMENTS, OverlayQueue, OVERLAY_MAX_WAIT_MS, type MovingDanmaku } from '../client/multiview/danmaku/overlayScheduling';
import { measureDanmakuText } from '../client/multiview/danmaku/textSprite';
import type { DanmakuTextEffect } from '../client/multiview/danmaku/displayPreferences';

const stage = { width: 1000, height: 30, duration: 10, now: 2, gap: 12 };
const incoming = { width: 100, height: 30 };
const previous = (overrides: Partial<MovingDanmaku> = {}): MovingDanmaku => ({ _utc: 0, width: 100, height: 30, y: 0, ...overrides });

function drain<T>(queue: OverlayQueue<T>, now: number): T[] {
  const values: T[] = [];
  while (queue.size) {
    const value = queue.peek(now);
    if (value === undefined) break;
    values.push(value);
    queue.shift();
  }
  return values;
}

test('a safe lane is reused while its previous comment is still on screen', () => {
  const old = previous();
  assert.ok(stage.now - old._utc < stage.duration);
  assert.ok(stage.width - (stage.width + old.width) * stage.now / stage.duration > 0);
  assert.equal(findSafeDanmakuY(stage, incoming, [old]), 0);
});

test('a longer incoming comment waits until it cannot catch up with the old comment', () => {
  const long = { width: 800, height: 30 };
  // The old right edge has cleared the entrance, but the long new comment is faster.
  assert.ok((stage.width + 100) * stage.now / stage.duration - 100 >= stage.gap);
  assert.equal(findSafeDanmakuY(stage, long, [previous()]), undefined);
  assert.equal(findSafeDanmakuY({ ...stage, now: 5 }, long, [previous()]), 0);
});

test('entry clearance includes a positive gap even when the new comment moves more slowly', () => {
  const old = previous({ width: 200 });
  const small = { width: 50, height: 30 };
  assert.equal(findSafeDanmakuY({ ...stage, now: 1.75, gap: 16 }, small, [old]), undefined);
  assert.equal(findSafeDanmakuY({ ...stage, now: 1.81, gap: 16 }, small, [old]), 0);
});

test('full vertical space returns no lane instead of wrapping into an occupied lane', () => {
  const occupied = [previous({ _utc: 2 }), previous({ _utc: 2, y: 32 })];
  assert.equal(findSafeDanmakuY({ ...stage, height: 62 }, incoming, occupied), undefined);
  assert.equal(findSafeDanmakuY({ ...stage, height: 94 }, incoming, occupied), 64);
});

test('lane admission checks all vertically overlapping old comments after font or geometry changes', () => {
  const running = [
    previous({ _utc: -2 }),
    previous({ _utc: 2, y: 15, height: 25 }),
  ];
  const copy = structuredClone(running);
  // The first comment is safe, but the other old font straddles the first two new lanes.
  assert.equal(findSafeDanmakuY({ ...stage, height: 94 }, incoming, running), 64);
  assert.deepEqual(running, copy);
  assert.equal(findSafeDanmakuY({ ...stage, height: 40 }, incoming, [previous({ _utc: 2, y: 22, height: 30 })]), undefined);
});

test('unrelated vertical bands and expired comments do not block incoming comments', () => {
  assert.equal(findSafeDanmakuY({ ...stage, height: 62 }, incoming, [previous({ _utc: 2, y: 30 })]), 0);
  assert.equal(findSafeDanmakuY({ ...stage, now: 10 }, incoming, [previous()]), 0);
  assert.equal(findSafeDanmakuY(stage, incoming, [previous({ _utc: 3 })]), undefined);
});

test('zero sized, invalid, and too short stages cannot admit a comment', () => {
  for (const invalid of [
    { ...stage, width: 0 }, { ...stage, height: 0 }, { ...stage, duration: 0 },
    { ...stage, width: Number.NaN }, { ...stage, height: 29 },
  ]) assert.equal(findSafeDanmakuY(invalid, incoming, []), undefined);
  assert.equal(findSafeDanmakuY(stage, { ...incoming, height: 0 }, []), undefined);
});

test('accepted mixed length traffic keeps its safety gap throughout overlapping lifetimes', () => {
  for (const width of [320, 640, 1200]) {
    const duration = width / 144, height = 94, gap = 12;
    let running: MovingDanmaku[] = [];
    let accepted = 0;
    for (let tick = 0; tick < 600; tick++) {
      const now = tick / 20;
      running = running.filter(comment => now - comment._utc < duration);
      const next = { width: [40, 90, 180, 360, 720][tick % 5], height: 30 };
      const y = findSafeDanmakuY({ width, height, duration, now, gap }, next, running);
      if (y !== undefined) {
        running.push({ ...next, y, _utc: now });
        accepted++;
      }
      // Check actual positions independently from the entry/exit admission formula.
      for (let i = 0; i < running.length; i++) {
        for (let j = i + 1; j < running.length; j++) {
          const older = running[i], newer = running[j];
          if (older.y + older.height <= newer.y || newer.y + newer.height <= older.y) continue;
          const olderRight = width - (width + older.width) * (now - older._utc) / duration + older.width;
          const newerLeft = width - (width + newer.width) * (now - newer._utc) / duration;
          assert.ok(newerLeft - olderRight >= gap - 1e-8, `collision at width=${width}, time=${now}`);
        }
      }
    }
    assert.ok(accepted > 30, 'safe lanes continue to admit traffic instead of waiting for a whole screen to clear');
  }
});

test('waiting and active comments share an 80 item budget while newer text replaces old waiting text', () => {
  const queue = new OverlayQueue<number>();
  queue.push(Array.from({ length: 100 }, (_, i) => i), 0, 0);
  assert.equal(queue.size, MAX_OVERLAY_COMMENTS);
  assert.deepEqual(drain(queue, 0), Array.from({ length: 80 }, (_, i) => i + 20));

  queue.push([1, 2, 3, 4], 78, 10);
  assert.equal(queue.size + 78, MAX_OVERLAY_COMMENTS);
  assert.deepEqual(drain(queue, 10), [3, 4]);

  queue.push([5, 6], 78, 20);
  let active = 78;
  while (queue.size) {
    queue.shift(); active++;
    assert.equal(active + queue.size, MAX_OVERLAY_COMMENTS);
  }
  queue.push([7], 80, 30);
  assert.equal(queue.size, 0);
});

test('waiting messages expire after 1.5 seconds without extending old deadlines on new arrivals', () => {
  const queue = new OverlayQueue<string>();
  queue.push(['old'], 0, 100);
  queue.push(['recent'], 0, 1100);
  assert.equal(queue.peek(100 + OVERLAY_MAX_WAIT_MS - 1), 'old');
  assert.equal(queue.peek(100 + OVERLAY_MAX_WAIT_MS), 'recent');
  assert.equal(queue.peek(1100 + OVERLAY_MAX_WAIT_MS), undefined);
  assert.equal(queue.size, 0);
});

test('queue capacity reductions and clear release all excess waiting messages', () => {
  const queue = new OverlayQueue<string>();
  queue.push(['old', 'middle', 'new'], 0, 0);
  queue.push([], 79, 100);
  assert.deepEqual(drain(queue, 100), ['new']);
  queue.push(['discard'], 0, 200);
  queue.push([], 81, 300);
  assert.equal(queue.size, 0);
  queue.push(['clear me'], 0, 400);
  queue.clear();
  assert.equal(queue.size, 0);
  assert.equal(queue.peek(400), undefined);
  queue.push(['fresh'], 0, 500);
  assert.equal(queue.peek(500), 'fresh');
});

function textContext(px: number, overrides: Partial<TextMetrics> = {}): CanvasRenderingContext2D {
  return {
    font: '',
    measureText: () => ({ width: px * 4, actualBoundingBoxLeft: 1, actualBoundingBoxRight: px * 4,
      actualBoundingBoxAscent: px * 0.8, actualBoundingBoxDescent: px * 0.2, ...overrides }),
  } as unknown as CanvasRenderingContext2D;
}

test('text effects keep the previous adaptive logical line height while retaining complete sprite bounds', () => {
  const effects: DanmakuTextEffect[] = ['none', 'stroke', 'heavy', 'projection'];
  for (const px of [10, 11.2, 28, 47.6, 56]) {
    const context = textContext(px);
    const bounds = effects.map(effect => measureDanmakuText(context, '弹幕字体', `700 ${px}px SimHei`, px, effect));
    for (const item of bounds) {
      assert.equal(item.laneHeight, Math.ceil(px * 1.2), 'effect padding cannot change the logical line height');
      const padding = -item.drawOffsetY;
      assert.ok(padding > 0);
      assert.ok(item.height >= Math.ceil(px * 1.125) + padding * 2, 'bitmap retains effect padding on both sides');
      assert.ok(item.baseline >= padding + px * 0.8);
      assert.ok(item.height - item.baseline >= padding + px * 0.2 - 1e-8, 'descenders and lower effects remain inside the bitmap');
      assert.ok(Math.abs(item.baseline + item.drawOffsetY - px * 0.8) < 1e-9, 'drawing offset keeps the text baseline stable across effects');
    }
    assert.ok(bounds[3].height > bounds[2].height);
    assert.ok(bounds[2].height > bounds[1].height);
    assert.ok(bounds[1].height > bounds[0].height);
  }
});

test('unusually tall glyphs can enlarge the logical line but shadow padding cannot', () => {
  const px = 28, ascent = 35, descent = 9;
  const context = textContext(px, { actualBoundingBoxAscent: ascent, actualBoundingBoxDescent: descent });
  for (const effect of ['none', 'heavy', 'projection'] as const) {
    const bounds = measureDanmakuText(context, 'Ág', `700 ${px}px serif`, px, effect);
    assert.equal(bounds.laneHeight, ascent + descent);
    assert.ok(bounds.height > bounds.laneHeight);
    assert.equal(bounds.baseline + bounds.drawOffsetY, ascent);
  }
});

test('top and bottom effect insets are reserved once instead of increasing every lane pitch', () => {
  const px = 28;
  const bounds = measureDanmakuText(textContext(px), '紧凑弹幕', `700 ${px}px SimHei`, px, 'heavy');
  const topInset = -bounds.drawOffsetY;
  const bottomInset = Math.max(0, bounds.height + bounds.drawOffsetY - bounds.laneHeight);
  const stageWithInsets = { ...stage, height: 200, now: 0, topInset, bottomInset };
  const live: MovingDanmaku[] = [];
  const positions: number[] = [];
  while (positions.length < 20) {
    const y = findSafeDanmakuY(stageWithInsets, { width: bounds.width, height: bounds.laneHeight }, live);
    if (y === undefined) break;
    positions.push(y);
    live.push({ _utc: 0, width: bounds.width, height: bounds.laneHeight, y });
    assert.ok(y + bounds.drawOffsetY >= 0, 'upper effect stays in the canvas');
    assert.ok(y + bounds.drawOffsetY + bounds.height <= stageWithInsets.height, 'lower effect stays in the canvas');
  }
  assert.equal(positions.length, 5, 'five compact logical rows fit instead of four bitmap-sized rows');
  assert.equal(positions[0], topInset);
  assert.deepEqual(positions.slice(1).map((y, i) => y - positions[i]), Array(4).fill(Math.ceil(px * 1.2) + 2));
});

test('insets prevent clipped edge lanes without weakening existing collision checks', () => {
  const withInsets = { ...stage, height: 66, topInset: 5, bottomInset: 3 };
  assert.equal(findSafeDanmakuY(withInsets, incoming, []), 5);
  assert.equal(findSafeDanmakuY(withInsets, incoming, [previous({ _utc: 2, y: 5 })]), undefined);
  assert.equal(findSafeDanmakuY({ ...withInsets, height: 70 }, incoming, [previous({ _utc: 2, y: 5 })]), 37);
  assert.equal(findSafeDanmakuY({ ...stage, height: 37, topInset: 5, bottomInset: 3 }, incoming, []), undefined);
  assert.equal(findSafeDanmakuY({ ...stage, height: 38, topInset: 5, bottomInset: 3 }, incoming, []), 5);
  assert.equal(findSafeDanmakuY(withInsets, incoming, [previous({ y: 5 })]), 5, 'the first row is still safely reusable before the old comment exits');
});
