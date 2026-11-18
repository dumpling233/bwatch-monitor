import test from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import { validateArchive, validateDescriptor, descriptor, siteContract } from '../scripts/extension-downloads.mjs';

const site = siteContract();
const manifest = { manifest_version: 3, version: '0.1.0', minimum_chrome_version: '120', incognito: 'not_allowed',
  permissions: ['storage', 'cookies', 'declarativeNetRequestWithHostAccess', 'scripting'],
  host_permissions: ['https://*.bilibili.com/*', site.origin + '/*', 'https://*.bilivideo.com/*', 'https://*.bilivideo.cn/*'],
  background: { service_worker: 'background.js' }, action: { default_popup: 'popup.html' },
  content_scripts: [{ matches: [site.origin + site.base + '*'], js: ['content.js'], all_frames: false }] };
function archive(value = manifest, omitContent = false) {
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(value)));
  zip.addFile('background.js', Buffer.from(''));
  zip.addFile('popup.html', Buffer.from('<!doctype html>'));
  if (!omitContent) zip.addFile('content.js', Buffer.from(''));
  return zip.toBuffer();
}
test('production archive validates exact Pages origin, entrypoints and descriptor integrity', () => {
  const bytes = archive();
  assert.equal(validateArchive(bytes, '0.1.0', manifest).version, '0.1.0');
  const item = descriptor(bytes, '0.1.0');
  validateDescriptor(item, '0.1.0');
  assert.equal(item.bytes, bytes.length);
  assert.equal(item.url, 'downloads/bwatch-monitor-extension-0.1.0.zip');
  assert.throws(() => validateDescriptor({ ...item, url: '/other.zip' }, '0.1.0'), /descriptor/);
});
test('production archive rejects local permissions, missing entrypoints and version mismatch', () => {
  assert.throws(() => validateArchive(archive({ ...manifest, host_permissions: [...manifest.host_permissions, 'http://localhost/*'] }), '0.1.0'), /permissions/);
  assert.throws(() => validateArchive(archive(manifest, true), '0.1.0'), /entrypoint/);
  assert.throws(() => validateArchive(archive(), '0.1.1'), /manifest/);
  assert.throws(() => validateArchive(archive({ ...manifest, content_scripts: [{ matches: ['https://*.github.io/*'], js: ['content.js'] }] }), '0.1.0'), /allowlist/);
});
