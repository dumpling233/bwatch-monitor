import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { distributionBase, getExtensionBrowser, parseExtensionPackages, ExtensionPackagesCache, type ExtensionPackage } from '../client/multiview/extensionDistribution';
import { fetchExtensionPackageBlob } from '../client/multiview/extensionPackageDownload';
import { compareExtensionVersions, describeExtensionUpdate, expectedExtensionFeatures, isExtensionUpdateSatisfied, supportsMedalRoomContext } from '../client/multiview/extensionUpdates';
import { SITE_ORIGIN, SITE_BASE_PATH } from '../shared/site';

const archive = new TextEncoder().encode('verified chromium test archive');
const item: ExtensionPackage = { browser: 'chrome', variant: 'production', version: '0.1.0',
  url: 'downloads/bwatch-monitor-extension-0.1.0.zip', bytes: archive.byteLength,
  sha256: createHash('sha256').update(archive).digest('hex') };
const manifest = { schemaVersion: 1, packages: [item] };
const capabilities = [...expectedExtensionFeatures.map(feature => feature.capability), 'following-status', 'medals', 'medal-room-context'];
test('file distribution supports Pages subpath and Chrome/Edge with one production package', () => {
  assert.equal(distributionBase(SITE_ORIGIN), SITE_BASE_PATH);
  assert.equal(distributionBase('http://localhost:5173'), '/');
  assert.equal(distributionBase('https://bwatch.icu'), null);
  assert.equal(distributionBase(SITE_ORIGIN + '/untrusted'), null);
  assert.equal(parseExtensionPackages(manifest, SITE_ORIGIN)?.chrome?.url, item.url);
  assert.equal(parseExtensionPackages({ schemaVersion: 1, packages: [item, item] }, SITE_ORIGIN), null);
  assert.equal(parseExtensionPackages({ schemaVersion: 1, packages: [{ ...item, browser: 'firefox' }] }, SITE_ORIGIN), null);
  assert.equal(parseExtensionPackages({ schemaVersion: 1, packages: [{ ...item, url: '../escape.zip' }] }, SITE_ORIGIN), null);
  assert.equal(parseExtensionPackages({ schemaVersion: 1, packages: [{ ...item, variant: 'local' }] }, SITE_ORIGIN), null);
  assert.equal(getExtensionBrowser('Mozilla Chrome/131.0 Edg/131.0'), 'edge');
  assert.equal(getExtensionBrowser('Mozilla Chrome/131.0'), 'chrome');
  assert.equal(getExtensionBrowser('Mozilla Firefox/140.0'), 'other');
});
test('0.1.0 capabilities and actual HELLO prove file update completion', () => {
  const view = describeExtensionUpdate({ browser: 'edge', installedVersion: '0.0.9', capabilities: [], packages: { chrome: item } });
  assert.equal(view.download, item);
  assert.equal(view.updateAvailable, true);
  assert.equal(isExtensionUpdateSatisfied(view.target, '0.1.0', capabilities), true);
  assert.equal(isExtensionUpdateSatisfied(view.target, '0.1.0', []), false);
  assert.equal(supportsMedalRoomContext('0.1.0', capabilities), true);
  assert.equal(compareExtensionVersions('0.1.10', '0.1.2'), 1);
  assert.equal(describeExtensionUpdate({ browser: 'chrome', installedVersion: '0.2.0', capabilities, packages: { chrome: item } }).downloadTarget, null);
});
test('download verifies size and SHA-256 and uses the Pages subpath', async () => {
  let requested = '';
  const fetcher: typeof fetch = async input => { requested = String(input); return new Response(archive, { headers: { 'content-length': String(archive.byteLength) } }); };
  const blob = await fetchExtensionPackageBlob(item, new AbortController().signal, { origin: SITE_ORIGIN, fetch: fetcher });
  assert.equal(requested, SITE_ORIGIN + SITE_BASE_PATH + item.url);
  assert.equal(blob.size, archive.byteLength);
  await assert.rejects(fetchExtensionPackageBlob({ ...item, sha256: '0'.repeat(64) }, new AbortController().signal, { origin: SITE_ORIGIN, fetch: fetcher }), /SHA-256/);
  await assert.rejects(fetchExtensionPackageBlob(item, new AbortController().signal, { origin: SITE_ORIGIN, fetch: async () => new Response('<html>missing</html>', { headers: { 'content-type': 'text/html' } }) }), /安装包/);
  await assert.rejects(fetchExtensionPackageBlob({ ...item, url: '/outside.zip' }, new AbortController().signal, { origin: SITE_ORIGIN, fetch: fetcher }), /信息无效/);
});
test('manifest cache fetches the static file once and isolates cancelled consumers', async () => {
  let calls = 0, release!: (value: Response) => void;
  const cache = new ExtensionPackagesCache({ fetch: async () => { calls++; return new Promise<Response>(resolve => { release = resolve; }); } });
  const first = new AbortController(), second = new AbortController();
  const cancelled = cache.load(SITE_ORIGIN, first.signal);
  const shared = cache.load(SITE_ORIGIN, second.signal);
  first.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  release(new Response(JSON.stringify(manifest)));
  assert.equal((await shared).packages?.chrome?.version, '0.1.0');
  await cache.load(SITE_ORIGIN, new AbortController().signal);
  assert.equal(calls, 1);
});
