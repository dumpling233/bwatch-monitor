import { defineConfig } from 'wxt';
import { SITE_ORIGIN, MONITOR_MATCH_PATTERN } from '../shared/site';

const localBuild = /(?:^|:)local$/.test(process.env.npm_lifecycle_event ?? '') || process.env.npm_lifecycle_event === 'dev';
export default defineConfig({
  manifestVersion: 3,
  manifest: {
    default_locale: 'zh_CN', name: '__MSG_extensionName__', description: '__MSG_extensionDescription__',
    minimum_chrome_version: '120',
    permissions: ['storage', 'cookies', 'declarativeNetRequestWithHostAccess', 'scripting'],
    host_permissions: ['https://*.bilibili.com/*', `${SITE_ORIGIN}/*`, 'https://*.bilivideo.com/*', 'https://*.bilivideo.cn/*',
      ...(localBuild ? ['http://127.0.0.1/*', 'http://localhost/*'] : [])],
    incognito: 'not_allowed'
  },
  vite: () => ({ define: { __BWATCH_LOCAL__: JSON.stringify(localBuild) } }),
  hooks: {
    'build:manifestGenerated': (_wxt, manifest) => {
      if (!localBuild) for (const script of manifest.content_scripts ?? []) script.matches = [MONITOR_MATCH_PATTERN];
    }
  }
});
