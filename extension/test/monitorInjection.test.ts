import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMonitorInjector, monitorContentFiles } from '../lib/monitorInjection';

test('manifest selects the bundled monitor content script and rejects unsafe file paths', () => {
  assert.deepEqual(monitorContentFiles({ content_scripts: [
    { matches: ['https://other.example/*'], js: ['other.js'] },
    { matches: ['https://dumpling233.github.io/bwatch-monitor/*'], js: ['content-scripts/content.js', '../bad.js', '/bad.js', 'https://bad.test/a.js'] },
    { matches: ['https://dumpling233.github.io/bwatch-monitor/*'], js: ['content-scripts/content.js'] }
  ] }), ['/content-scripts/content.js']);
  assert.deepEqual(monitorContentFiles({ content_scripts: [{ matches: ['https://dumpling233.github.io/bwatch-monitor/*'], js: ['other.js'] }] }), []);
});

test('existing documents are injected only for exact allowed ordinary monitor tabs with host grants', async () => {
  const injected: number[] = [], checked: string[][] = [];
  const run = createMonitorInjector({ firefox: true, local: false,
    version: '0.1.2', ping: async () => undefined,
    tabs: async () => [
      { id: 1, url: 'https://dumpling233.github.io/bwatch-monitor', cookieStoreId: 'firefox-default' },
      { id: 2, url: 'https://dumpling233.github.io/bwatch-monitor/?x=1', cookieStoreId: 'firefox-default' },
      { id: 3, url: 'https://dumpling233.github.io/bwatch-monitor-extra', cookieStoreId: 'firefox-default' },
      { id: 4, url: 'http://127.0.0.1:5173/', cookieStoreId: 'firefox-default' },
      { id: 5, url: 'https://dumpling233.github.io/bwatch-monitor', cookieStoreId: 'firefox-container-1' },
      { id: 6, url: 'https://dumpling233.github.io/bwatch-monitor', cookieStoreId: 'firefox-default', incognito: true },
      { id: 7, url: 'https://evil.test/monitor', cookieStoreId: 'firefox-default' },
      { id: 8, cookieStoreId: 'firefox-default' }
    ],
    permitted: async origins => { checked.push(origins); return true; },
    files: () => ['content-scripts/content.js'],
    inject: async (id, files) => { injected.push(id); assert.deepEqual(files, ['content-scripts/content.js']); }
  });
  await run();
  assert.deepEqual(injected, [1, 2]);
  assert.deepEqual(checked, [['https://dumpling233.github.io/*'], ['https://dumpling233.github.io/*']]);
});

test('ungranted host access never prompts or injects and a later permission event can retry', async () => {
  let allowed = false, calls = 0;
  const run = createMonitorInjector({ firefox: false, local: true,
    version: '0.1.2', ping: async () => undefined,
    tabs: async () => [{ id: 1, url: 'http://127.0.0.1:5173/' }, { id: 2, url: 'http://localhost:9999/monitor' }],
    permitted: async () => allowed, files: () => ['content-scripts/content.js'], inject: async () => { calls++; }
  });
  await run(); assert.equal(calls, 0);
  allowed = true; await run(); assert.equal(calls, 1);
});

test('concurrent install and permission events share one finite injection pass; a closed tab does not block others', async () => {
  let release!: () => void, scans = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const injected: number[] = [];
  const run = createMonitorInjector({ firefox: false, local: false,
    version: '0.1.2', ping: async () => undefined,
    tabs: async () => { scans++; await gate; return [{ id: 1, url: 'https://dumpling233.github.io/bwatch-monitor' }, { id: 2, url: 'https://dumpling233.github.io/bwatch-monitor' }]; },
    permitted: async () => true, files: () => ['content-scripts/content.js'],
    inject: async id => { injected.push(id); if (id === 1) throw new Error('closed'); }
  });
  const first = run(), second = run();
  assert.equal(first, second); release(); await first;
  assert.equal(scans, 1); assert.deepEqual(injected, [1, 2]);
  await run(); assert.equal(scans, 2);
});

test('same-version live bridge is announced through ping without executing WXT or replacing media ownership', async () => {
  const injected: number[] = [], pinged: number[] = [];
  const run = createMonitorInjector({ firefox: false, local: false, version: '0.1.2',
    tabs: async () => [1, 2, 3].map(id => ({ id, url: 'https://dumpling233.github.io/bwatch-monitor' })),
    permitted: async () => true, files: () => ['content-scripts/content.js'],
    ping: async id => { pinged.push(id); if (id === 1) return { extensionVersion: '0.1.2', bridgeId: 'existing-document' };
      if (id === 2) return { extensionVersion: '0.1.1', bridgeId: 'old-document' }; throw new Error('no content script'); },
    inject: async id => { injected.push(id); }
  });
  await run();
  assert.deepEqual(pinged, [1, 2, 3]); assert.deepEqual(injected, [2, 3]);
});

test('a permission grant during an install scan schedules a fresh scan without overlapping injection passes', async () => {
  let release!: () => void, scans = 0, allowed = false;
  const gate = new Promise<void>(resolve => { release = resolve; }), injected: number[] = [];
  const run = createMonitorInjector({ firefox: false, local: false, version: '0.1.2',
    tabs: async () => { scans++; if (scans === 1) { await gate; return []; } return [{ id: 1, url: 'https://dumpling233.github.io/bwatch-monitor' }]; },
    permitted: async () => allowed, files: () => ['content-scripts/content.js'], ping: async () => undefined,
    inject: async id => { injected.push(id); }
  });
  const initial = run(); allowed = true;
  assert.equal(run(true), initial); release(); await initial;
  assert.equal(scans, 2); assert.deepEqual(injected, [1]);
});
