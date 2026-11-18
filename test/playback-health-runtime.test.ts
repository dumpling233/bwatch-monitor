import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlaybackHealthRuntime } from '../client/multiview/playbackHealth';

class Clock {
  time = 0;
  nextId = 0;
  timers = new Map<number, { at: number; callback(): void }>();
  now = () => this.time;
  setTimeout = (callback: () => void, delay: number) => {
    const id = ++this.nextId;
    this.timers.set(id, { at: this.time + delay, callback });
    return id;
  };
  clearTimeout = (handle: unknown) => { this.timers.delete(handle as number); };
  advance(milliseconds: number) {
    const end = this.time + milliseconds;
    for (;;) {
      const entry = [...this.timers].filter(([, timer]) => timer.at <= end).sort((first, second) => first[1].at - second[1].at)[0];
      if (!entry) break;
      this.time = entry[1].at;
      this.timers.delete(entry[0]);
      entry[1].callback();
    }
    this.time = end;
  }
}

test('48 playback observers share one timer and remove page listeners with the final observer', () => {
  const clock = new Clock(), document = new EventTarget(), window = new EventTarget();
  let hidden = false;
  const runtime = createPlaybackHealthRuntime({ clock, document, window, hidden: () => hidden });
  const checks: boolean[][] = Array.from({ length: 48 }, () => []);
  const stops = checks.map(values => runtime.observe(resumed => values.push(resumed)));
  assert.equal(clock.timers.size, 1);
  clock.advance(1_000);
  assert.ok(checks.every(values => values.length === 1 && !values[0]));
  hidden = true;
  document.dispatchEvent(new Event('visibilitychange'));
  clock.advance(1_000);
  clock.advance(4_000);
  assert.ok(checks.every(values => values.length === 2));
  hidden = false;
  document.dispatchEvent(new Event('visibilitychange'));
  assert.ok(checks.every(values => values.length === 3 && values[2]));
  window.dispatchEvent(new Event('focus'));
  assert.ok(checks.every(values => values.length === 4 && values[3]));
  stops.forEach(stop => stop());
  assert.equal(clock.timers.size, 0);
  window.dispatchEvent(new Event('focus'));
  assert.ok(checks.every(values => values.length === 4));
});

test('automatic recoveries start one per second with at most two active and queued work is cancellable', () => {
  const clock = new Clock(), runtime = createPlaybackHealthRuntime({ clock });
  const started: number[] = [], releases: (() => void)[] = [];
  const controllers = Array.from({ length: 48 }, () => new AbortController());
  controllers.forEach((controller, index) => { releases.push(runtime.enqueue(() => started.push(index), controller.signal)); });
  clock.advance(0);
  assert.deepEqual(started, [0]);
  clock.advance(1_000);
  assert.deepEqual(started, [0, 1]);
  clock.advance(30_000);
  assert.deepEqual(started, [0, 1]);
  controllers[2].abort();
  releases[0]();
  clock.advance(0);
  assert.deepEqual(started, [0, 1, 3]);
  releases[1]();
  clock.advance(999);
  assert.deepEqual(started, [0, 1, 3]);
  clock.advance(1);
  assert.deepEqual(started, [0, 1, 3, 4]);
  controllers.forEach(controller => controller.abort());
  assert.equal(clock.timers.size, 0);
  clock.advance(60_000);
  assert.deepEqual(started, [0, 1, 3, 4]);
});
