import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectEmoticons } from '../lib/emoticons';

const emote = (unique: string, extra: Record<string, unknown> = {}) => ({ emoticon_unique: unique, emoji: unique,
  url: 'https://i0.hdslb.com/bfs/emote/test.png', perm: 1, ...extra });

test('preserves the ordered official packages and image-backed inline descriptors', () => {
  const result = projectEmoticons([
    { pkg_id: 10, pkg_type: 3, pkg_name: '默认表情', current_cover: '//i0.hdslb.com/default.png',
      emoticons: [emote('dog', { emoji: 'dog', descript: '[dog]', perm: 0 })] },
    { pkg_id: 'global', pkg_type: 1, pkg_name: '通用大表情', emoticons: [emote('global_1')] },
    { pkg_id: 'room', pkg_type: 2, pkg_name: '主播表情', current_cover: 'http://i0.hdslb.com/room.png',
      emoticons: [emote('room_1', { is_dynamic: 1, width: 140, height: 140 })] },
    // The official UI renders every returned package, not a type whitelist.
    { pkg_type: 9, pkg_name: '新增分类', emoticons: [emote('future_1')] },
  ]);
  assert.deepEqual(result.emoticonPackages.map(pkg => pkg.name), ['默认表情', '通用大表情', '主播表情', '新增分类']);
  assert.deepEqual(result.emoticonPackages.map(pkg => pkg.emoticonUniques), [['dog'], ['global_1'], ['room_1'], ['future_1']]);
  assert.equal(result.emoticonPackages[0].id, '10');
  assert.equal(result.emoticonPackages[2].icon, 'https://i0.hdslb.com/room.png');
  assert.equal(result.emoticons[0].text, '[dog]'); assert.equal(result.emoticons[0].kind, 'text');
  assert.equal(result.emoticons[0].url, 'https://i0.hdslb.com/bfs/emote/test.png');
  assert.equal(result.emoticons[0].permitted, true, 'a draft insertion does not grant image sending');
  assert.equal(result.emoticons[2].dynamic, true); assert.equal(result.emoticons[2].width, 140);
  assert.equal(result.emoticons[3].kind, 'image'); assert.equal(result.emoticonsTruncated, false);
});

test('inline entries without a big-emote ID remain visible and insert their actual descriptor', () => {
  const result = projectEmoticons([{ pkg_type: 3, emoticons: [{ emoji: '花', descript: '[花]', url: 'http://i0.hdslb.com/flower.png' }] }]);
  assert.equal(result.emoticons.length, 1); assert.equal(result.emoticons[0].unique, 'inline:0:0');
  assert.equal(result.emoticons[0].text, '[花]'); assert.equal(result.emoticons[0].url, 'https://i0.hdslb.com/flower.png');
});

test('detailed locked reasons preserve room scope, fan level and guard rank without guessing account ownership', () => {
  const result = projectEmoticons([
    { pkg_type: 1, emoticons: [emote('any_fans', { perm: 0, identity: 4, unlock_show_text: '粉丝团', unlock_need_level: 1 }),
      emote('any_guard', { perm: 0, identity: 3 })] },
    { pkg_type: 2, emoticons: [emote('room_fans', { perm: 0, identity: 4, unlock_need_level: 20, unlock_show_text: '粉丝团' }),
      emote('room_admiral', { perm: 0, identity: 2, unlock_show_text: '提督' }), emote('room_governor', { perm: 0, identity: 1 })] },
  ]);
  assert.deepEqual(result.emoticons.map(item => item.unlockHint), ['需要加入任一主播的粉丝团', '需要开通任一主播的舰长',
    '需要本直播间主播的粉丝团等级达到 20 级', '需要开通本直播间主播的提督', '需要开通本直播间主播的总督']);
  assert.equal(result.emoticons[2].unlockLabel, '粉丝团');
  assert.equal(result.emoticons.every(item => item.permitted === false), true);
});

test('labels and guard identities cannot manufacture a positive image permission', () => {
  const result = projectEmoticons([{ pkg_type: 2, emoticons: [emote('missing', { perm: undefined, identity: 1 }),
    emote('string', { perm: '1', identity: 3 }), emote('yes', { perm: 1, identity: 4, unlock_need_level: 99 })] }]);
  assert.deepEqual(result.emoticons.map(item => item.permitted), [false, false, true]);
});

test('image CDN validation upgrades legacy URLs and rejects other origins, credentials and ports', () => {
  const accepted = ['//i0.hdslb.com/a.png', 'http://i1.hdslb.com/b.png', 'https://hdslb.com/c.png',
    'https://i0.biliimg.com/d.png', '//biliimg.com/e.png'];
  const rejected = ['https://i0.hdslb.com.evil.test/image', 'https://biliimg.com.evil.test/image',
    'https://user@i0.hdslb.com/image', 'https://i0.hdslb.com:8443/image', 'data:image/png;base64,abc',
    'https://i0.biliimg.com/a.png#fragment', 'https://i0.hdslb.com/a b.png', 'https://i0.hdslb.com/a\\b.png',
    'https://i0.hdslb.com/a\nb.png'];
  const result = projectEmoticons([{ pkg_type: 3, current_cover: rejected[0], emoticons: [...accepted, ...rejected].map((url, i) => emote(String(i), { url })) }]);
  assert.deepEqual(result.emoticons.map(item => item.url), ['https://i0.hdslb.com/a.png', 'https://i1.hdslb.com/b.png', 'https://hdslb.com/c.png',
    'https://i0.biliimg.com/d.png', 'https://biliimg.com/e.png', ...rejected.map(() => '')]);
  assert.equal(result.emoticonPackages[0].icon, '');
});

test('image URLs fit the 2048-character webpage contract after normalization', () => {
  const prefix = 'https://i0.biliimg.com/';
  const atLimit = prefix + 'a'.repeat(2048 - prefix.length);
  const tooLong = atLimit + 'a';
  const expanded = prefix + '图'.repeat(230);
  const result = projectEmoticons([{ pkg_type: 2, current_cover: atLimit,
    emoticons: [emote('limit', { url: atLimit }), emote('long', { url: tooLong }), emote('expanded', { url: expanded })] }]);
  assert.equal(result.emoticonPackages[0].icon, atLimit);
  assert.deepEqual(result.emoticons.map(item => item.url), [atLimit, '', '']);
});

test('retains room packages beyond the previous 128 and 500 flattened entry cutoffs', () => {
  const result = projectEmoticons([
    { pkg_type: 3, pkg_name: '默认', emoticons: Array.from({ length: 260 }, (_, i) => emote(`small_${i}`)) },
    { pkg_type: 1, pkg_name: '通用', emoticons: Array.from({ length: 260 }, (_, i) => emote(`general_${i}`)) },
    { pkg_type: 2, pkg_name: '房间', emoticons: [emote('room_own', { perm: 0, identity: 3 })] },
  ]);
  assert.equal(result.emoticons.length, 521); assert.equal(result.emoticonPackages[2].emoticonUniques[0], 'room_own');
  assert.equal(result.emoticons.at(-1)?.packageId, result.emoticonPackages[2].id);
  assert.equal(result.emoticonsTruncated, false);
});

test('bounds very large directories and marks partial results rather than pretending they are complete', () => {
  const result = projectEmoticons([{ pkg_type: 2, emoticons: Array.from({ length: 2100 }, (_, i) => emote(`item_${i}`)) }]);
  assert.equal(result.emoticons.length, 2048); assert.equal(result.emoticonsTruncated, true);
  const large = projectEmoticons(Array.from({ length: 70 }, (_, i) => ({ pkg_id: i, pkg_type: 2, emoticons: [] })));
  assert.equal(large.emoticonPackages.length, 64); assert.equal(large.emoticonsTruncated, true);
});

test('keeps the projected directory byte-bounded, including repeated group references', () => {
  const items = Array.from({ length: 2000 }, (_, i) => emote(`long_${i}_${'u'.repeat(180)}`, {
    emoji: '名'.repeat(100), url: `https://i0.hdslb.com/${'a'.repeat(1800)}.png`, unlock_show_text: '限'.repeat(200),
  }));
  const result = projectEmoticons(Array.from({ length: 64 }, (_, i) => ({ pkg_id: i, pkg_type: 2, emoticons: items })));
  assert.equal(result.emoticonsTruncated, true); assert.ok(JSON.stringify(result).length * 2 < 2 * 1024 * 1024);
});

test('duplicate IDs preserve ordered group membership and do not upgrade locked entries', () => {
  const result = projectEmoticons([{ pkg_id: 1, pkg_type: 2, emoticons: [emote('same', { perm: 0 })] },
    { pkg_id: 1, pkg_type: 2, emoticons: [emote('same', { perm: 1 }), emote('same', { perm: 1 })] }]);
  assert.equal(result.emoticons.length, 1); assert.equal(result.emoticons[0].permitted, false);
  assert.notEqual(result.emoticonPackages[0].id, result.emoticonPackages[1].id);
  assert.deepEqual(result.emoticonPackages[1].emoticonUniques, ['same']);
});

test('duplicate IDs fill only a missing safe image without granting send permission or borrowing other IDs', () => {
  const result = projectEmoticons([
    { pkg_id: 1, pkg_type: 2, emoticons: [emote('same', { url: 'https://evil.example/a.png', perm: 0 }),
      emote('missing', { url: '' }), emote('stable')] },
    { pkg_id: 2, pkg_type: 2, emoticons: [emote('same', { url: 'https://i0.biliimg.com/recovered.png', perm: 1 }),
      emote('stable', { url: 'https://i0.hdslb.com/replacement.png', perm: 0 }), emote('other')] },
  ]);
  assert.equal(result.emoticons[0].url, 'https://i0.biliimg.com/recovered.png');
  assert.equal(result.emoticons[0].permitted, false);
  assert.equal(result.emoticons[1].url, '');
  assert.equal(result.emoticons[2].url, 'https://i0.hdslb.com/bfs/emote/test.png');
  assert.equal(result.emoticons[2].permitted, false);
  assert.deepEqual(result.emoticonPackages.map(group => group.emoticonUniques), [['same', 'missing', 'stable'], ['same', 'stable', 'other']]);
});

test('repairing duplicate image URLs cannot bypass the directory payload budget', () => {
  const items = Array.from({ length: 600 }, (_, i) => emote(`shared_${i}`, { url: '' }));
  const images = items.map(item => ({ ...item, url: `https://i0.biliimg.com/${'a'.repeat(1800)}.png` }));
  const result = projectEmoticons([{ pkg_id: 1, pkg_type: 2, emoticons: items }, { pkg_id: 2, pkg_type: 2, emoticons: images }]);
  const restoredImages = result.emoticons.filter(item => item.url).length;
  assert.ok(restoredImages > 0 && restoredImages < items.length);
  assert.equal(result.emoticonsTruncated, true);
  assert.ok(JSON.stringify(result).length * 2 < 1600 * 1024);
});

test('lock labels and fallback hints fit the webpage contract without losing the whole item', () => {
  const result = projectEmoticons([{ pkg_type: 2, emoticons: [emote('long_hint', { perm: 0, unlock_show_text: '条件'.repeat(120) })] }]);
  assert.equal(result.emoticons[0].unlockHint?.length, 160);
  assert.equal(result.emoticons[0].unlockLabel?.length, 40);
  assert.equal(result.emoticons[0].permitted, false);
});

test('cross-package duplicate references have a separate bounded budget', () => {
  const items = Array.from({ length: 100 }, (_, i) => emote(`shared_${i}`));
  const complete = projectEmoticons(Array.from({ length: 30 }, (_, i) => ({ pkg_id: i, pkg_type: 2, emoticons: items })));
  assert.equal(complete.emoticons.length, 100);
  assert.equal(complete.emoticonPackages.reduce((sum, pkg) => sum + pkg.emoticonUniques.length, 0), 3000);
  assert.equal(complete.emoticonsTruncated, false);
  const bounded = projectEmoticons(Array.from({ length: 64 }, (_, i) => ({ pkg_id: i, pkg_type: 2, emoticons: items })));
  assert.equal(bounded.emoticons.length, 100);
  assert.equal(bounded.emoticonPackages.reduce((sum, pkg) => sum + pkg.emoticonUniques.length, 0), 4096);
  assert.equal(bounded.emoticonsTruncated, true);
});
