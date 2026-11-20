import { test, expect, type Page } from '@playwright/test';
import { LOCAL_LOGIN_CHANNEL } from '../shared/localLogin';
import { MONITOR_URL, PROJECT_VERSION } from '../shared/site';

test.beforeEach(async ({ page }) => {
  // Keep the real origin/path contract while serving the production build locally.
  await page.route(`${MONITOR_URL}**`, async route => {
    const url = new URL(route.request().url());
    url.protocol = 'http:'; url.host = '127.0.0.1:4173';
    await route.fulfill({ response: await route.fetch({ url: url.href }) });
  });
});

async function forbidBackend(page: Page) {
  const requests: string[] = [];
  const isBackend = (url: URL) => url.hostname === 'bwatch.icu'
    || (url.origin === new URL(MONITOR_URL).origin && /(?:^|\/)api(?:\/|$)/.test(url.pathname));
  page.on('request', request => {
    const url = new URL(request.url());
    if (isBackend(url)) requests.push(request.url());
  });
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    return isBackend(url) ? route.abort() : route.fallback();
  });
  return requests;
}

async function anonymousCompanion(page: Page) {
  await page.addInitScript(({ channel, version }) => {
    const calls: string[] = [];
    Object.assign(window, { companionCalls: calls });
    window.addEventListener('message', event => {
      const request = event.data;
      if (event.source !== window || request?.channel !== channel || request.direction !== 'request') return;
      calls.push(request.action);
      let result: unknown;
      if (request.action === 'HELLO') result = {
        version: 1, extensionVersion: version, runtimeEpoch: 'standalone-test-runtime', installationType: 'development',
        capabilities: ['account', 'playback', 'session', 'danmaku', 'chat', 'profile', 'unified-authorization', 'audio-playback',
          'following', 'following-status', 'following-room-info', 'medals', 'medal-room-context', 'public-room', 'public-playback', 'anonymous-danmaku']
      };
      else if (request.action === 'GET_SESSION' || request.action === 'DISCONNECT') result = {
        preferences: { schemaVersion: 1, revision: 0, granted: false, connectionWanted: false, playbackWanted: false, chatWanted: false },
        playbackAllowed: false, chatAllowed: false, danmakuAllowed: false, reason: 'not-connected'
      };
      else if (request.action === 'RESOLVE_PUBLIC_ROOM') result = {
        source: 'custom', roomId: '12345', input: '12345', uid: 67890,
        anchorName: '离线测试主播', title: '客户端房间', status: 'offline', online: null, onlineStale: false,
        fansCount: null, fansStale: false, guardCount: null, guardStale: false,
        liveStartTime: null, lastUpdatedAt: Date.now(), metadataFetchedAt: Date.now(), metadataStale: false
      };
      else if (request.action === 'RESOLVE_PUBLIC_PLAYBACK') result = {
        roomId: request.payload.roomId, requestedQuality: request.payload.qn,
        resolvedAt: Date.now(), status: 'offline', sources: [], qualities: []
      };
      else if (request.action === 'CANCEL' || request.action === 'RELEASE_AUDIO_PLAYBACK') result = { released: true };
      const response = result === undefined
        ? { ok: false, error: { code: 'UNAUTHORIZED', message: '个人功能需要账号授权' } }
        : { ok: true, result };
      window.postMessage({ channel, direction: 'response', requestId: request.requestId, ...response }, window.location.origin);
    });
  }, { channel: LOCAL_LOGIN_CHANNEL, version: PROJECT_VERSION });
}

test('static entry works with no companion and no application backend', async ({ page }) => {
  const backend = await forbidBackend(page);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('./');
  await expect(page.getByRole('button', { name: '添加自定义直播间', exact: true }).first()).toBeVisible();
  await expect(page.getByText('主站房间', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '返回主站' })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('desktop.png'), fullPage: true });
  await page.getByRole('button', { name: '打开设置', exact: true }).click();
  await expect(page.getByText(/浏览器扩展/).first()).toBeVisible();
  expect(backend).toEqual([]);
  expect(errors).toEqual([]);
});

test('anonymous extension resolves and saves a room without account authorization', async ({ page }) => {
  const backend = await forbidBackend(page);
  await anonymousCompanion(page);
  await page.goto('./');
  await page.getByRole('button', { name: '添加自定义直播间', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'B站房间号或链接' }).fill('12345');
  await dialog.getByRole('button', { name: '获取房间信息' }).click();
  await expect(dialog.getByText('离线测试主播', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: /保存到我的房间|保存房间|收藏房间/ }).click();
  await expect(page.locator('.mv-candidate').filter({ hasText: '离线测试主播' }).first()).toBeVisible();
  await page.reload();
  await expect(page.getByText('离线测试主播', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: '加入离线测试主播', exact: true }).click();
  const tile = page.locator('article.mv-tile[data-room-id="12345"]');
  await expect(tile).toBeVisible();
  const originalTile = await tile.elementHandle();
  const playbackCalls = () => page.evaluate(() => (window as unknown as { companionCalls: string[] }).companionCalls
    .filter(action => action === 'RESOLVE_PUBLIC_PLAYBACK').length);
  const beforeSwitch = await playbackCalls();
  await page.locator('.mv-library-tabs button').filter({ hasText: 'B站关注' }).click();
  await expect(page.getByRole('button', { name: '从我的房间移除离线测试主播', exact: true })).toHaveCount(0);
  await page.locator('.mv-library-tabs button').filter({ hasText: '我的房间' }).click();
  await page.getByRole('button', { name: '从我的房间移除离线测试主播', exact: true }).click();
  await expect(page.getByText('已从我的房间移除，当前播放继续', { exact: true })).toBeVisible();
  await expect(tile).toBeVisible();
  expect(await originalTile!.evaluate(node => node === document.querySelector('article.mv-tile[data-room-id="12345"]'))).toBe(true);
  expect(await playbackCalls()).toBe(beforeSwitch);
  const calls = await page.evaluate(() => (window as unknown as { companionCalls: string[] }).companionCalls);
  expect(calls).not.toContain('REQUEST_AUTHORIZATION');
  expect(backend).toEqual([]);
});

test('narrow layout preserves controls without horizontal page overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await forbidBackend(page);
  await page.goto('./');
  await expect(page.getByRole('button', { name: '添加自定义直播间', exact: true }).first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('narrow.png'), fullPage: true });
});

test('file installation downloads the verified Chromium ZIP on the Pages path', async ({ page }) => {
  const backend = await forbidBackend(page);
  await page.goto('./');
  await page.getByRole('button', { name: '打开设置', exact: true }).click();
  await page.getByRole('button', { name: '安装浏览器扩展', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '安装扩展与连接 B站账号' });
  await expect(dialog.getByRole('textbox', { name: 'Chrome 扩展管理页地址' })).toHaveValue('chrome://extensions');
  const link = dialog.getByRole('link', { name: new RegExp('^下载 .*v' + PROJECT_VERSION.replaceAll('.', '\\.') + '$') });
  await expect(link).toBeVisible();
  const filename = `bwatch-monitor-extension-${PROJECT_VERSION}.zip`;
  await expect(link).toHaveAttribute('href', new URL(MONITOR_URL).pathname + 'downloads/' + filename);
  const downloadPromise = page.waitForEvent('download');
  await link.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(filename);
  expect(await download.failure()).toBeNull();
  await expect(dialog.getByText('安装包已校验。如果浏览器未开始保存，请点击“再次保存”。')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('installation.png'), fullPage: true });
  expect(backend).toEqual([]);
});

test('room balance stays independent of volume, survives reload and fits the narrow shortcut popup', async ({ page }) => {
  const backend = await forbidBackend(page);
  await anonymousCompanion(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('./');
  await page.getByRole('button', { name: '添加自定义直播间', exact: true }).first().click();
  const add = page.getByRole('dialog');
  await add.getByRole('textbox', { name: 'B站房间号或链接' }).fill('12345');
  await add.getByRole('button', { name: '获取房间信息' }).click();
  await add.getByRole('button', { name: '保存并观看', exact: true }).click();
  const tile = page.locator('article.mv-tile[data-room-id="12345"]');
  await expect(tile).toBeVisible();
  const tileNode = await tile.elementHandle();
  await page.getByRole('button', { name: '打开混音器', exact: true }).click();
  const mixer = page.locator('.mv-mixer-room');
  const balance = mixer.getByRole('slider', { name: '离线测试主播 声道平衡', exact: true });
  const volume = mixer.getByRole('slider', { name: '离线测试主播混音音量', exact: true });
  await expect(balance).toHaveValue('0');
  await balance.fill('-65');
  await volume.fill('0.5');
  await expect(balance).toHaveValue('-65');
  await expect(volume).toHaveValue('0.5');
  expect(await tileNode!.evaluate(node => node === document.querySelector('article.mv-tile[data-room-id="12345"]'))).toBe(true);
  await page.getByRole('button', { name: '收起控制栏', exact: true }).click();
  await page.setViewportSize({ width: 320, height: 720 });
  const shortcut = page.getByRole('group', { name: '快捷控制栏', exact: true })
    .getByRole('button', { name: /^离线测试主播(?:打开|关闭)声音$/ });
  await shortcut.focus();
  await shortcut.press('ArrowRight');
  const popup = page.getByRole('dialog', { name: '离线测试主播快捷音量调节', exact: true });
  const quickBalance = popup.getByRole('slider', { name: '离线测试主播 声道平衡', exact: true });
  await expect(quickBalance).toHaveValue('-65');
  await expect(popup.locator('input[type="range"]')).toHaveCount(2);
  await quickBalance.press('Home');
  await expect(quickBalance).toHaveValue('-100');
  await quickBalance.press('End');
  await expect(quickBalance).toHaveValue('100');
  await quickBalance.press('ArrowLeft');
  await expect(quickBalance).toHaveValue('99');
  await popup.getByRole('button', { name: '离线测试主播 声道平衡回中', exact: true }).click();
  await expect(quickBalance).toHaveValue('0');
  await quickBalance.fill('70');
  const bounds = await popup.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(720);
  await page.screenshot({ path: test.info().outputPath('balance-narrow.png'), animations: 'disabled' });
  await quickBalance.press('Escape');
  await expect(shortcut).toBeFocused();
  await page.reload();
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole('button', { name: '打开混音器', exact: true }).click();
  await expect(balance).toHaveValue('70');
  await expect(volume).toHaveValue('0.5');
  expect(backend).toEqual([]);
});
