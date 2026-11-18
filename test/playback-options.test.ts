import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPlaybackOptions, playbackQualityLabel, playbackQualityOptionLabel } from '../client/multiview/playbackOptions.js';
import type { PlaybackInfo, PlaybackSource } from '../shared/playback.js';

const sd = { qn: 250, label: '超清' };
const original = { qn: 10000, label: '原画', detail: '1920×1080' };
const source = (id: string, format: PlaybackSource['format'], qualities = [sd]): PlaybackSource => ({
  id, url: `https://same.bilivideo.com/${id}`, protocol: format === 'flv' ? 'flv' : 'hls', format, codec: 'avc', actualQuality: 250, qualities,
});
const info = (sources: PlaybackSource[]): PlaybackInfo => ({ roomId: '1', status: 'live', requestedQuality: 250,
  qualities: [sd, original], sources, resolvedAt: 10 });

test('automatic format menu unions every compatible branch rather than the currently selected source', () => {
  const data = info([source('flv', 'flv'), source('hls', 'fmp4', [sd, original])]);
  const options = buildPlaybackOptions(data);
  assert.deepEqual(options.qualities, [sd, original]);
  assert.deepEqual(options.formats.map(option => option.value), ['auto', 'flv', 'hls-fmp4']);
  assert.deepEqual(buildPlaybackOptions(data, 'flv').qualities, [sd]);
  assert.deepEqual(buildPlaybackOptions(data, 'flv').allQualities, [sd, original]);
});

test('declared capability without this request URL remains a menu option but never creates a playback source', () => {
  const data = { ...info([source('flv', 'flv')]), capabilities: [
    { protocol: 'flv' as const, format: 'flv' as const, codec: 'avc' as const, qualities: [sd] },
    { protocol: 'hls' as const, format: 'ts' as const, codec: 'avc' as const, qualities: [sd, original] },
  ] };
  const options = buildPlaybackOptions(data, 'hls-ts');
  assert.deepEqual(options.qualities, [sd, original]);
  assert.deepEqual(options.sources, []);
});

test('browser compatibility filters branch options and URLs consistently', () => {
  const data = info([source('flv', 'flv', [sd, original]), source('ts', 'ts')]);
  const options = buildPlaybackOptions(data, 'auto', branch => branch.protocol === 'hls');
  assert.deepEqual(options.qualities, [sd]);
  assert.deepEqual(options.formats.map(option => option.value), ['auto', 'hls-ts']);
  assert.deepEqual(options.sources.map(item => item.id), ['ts']);
});

test('unloaded, offline and empty snapshots do not invent fixed quality options', () => {
  assert.deepEqual(buildPlaybackOptions(undefined).qualities, []);
  assert.deepEqual(buildPlaybackOptions({ ...info([]), status: 'offline' }).qualities, []);
  assert.deepEqual(buildPlaybackOptions(info([])).formats, []);
});

test('legacy snapshots use source branch qualities and only fall back to aggregate when absent', () => {
  const data = info([{ ...source('flv', 'flv'), qualities: undefined }, source('hls', 'fmp4')]);
  assert.deepEqual(buildPlaybackOptions(data, 'flv').qualities, [sd, original]);
  assert.deepEqual(buildPlaybackOptions(data, 'hls-fmp4').qualities, [sd]);
});

test('same host addresses remain independent candidates and a missing saved format is not silently substituted', () => {
  const data = info([source('a', 'flv'), source('b', 'flv')]);
  assert.equal(buildPlaybackOptions(data).sources.length, 2);
  const unavailable = buildPlaybackOptions(data, 'hls-fmp4');
  assert.deepEqual(unavailable.sources, []);
  assert.deepEqual(unavailable.qualities, []);
});

test('new upstream quality IDs and optional detail survive union without changing actual quality', () => {
  const fresh = { qn: 50000, label: '新档位', detail: '上游说明' };
  const data = info([source('flv', 'flv', [sd, fresh])]);
  const options = buildPlaybackOptions(data);
  assert.deepEqual(options.qualities, [sd, fresh]);
  assert.equal(options.sources[0]?.actualQuality, 250);
  assert.equal(playbackQualityLabel(50000, { ...data, qualities: [fresh] }), '新档位 上游说明');
  assert.equal(playbackQualityLabel(50000), '其他清晰度');
});

test('upstream brief and detailed quality names combine without repeated resolutions', () => {
  assert.equal(playbackQualityOptionLabel({ qn: 10000, label: '1080P', detail: '1080P 原画' }), '1080P 原画');
  assert.equal(playbackQualityOptionLabel({ qn: 400, label: '1080P', detail: '蓝光' }), '1080P 蓝光');
  assert.equal(playbackQualityOptionLabel({ qn: 250, label: '720P', detail: '720P 超清' }), '720P 超清');
  assert.equal(playbackQualityOptionLabel({ qn: 10000, label: '1080P 原画', detail: '1080P' }), '1080P 原画');
  assert.equal(playbackQualityOptionLabel({ qn: 10000, label: '1080P', detail: '1080p' }), '1080p');
});

test('quality captions prefer available detailed names and hide unknown technical IDs', () => {
  const data: PlaybackInfo = { ...info([]), qualities: [{ qn: 10000, label: '1080P' }], capabilities: [
    { protocol: 'hls', format: 'fmp4', codec: 'avc', qualities: [{ qn: 10000, label: '1080P', detail: '原画' }] },
  ] };
  assert.equal(playbackQualityLabel(10000, data), '1080P 原画');
  const unknown: PlaybackInfo = { ...info([]), qualities: [{ qn: 50000, label: 'QN 50000' }, { qn: 60000, label: 'QN 60000' }] };
  assert.equal(playbackQualityLabel(50000, unknown), '其他清晰度 1');
  assert.equal(playbackQualityLabel(60000, unknown), '其他清晰度 2');
});
