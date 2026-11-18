import { prepareDownloads } from './extension-downloads.mjs';
const item = prepareDownloads();
console.log('Prepared verified Chrome/Edge download: ' + item.url + ' (' + item.bytes + ' bytes, SHA-256 ' + item.sha256 + ')');
