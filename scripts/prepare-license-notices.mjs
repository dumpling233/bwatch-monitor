import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionRoot = path.join(projectRoot, 'extension');
const separator = '='.repeat(78);
const maximumLicenseBytes = 512 * 1024;
const maximumCollectionBytes = 5 * 1024 * 1024;
// These are the only external runtime imports used by this extension and WXT's
// generated content-script wrapper. Include the legacy polyfill if installed.
const extensionRuntimePackages = ['wxt', '@wxt-dev/browser', 'webextension-polyfill'];
// The WXT npm packages omit their monorepo license. Keep an offline, unmodified
// copy of the official upstream text instead of making builds fetch the network.
const wxtLicenseSource = 'https://raw.githubusercontent.com/wxt-dev/wxt/main/LICENSE';
const offlineLicenses = {
  wxt: { file: 'wxt-MIT.txt', license: 'MIT', source: wxtLicenseSource },
  '@wxt-dev/browser': { file: 'wxt-MIT.txt', license: 'MIT', source: wxtLicenseSource },
  'react-remove-scroll-bar': {
    file: 'react-remove-scroll-bar-MIT.txt', license: 'MIT',
    source: 'https://raw.githubusercontent.com/theKashey/react-remove-scroll-bar/master/LICENSE'
  }
};
const licenseFilename = /^(?:licen[cs]e|copying|notice|copyright)(?:[._-].*)?$|\.licen[cs]e(?:\.[a-z]+)?$/i;
const legalDirectories = /^(?:dist|licenses?|legal|third[-_]party)$/i;

async function jsonFile(filename) {
  return JSON.parse(await readFile(filename, 'utf8'));
}

function packageDirectory(root, location) {
  if (!location.startsWith('node_modules/') || location.includes('\\') ||
      location.split('/').some(part => !part || part === '.' || part === '..' || part.includes(':'))) {
    throw new Error('Invalid installed package location in lockfile: ' + location);
  }
  return path.join(root, ...location.split('/'));
}

async function legalFiles(directory, prefix = '', depth = 0) {
  const found = [];
  const entries = (await readdir(path.join(directory, prefix), { withFileTypes: true }))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const entry of entries) {
    const relative = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isFile() && licenseFilename.test(entry.name)) {
      const content = await readFile(path.join(directory, relative));
      if (content.length > maximumLicenseBytes) throw new Error('Unexpectedly large legal file: ' + relative);
      if (content.includes(0)) throw new Error('Non-text legal file: ' + relative);
      found.push({ filename: relative, text: content.toString('utf8').trimEnd() });
    } else if (entry.isDirectory() && depth < 2 && legalDirectories.test(entry.name)) {
      found.push(...await legalFiles(directory, relative, depth + 1));
    }
  }
  return found;
}

function repository(metadata) {
  const value = typeof metadata.repository === 'string' ? metadata.repository : metadata.repository?.url;
  return typeof value === 'string' ? value : typeof metadata.homepage === 'string' ? metadata.homepage : '';
}

function declaredLicense(metadata) {
  if (typeof metadata.license === 'string') return metadata.license;
  if (typeof metadata.license?.type === 'string') return metadata.license.type;
  if (Array.isArray(metadata.licenses)) return metadata.licenses.map(item => item.type ?? item).join(' OR ');
  throw new Error('Missing package license metadata: ' + metadata.name);
}

async function packageNotice(root, location, locked, scope) {
  const directory = packageDirectory(root, location);
  let metadata;
  try { metadata = await jsonFile(path.join(directory, 'package.json')); }
  catch (error) {
    // npm omits optional packages for other operating systems/architectures.
    // They are not distributed in this build and have no installed text to copy.
    if (error.code === 'ENOENT' && locked.optional) return null;
    throw error;
  }
  if (typeof metadata.name !== 'string' || typeof metadata.version !== 'string' || metadata.version !== locked.version) {
    throw new Error('Installed package differs from lockfile; run npm ci: ' + scope + '/' + location);
  }
  const license = declaredLicense(metadata);
  const files = await legalFiles(directory);
  let fallbackSource = '';
  const fallback = offlineLicenses[metadata.name];
  if (!files.length && fallback && license === fallback.license) {
    files.push({ filename: 'upstream LICENSE (offline copy)', text: (await readFile(path.join(projectRoot, 'licenses', fallback.file), 'utf8')).trimEnd() });
    fallbackSource = fallback.source;
  }
  if (!files.length) throw new Error('No license text found in installed package: ' + metadata.name + '@' + metadata.version);
  const source = repository(metadata);
  return [
    separator,
    metadata.name + '@' + metadata.version,
    'Declared license: ' + license,
    'Included from: ' + scope + '/' + location,
    ...(source ? ['Upstream: ' + source] : []),
    ...(fallbackSource ? ['License text source: ' + fallbackSource] : []),
    '',
    ...files.flatMap(file => ['--- ' + file.filename + ' ---', file.text, ''])
  ].join('\n');
}

async function thirdPartyLicenses() {
  const websiteLock = await jsonFile(path.join(projectRoot, 'package-lock.json'));
  const extensionLock = await jsonFile(path.join(extensionRoot, 'package-lock.json'));
  if (!websiteLock.packages || !extensionLock.packages) throw new Error('Expected npm lockfiles with package records.');
  const selected = Object.entries(websiteLock.packages)
    .filter(([location, entry]) => location.startsWith('node_modules/') && !entry.dev && !entry.link)
    .map(([location, entry]) => ({ root: projectRoot, location, entry, scope: 'website' }));
  for (const name of extensionRuntimePackages) {
    const matches = Object.entries(extensionLock.packages).filter(([location]) =>
      location === 'node_modules/' + name || location.endsWith('/node_modules/' + name));
    if (!matches.length && name !== 'webextension-polyfill') throw new Error('Missing extension runtime dependency: ' + name);
    selected.push(...matches.map(([location, entry]) => ({ root: extensionRoot, location, entry, scope: 'extension' })));
  }
  selected.sort((left, right) => {
    const a = left.scope + '/' + left.location, b = right.scope + '/' + right.location;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const sections = [], errors = [];
  for (const item of selected) {
    try {
      const section = await packageNotice(item.root, item.location, item.entry, item.scope);
      if (section) sections.push(section);
    } catch (error) { errors.push(error.message); }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  const output = [
    'BWatch Monitor third-party license notices',
    '',
    'Generated from installed npm packages and the committed lockfiles.',
    'Includes website production dependencies and extension runtime dependencies.',
    'Each dependency retains its own license; the project AGPL does not replace it.',
    'Additional upstream notices may be included conservatively.',
    'See third-party-danmaku.txt for the version-locked protocol patch notice.',
    '',
    ...sections
  ].join('\n') + '\n';
  if (Buffer.byteLength(output) > maximumCollectionBytes) throw new Error('Unexpectedly large third-party license collection.');
  return { output, count: sections.length };
}

// Read and validate everything before creating any generated assets.
const license = await readFile(path.join(projectRoot, 'LICENSE'));
const notice = await readFile(path.join(projectRoot, 'NOTICE'));
const danmakuNotice = await readFile(path.join(projectRoot, 'public/third-party-danmaku.txt'));
const { output, count } = await thirdPartyLicenses();
for (const directory of [path.join(projectRoot, 'public'), path.join(extensionRoot, 'public')]) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'LICENSE'), license);
  await writeFile(path.join(directory, 'NOTICE'), notice);
  await writeFile(path.join(directory, 'THIRD_PARTY_LICENSES.txt'), output);
  if (directory === path.join(extensionRoot, 'public')) {
    await writeFile(path.join(directory, 'third-party-danmaku.txt'), danmakuNotice);
  }
}
console.log('Prepared project and third-party notices for website and extension (' + count + ' packages, ' + Buffer.byteLength(output) + ' bytes).');
