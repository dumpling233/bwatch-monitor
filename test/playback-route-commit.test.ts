import assert from 'node:assert/strict';
import test from 'node:test';
import { PlaybackRouteCommitGuard } from '../client/multiview/playbackRouteCommit.js';

const identity = (auth = 'account:a', rpc = 'worker:a', visibility = 'permission:a') => JSON.stringify([auth, rpc, visibility]);
const rooms = () => new Map([['1', { source: 'custom' as const }]]);

for (const next of [identity('anonymous'), identity('account:b'), identity('account:a', 'worker:b'), identity('account:a', 'worker:a', 'permission:b')])
  test(`a route settled before old passive cleanup cannot cross scope ${next}`, async () => {
    const guard = new PlaybackRouteCommitGuard(); guard.update(identity(), ['1'], rooms());
    const canCommit = guard.capture('1', 'custom'); let commits = 0;
    // The old menu promise is already ready, but the parent has rendered a new identity.
    const result = Promise.resolve().then(() => { if (canCommit()) commits++; });
    guard.update(next, ['1'], rooms());
    await result; assert.equal(commits, 0);
  });

test('ordinary renders preserve a pending route, while removing and readding a room invalidates its generation', async () => {
  const guard = new PlaybackRouteCommitGuard(); guard.update(identity(), ['1'], rooms());
  const valid = guard.capture('1', 'custom');
  guard.update(identity(), ['1'], rooms()); assert.equal(valid(), true);
  guard.update(identity(), [], rooms()); assert.equal(valid(), false);
  guard.update(identity(), ['1'], rooms()); assert.equal(valid(), false, 'readding a room must not revive a pending selection');
  const readded = guard.capture('1', 'custom');
  assert.equal(readded(), true);
  guard.update(identity('anonymous'), ['1'], rooms());
  assert.equal(readded(), false); assert.equal(guard.capture('1', 'custom')(), true);
});
