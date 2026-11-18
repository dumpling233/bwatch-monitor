import test from 'node:test';
import assert from 'node:assert/strict';
import { EMOTE_GROUP_CELL_LIMIT, retainEmoteGroups } from '../client/multiview/danmaku/emoteGroupRetention.js';

test('only visited packages are retained, and revisiting makes one most recently used', () => {
  const groups = [{ id: 'default', count: 140 }, { id: 'common', count: 38 }, { id: 'room', count: 20 }];
  assert.deepEqual(retainEmoteGroups([], groups, 'default'), ['default']);
  assert.deepEqual(retainEmoteGroups(['default'], groups, 'common'), ['default', 'common']);
  assert.deepEqual(retainEmoteGroups(['default', 'common'], groups, 'default'), ['common', 'default']);
  assert.deepEqual(retainEmoteGroups(['common', 'default'], groups, 'room'), ['common', 'default', 'room']);
});

test('cell pressure evicts the least recently visited package and always keeps the current one', () => {
  const groups = [{ id: 'default', count: 140 }, { id: 'common', count: 38 }, { id: 'room', count: 80 }];
  assert.deepEqual(retainEmoteGroups(['default', 'common'], groups, 'room'), ['common', 'room']);
  assert.deepEqual(retainEmoteGroups(['common', 'room'], groups, 'common'), ['room', 'common']);
  assert.deepEqual(retainEmoteGroups(['room', 'common'], groups, 'default'), ['common', 'default']);
  assert.deepEqual(retainEmoteGroups([], [{ id: 'full', count: EMOTE_GROUP_CELL_LIMIT }], 'full'), ['full']);
});

test('large virtual packages are shown alone and are not retained after leaving them', () => {
  const groups = [{ id: 'default', count: EMOTE_GROUP_CELL_LIMIT + 1 }, { id: 'common', count: 38 }, { id: 'room', count: 20 }];
  assert.deepEqual(retainEmoteGroups(['common', 'room'], groups, 'default'), ['default']);
  assert.deepEqual(retainEmoteGroups(['default'], groups, 'common'), ['common']);
});

test('catalogue changes discard removed packages and reapply the budget after a package grows', () => {
  const groups = [{ id: 'default', count: 180 }, { id: 'common', count: 50 }];
  assert.deepEqual(retainEmoteGroups(['removed', 'common', 'common'], groups, 'default'), ['default']);
  assert.deepEqual(retainEmoteGroups(['default'], groups, 'removed'), []);
});

test('many package visits remain bounded independently of catalogue size', () => {
  const groups = Array.from({ length: 120 }, (_, index) => ({ id: String(index), count: 10 + index % 80 }));
  let retained: string[] = [];
  for (let visit = 0; visit < 600; visit++) {
    const current = groups[(visit * 17) % groups.length];
    retained = retainEmoteGroups(retained, groups, current.id);
    assert.equal(retained.at(-1), current.id);
    assert.equal(new Set(retained).size, retained.length);
    assert.ok(retained.reduce((sum, id) => sum + groups[Number(id)].count, 0) <= EMOTE_GROUP_CELL_LIMIT);
  }
});
