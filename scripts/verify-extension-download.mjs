import * as fs from 'node:fs';
import path from 'node:path';
import { projectRoot, siteContract, verifyDownloads } from './extension-downloads.mjs';
const version = siteContract().version;
const directories = ['public/downloads', 'dist/downloads'];
for (const directory of directories) {
  const absolute = path.join(projectRoot, directory);
  if (directory.startsWith('dist/') && !fs.existsSync(absolute)) continue;
  const item = verifyDownloads(absolute, version);
  console.log('Verified ' + directory + ': ' + item.version + ', ' + item.bytes + ' bytes, SHA-256 ' + item.sha256);
}
