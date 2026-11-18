import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import AdmZip from 'adm-zip';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const metadataName = 'bwatch-monitor-extension.json';
export const maximumArchiveBytes = 5 * 1024 * 1024;
const maximumUnpackedBytes = 20 * 1024 * 1024;
const versionPattern = /^(?:0|[1-9]\d{0,4})(?:\.(?:0|[1-9]\d{0,4})){2,3}$/;
export function validVersion(version) {
  return typeof version === 'string' && versionPattern.test(version) && version.split('.').every(part => Number(part) <= 65535);
}
export function downloadFilename(version) {
  if (!validVersion(version)) throw new Error('Invalid extension version.');
  return 'bwatch-monitor-extension-' + version + '.zip';
}
export function siteContract() {
  const source = fs.readFileSync(path.join(projectRoot, 'shared/site.ts'), 'utf8');
  const literal = name => {
    const value = new RegExp('export const ' + name + " = '([^']+)';").exec(source)?.[1];
    if (!value) throw new Error('Missing static site contract: ' + name);
    return value;
  };
  return { origin: literal('SITE_ORIGIN'), base: literal('SITE_BASE_PATH'), version: literal('PROJECT_VERSION') };
}
function sameStrings(actual, expected) {
  return Array.isArray(actual) && actual.every(value => typeof value === 'string') &&
    isDeepStrictEqual([...actual].sort(), [...expected].sort());
}
export function validateArchive(archive, version, builtManifest) {
  if (!Buffer.isBuffer(archive) || archive.length === 0 || archive.length > maximumArchiveBytes) throw new Error('Invalid archive size.');
  const entries = new AdmZip(archive).getEntries();
  if (!entries.length || entries.length > 512) throw new Error('Invalid archive entries.');
  const files = new Map(), names = new Set();
  let unpacked = 0;
  for (const entry of entries) {
    const name = entry.entryName, segments = (entry.isDirectory ? name.slice(0, -1) : name).split('/');
    if (!name || name.includes('\\') || name.startsWith('/') || segments.some(segment => !segment || segment === '.' || segment === '..' || segment.includes(':')) || names.has(name))
      throw new Error('Unsafe or duplicate archive entry.');
    names.add(name); unpacked += entry.header.size;
    if (!Number.isSafeInteger(unpacked) || unpacked > maximumUnpackedBytes) throw new Error('Oversized unpacked archive.');
    if (!entry.isDirectory) {
      const content = entry.getData(); // CRC validation is performed for every file.
      if (content.length !== entry.header.size) throw new Error('Truncated archive entry.');
      files.set(name, content);
    }
  }
  const rawManifest = files.get('manifest.json');
  if (!rawManifest || rawManifest.length > 32 * 1024) throw new Error('Missing archive manifest.');
  const manifest = JSON.parse(rawManifest.toString('utf8')), site = siteContract();
  if (manifest.manifest_version !== 3 || manifest.version !== version || manifest.version_name !== undefined && manifest.version_name !== version ||
    typeof manifest.background?.service_worker !== 'string' || manifest.background.scripts || manifest.browser_specific_settings ||
    manifest.incognito !== 'not_allowed' || manifest.minimum_chrome_version !== '120') throw new Error('Unexpected Chromium MV3 manifest.');
  const hosts = ['https://*.bilibili.com/*', site.origin + '/*', 'https://*.bilivideo.com/*', 'https://*.bilivideo.cn/*'];
  if (!sameStrings(manifest.host_permissions, hosts) || !sameStrings(manifest.permissions, ['storage', 'cookies', 'declarativeNetRequestWithHostAccess', 'scripting']) ||
    manifest.optional_host_permissions?.length || manifest.externally_connectable?.matches?.length ||
    !Array.isArray(manifest.content_scripts) || !sameStrings(manifest.content_scripts.flatMap(script => script.matches ?? []), [site.origin + site.base + '*']) ||
    manifest.content_scripts.some(script => script.all_frames === true)) throw new Error('Unexpected extension permissions or page allowlist.');
  if (builtManifest && !isDeepStrictEqual(manifest, builtManifest)) throw new Error('ZIP and build manifests differ.');
  const references = [manifest.background.service_worker, manifest.action?.default_popup,
    ...manifest.content_scripts.flatMap(script => [...(script.js ?? []), ...(script.css ?? [])])].filter(Boolean);
  if (references.some(name => !files.has(name))) throw new Error('Missing extension entrypoint.');
  return manifest;
}
export function descriptor(archive, version) {
  return { browser: 'chrome', variant: 'production', version, url: 'downloads/' + downloadFilename(version), bytes: archive.length,
    sha256: createHash('sha256').update(archive).digest('hex') };
}
export function validateDescriptor(item, version) {
  if (!item || item.browser !== 'chrome' || item.variant !== 'production' || item.version !== version ||
    item.url !== 'downloads/' + downloadFilename(version) || !Number.isSafeInteger(item.bytes) || item.bytes <= 0 ||
    item.bytes > maximumArchiveBytes || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256))
    throw new Error('Invalid static extension descriptor.');
}
export function verifyDownloads(directory, version) {
  const raw = fs.readFileSync(path.join(directory, metadataName));
  if (raw.length > 4096) throw new Error('Oversized static download manifest.');
  const metadata = JSON.parse(raw.toString('utf8'));
  if (metadata.schemaVersion !== 1 || !Array.isArray(metadata.packages) || metadata.packages.length !== 1) throw new Error('Expected one Chromium download.');
  const item = metadata.packages[0]; validateDescriptor(item, version);
  const archive = fs.readFileSync(path.join(directory, downloadFilename(version)));
  if (archive.length !== item.bytes || createHash('sha256').update(archive).digest('hex') !== item.sha256) throw new Error('Extension integrity mismatch.');
  validateArchive(archive, version);
  return item;
}
function atomicWrite(filename, content) {
  const temporary = filename + '.' + randomUUID() + '.tmp';
  try { fs.writeFileSync(temporary, content, { flag: 'wx' }); fs.renameSync(temporary, filename); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
export function prepareDownloads() {
  const extensionRoot = path.join(projectRoot, 'extension');
  const pkg = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf8')), site = siteContract();
  if (pkg.name !== 'bwatch-monitor-extension' || pkg.version !== site.version) throw new Error('Project and extension release versions must match.');
  const archive = fs.readFileSync(path.join(extensionRoot, '.output', pkg.name + '-' + pkg.version + '-chrome.zip'));
  const builtManifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, '.output/chrome-mv3/manifest.json'), 'utf8'));
  validateArchive(archive, pkg.version, builtManifest);
  const directory = path.join(projectRoot, 'public/downloads');
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, downloadFilename(pkg.version));
  let published = archive;
  if (fs.existsSync(target)) {
    const existing = fs.readFileSync(target);
    validateArchive(existing, pkg.version);
    const contents = bytes => new AdmZip(bytes).getEntries().filter(entry => !entry.isDirectory)
      .map(entry => [entry.entryName, entry.getData()]).sort(([left], [right]) => left.localeCompare(right));
    if (!isDeepStrictEqual(contents(existing), contents(archive))) throw new Error('Refusing to replace different contents at an existing release URL. Increment the release version.');
    published = existing;
  } else atomicWrite(target, archive);
  const item = descriptor(published, pkg.version);
  atomicWrite(path.join(directory, metadataName), JSON.stringify({ schemaVersion: 1, packages: [item] }, null, 2) + '\n');
  verifyDownloads(directory, pkg.version);
  return item;
}
