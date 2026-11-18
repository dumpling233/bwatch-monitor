import assert from 'node:assert/strict';
import test from 'node:test';
import { audioApiUrl, AUDIO_USER_AGENT, isAudioApiUrl } from '../lib/audioApi';
import { LocalAudioPlayback, parseAudioPlayback } from '../lib/audioPlayback';
import { AudioMediaRules, AUDIO_RULE_IDS } from '../lib/audioMediaRules';
import { LocalCookieTransport } from '../lib/cookieTransport';

const now = 1_800_000_000_000;
const room = '7734200';
const sourceUrl = 'https://audio.bilivideo.com/live/audio.flv?media_type=1&ptype=1';
const owner = { tabId: 7, origin: 'https://bwatch.icu', document: 'document-one' };
function data(host = 'http://audio.bilivideo.com', extra = 'media_type=1&ptype=1') {
  return { live_status: 1, playurl_info: { playurl: { g_qn_desc: [{ qn: 150, desc: '高清' }], stream: [
    { protocol_name: 'http_stream', format: [{ format_name: 'flv', codec: [{ codec_name: 'avc', current_qn: 150, accept_qn: [150],
      base_url: '/live/audio.flv?', url_info: [{ host, extra }] }] }] },
    { protocol_name: 'http_hls', format: [{ format_name: 'fmp4', codec: [{ codec_name: 'avc', current_qn: 150, accept_qn: [150],
      base_url: '/live/index.m3u8?', url_info: [{ host, extra }] }] }] },
  ] } } };
}
const payload = () => new Response(JSON.stringify({ code: 0, data: data() }));

test('audio API accepts only its complete fixed anonymous parameter profile', () => {
  const url = audioApiUrl(room, now);
  assert.equal(isAudioApiUrl(url), true);
  assert.equal(url.searchParams.get('media_type'), '1');
  assert.equal(url.searchParams.get('only_audio'), '1');
  assert.equal(url.searchParams.get('qn'), '150');
  for (const [key, value] of [['qn', '10000'], ['platform', 'web'], ['url', 'https://example.com/']]) {
    const altered = new URL(url); altered.searchParams.set(key, value); assert.equal(isAudioApiUrl(altered), false);
  }
  const duplicate = new URL(url); duplicate.searchParams.append('room_id', room); assert.equal(isAudioApiUrl(duplicate), false);
});

test('audio parsing upgrades trusted HTTP CDN origins and excludes HLS, unknown hosts and ordinary media', () => {
  const info = parseAudioPlayback(data(), room, now);
  assert.equal(info.status, 'live'); assert.equal(info.sources.length, 1);
  assert.equal(info.sources[0].url, sourceUrl);
  assert.equal(info.sources[0].codec, 'avc'); // Metadata does not prove a video track exists.
  for (const host of ['http://evil.example.com', 'http://127.0.0.1', 'https://audio.bilivideo.net', 'https://audio.bilivideo.com/path'])
    assert.equal(parseAudioPlayback(data(host), room, now).sources.length, 0);
  assert.equal(parseAudioPlayback(data(undefined, 'media_type=0'), room, now).sources.length, 0);
});

test('anonymous app transport never reads cookies and precisely installs app request headers', async () => {
  const rules: chrome.declarativeNetRequest.UpdateRuleOptions[] = [];
  const transport = new LocalCookieTransport({ extensionId: 'extension-id', getCookies: async () => { throw new Error('must not read cookies'); },
    updateRules: async options => { rules.push(options); } });
  const url = audioApiUrl(room, now);
  await transport.run(url, 'anonymous', new AbortController().signal, async cookies => {
    assert.deepEqual(cookies, {});
    const rule = rules.at(-1)!.addRules![0];
    assert.equal(rule.condition.regexFilter, `^${url.href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
    assert.deepEqual(rule.action.requestHeaders?.find(header => header.header === 'User-Agent'), { header: 'User-Agent', operation: 'set', value: AUDIO_USER_AGENT });
    assert.equal(rule.action.requestHeaders?.find(header => header.header === 'Cookie')?.operation, 'remove');
  });
  assert.ok(rules.at(-1)!.removeRuleIds?.length);
  await assert.rejects(transport.run(url, 'authenticated', new AbortController().signal, async () => {}));
});

test('audio configuration is requested on demand, coalesces consumers and reuses a short cache without account checks', async () => {
  let requests = 0, clock = now;
  const service = new LocalAudioPlayback({ now: () => clock,
    transport: { run: async (_url, mode, _signal, operation) => { assert.equal(mode, 'anonymous'); return operation({}, _signal); } },
    fetch: async (_input, init) => { requests++; assert.equal(init?.credentials, 'omit'); return payload(); } });
  const signal = new AbortController().signal;
  const [first, second] = await Promise.all([service.resolve(room, false, signal), service.resolve(room, false, signal)]);
  assert.equal(first, second); assert.equal(requests, 1);
  await service.resolve(room, false, signal); assert.equal(requests, 1);
  clock += 31000; await service.resolve(room, false, signal); assert.equal(requests, 2);
  await assert.rejects(service.resolve('https://example.com', false, signal));
});

test('cancelling one shared source consumer does not cancel the other', async () => {
  let finish!: (value: Response) => void;
  let upstreamSignal: AbortSignal | undefined;
  const service = new LocalAudioPlayback({ now: () => now,
    transport: { run: async (_url, _mode, signal, operation) => operation({}, signal) },
    fetch: async (_url, init) => { upstreamSignal = init?.signal ?? undefined; return new Promise<Response>(resolve => { finish = resolve; }); } });
  const one = new AbortController(), two = new AbortController();
  const first = service.resolve(room, false, one.signal), second = service.resolve(room, false, two.signal);
  one.abort(); await assert.rejects(first, { name: 'AbortError' });
  assert.equal(upstreamSignal?.aborted, false);
  finish(payload()); assert.equal((await second).sources.length, 1);
});

test('oversized upstream configuration stops reading before accepting a source', async () => {
  let cancelledBody = false;
  const service = new LocalAudioPlayback({ now: () => now,
    transport: { run: async (_url, _mode, signal, operation) => operation({}, signal) },
    fetch: async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(256 * 1024)); },
      cancel() { cancelledBody = true; },
    })) });
  await assert.rejects(service.resolve(room, false, new AbortController().signal));
  assert.equal(cancelledBody, true);
});

test('media rules isolate tab, exact URL and method, share URL references and reject foreign release', async () => {
  const updates: chrome.declarativeNetRequest.UpdateRuleOptions[] = []; let next = 0;
  const manager = new AudioMediaRules({ id: () => `lease-${++next}`, updateRules: async update => { updates.push(update); } });
  const signal = new AbortController().signal;
  const first = await manager.acquire(owner, [sourceUrl], signal), second = await manager.acquire(owner, [sourceUrl], signal);
  assert.equal(updates.length, 1);
  const rule = updates[0].addRules![0];
  assert.deepEqual(rule.condition.tabIds, [7]); assert.deepEqual(rule.condition.requestMethods, ['get']);
  assert.equal(rule.condition.urlFilter, `|${sourceUrl}|`);
  assert.equal(rule.action.requestHeaders?.find(header => header.header === 'Cookie')?.operation, 'remove');
  await assert.rejects(manager.release({ ...owner, document: 'new-document' }, first));
  await assert.rejects(manager.release({ ...owner, tabId: 8 }, first));
  await manager.release(owner, first); assert.equal(updates.length, 1);
  await manager.release(owner, second); assert.deepEqual(updates.at(-1)?.removeRuleIds, [rule.id]);
  await manager.release(owner, second); // Idempotent, including a restarted background.
});

test('page/tab cleanup preserves other tabs and startup resets only the dedicated media range', async () => {
  const updates: chrome.declarativeNetRequest.UpdateRuleOptions[] = []; let next = 0;
  const manager = new AudioMediaRules({ id: () => `lease-${++next}`, updateRules: async update => { updates.push(update); } });
  const signal = new AbortController().signal;
  await manager.acquire(owner, [sourceUrl], signal);
  const otherOwner = { ...owner, tabId: 8 }; const other = await manager.acquire(otherOwner, [sourceUrl], signal);
  await manager.releaseDocument(owner);
  assert.deepEqual(updates.at(-1)?.removeRuleIds, [3000]);
  await manager.release(otherOwner, other); assert.deepEqual(updates.at(-1)?.removeRuleIds, [3001]);
  await manager.reset(); assert.deepEqual(updates.at(-1)?.removeRuleIds, AUDIO_RULE_IDS);
  assert.equal(AUDIO_RULE_IDS.includes(2000), false); assert.equal(AUDIO_RULE_IDS.includes(1000), false);
});

test('abort during rule installation removes the new rules before returning', async () => {
  const controller = new AbortController(); const updates: chrome.declarativeNetRequest.UpdateRuleOptions[] = [];
  const manager = new AudioMediaRules({ updateRules: async update => { updates.push(update); if (update.addRules) controller.abort(); } });
  await assert.rejects(manager.acquire(owner, [sourceUrl], controller.signal), { name: 'AbortError' });
  assert.deepEqual(updates.at(-1)?.removeRuleIds, [3000]);
});
