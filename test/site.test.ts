import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedMonitorPage, MONITOR_URL, siteAssetUrl } from '../shared/site.ts';

test('production bridge accepts only the deployed page on the shared Pages origin', () => {
  assert.equal(isAllowedMonitorPage(MONITOR_URL), true);
  assert.equal(isAllowedMonitorPage(`${MONITOR_URL}?room=1#settings`), true);
  assert.equal(isAllowedMonitorPage(MONITOR_URL.slice(0, -1)), true);
  assert.equal(isAllowedMonitorPage(`${MONITOR_URL}untrusted/`), false);
  assert.equal(isAllowedMonitorPage('https://dumpling233.github.io/other/'), false);
  assert.equal(isAllowedMonitorPage('https://dumpling233.github.io.evil.test/bwatch-monitor/'), false);
  assert.equal(isAllowedMonitorPage('https://user:password@dumpling233.github.io/bwatch-monitor/'), false);
  assert.equal(isAllowedMonitorPage('https://bwatch.icu/monitor'), false);
});
test('development origin is explicitly opted in and retains path confinement', () => {
  assert.equal(isAllowedMonitorPage('http://127.0.0.1:5173/'), false);
  assert.equal(isAllowedMonitorPage('http://127.0.0.1:5173/', true), true);
  assert.equal(isAllowedMonitorPage('http://localhost:5173/', true), true);
  assert.equal(isAllowedMonitorPage('http://localhost:5173/other/', true), false);
  assert.equal(isAllowedMonitorPage('http://127.0.0.1:8080/', true), false);
});
test('download assets are addressed below the Pages project path', () => {
  assert.equal(siteAssetUrl('downloads/extension.zip'), `${MONITOR_URL}downloads/extension.zip`);
});
