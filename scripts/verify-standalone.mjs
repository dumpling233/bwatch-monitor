import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.filter(entry => !['node_modules', '.wxt', '.output'].includes(entry.name))
    .map(entry => entry.isDirectory() ? walk(path.join(directory, entry.name)) : [path.join(directory, entry.name)]));
  return files.flat();
}
for (const area of ['client', 'shared', 'extension/entrypoints', 'extension/lib', 'dist']) {
  for (const file of await walk(path.join(root, area))) {
    if (!/\.(?:[cm]?js|tsx?|html|json|css)$/.test(file)) continue;
    const body = await readFile(file, 'utf8');
    const relative = path.relative(root, file);
    if (/bwatch\.icu|bwatch-web[\\/]|bwatch-browser-extension[\\/]/.test(body)) errors.push(`${relative}: old project runtime reference`);
    if (/(?:["'`])\/api\//.test(body)) errors.push(`${relative}: application backend route`);
    if (/https:\/\/(?:chromewebstore\.google\.com|microsoftedge\.microsoft\.com\/addons|addons\.mozilla\.org)/.test(body)) errors.push(`${relative}: extension store distribution`);
  }
}
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
for (const dependency of ['fastify', 'pg', 'undici', '@node-rs/argon2']) {
  if (manifest.dependencies?.[dependency]) errors.push(`Unexpected server dependency: ${dependency}`);
}
const index = await readFile(path.join(root, 'dist/index.html'), 'utf8');
if (!index.includes('/bwatch-monitor/assets/')) errors.push('Pages base path was not applied to built assets');
if (errors.length) throw new Error(errors.join('\n'));
console.log('Standalone verification passed: no old application backend or store dependency; Pages assets use the project base path.');
