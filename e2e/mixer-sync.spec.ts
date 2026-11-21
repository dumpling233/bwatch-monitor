import { test, expect, type Page } from '@playwright/test';

test.use({ baseURL: 'http://127.0.0.1:5173/' });

async function fixture(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/__mixer_sync', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `
    <!doctype html><html><head><meta charset="UTF-8"></head><body style="margin:0">
    <div id="root" class="mv-shell" style="width:100vw;height:100dvh;display:block;border:0;border-radius:0"></div>
    <script type="module">
      import React from '/node_modules/.vite/deps/react.js';
      import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
      import { MixerRoomAudio } from '/client/multiview/RoomAudioBalance.tsx';
      import { ShortcutRoomRail } from '/client/multiview/ShortcutRoomRail.tsx';
      import { ShortcutAudioControl } from '/client/multiview/ShortcutAudioControl.tsx';
      import '/client/style.css';
      import '/client/modern.css';
      import '/client/ui-scroll.css';
      import '/client/multiview/multiview.css';
      const root = ReactDOM.createRoot(document.getElementById('root'));
      const state = { active:false, count:12, scope:'first', hidden:false };
      const calls = { profile:[], toggle:[] };
      const profile = async uid => { calls.profile.push(uid); return { uid, face:undefined }; };
      const room = uid => React.createElement(MixerRoomAudio, { key:uid, name:'主播'+uid, uid,
        avatarScope:uid+':'+state.scope, active:state.active, resolveProfile:profile,
        volume:.7, muted:true, balance:0, onSelect:()=>{}, onToggle:()=>{}, onVolumeChange:()=>{}, onBalanceChange:()=>{} });
      window.__mixerSync = { calls, update:patch=>{Object.assign(state,patch);render();} };
      function render() {
        root.render(React.createElement(React.Fragment, null,
          React.createElement('div', { className:'mixer-fixture ui-scrollbar', style:{width:'min(360px,100vw)',height:100,overflowY:'auto'} },
            room('42'), React.createElement('div',{style:{height:400}}), room('43')),
          React.createElement('div', { className:'mv-switchbar',style:{position:'absolute',bottom:0,left:0,right:0,height:40,padding:4} },
            React.createElement(ShortcutRoomRail, {hidden:state.hidden}, Array.from({length:state.count},(_,i)=>
              React.createElement(ShortcutAudioControl,{key:i,name:'主播'+(i+1),volume:.7,muted:true,
                onToggle:()=>calls.toggle.push(i),onChange:()=>{}}))))));
      }
      render();
    </script></body></html>` }));
  await page.goto('/__mixer_sync');
  await expect(page.locator('.mv-shortcut-room-rail'), errors.join('\n')).toBeVisible();
  return errors;
}

const update = (page: Page, patch: Record<string, unknown>) => page.evaluate(patch =>
  (window as unknown as { __mixerSync: { update: (value: Record<string, unknown>) => void } }).__mixerSync.update(patch), patch);

async function hoverEdge(page: Page, side: 'left' | 'right', inset = 32) {
  const rail = page.locator('.mv-shortcut-room-rail');
  const bounds = (await rail.boundingBox())!;
  await page.mouse.move(side === 'left' ? bounds.x + inset : bounds.x + bounds.width - inset, bounds.y + bounds.height / 2);
}

test('overflow rail scrolls while hovering the edge and stops immediately on leaving', async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 600 });
  const errors = await fixture(page);
  const viewport = page.locator('.mv-shortcut-rooms');
  const position = () => viewport.evaluate(element => element.scrollLeft);
  const remaining = () => viewport.evaluate(element => element.scrollWidth - element.clientWidth - element.scrollLeft);
  const right = page.getByRole('button', { name: '向右滚动房间音量列表', exact: true });
  await expect.poll(remaining).toBeGreaterThan(100);
  await hoverEdge(page, 'left');
  await expect(page.getByRole('button', { name: /向[左右]滚动房间音量列表/ })).toHaveCount(0);
  await hoverEdge(page, 'right');
  await expect(right).toBeVisible();
  await hoverEdge(page, 'right', 10);
  await expect.poll(position).toBeGreaterThan(20);
  await page.mouse.move(200, 200);
  await expect(right).toHaveCount(0);
  expect(await viewport.evaluate(async element => {
    const previous = element.scrollLeft;
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return element.scrollLeft === previous;
  })).toBe(true);
  await hoverEdge(page, 'right', 10);
  await expect.poll(remaining, { timeout: 5000 }).toBeLessThanOrEqual(1);
  await expect(right).toHaveCount(0);
  await hoverEdge(page, 'left');
  await expect(page.getByRole('button', { name: '向左滚动房间音量列表', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('reduced motion scrolls only on click and removes hints for empty or nonoverflowing rails', async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 600 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors = await fixture(page);
  const viewport = page.locator('.mv-shortcut-rooms');
  const right = page.getByRole('button', { name: '向右滚动房间音量列表', exact: true });
  await hoverEdge(page, 'right', 10);
  await expect(right).toHaveCSS('transition-duration', '0s');
  expect(await viewport.evaluate(async element => {
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return element.scrollLeft;
  })).toBe(0);
  await right.click();
  await expect.poll(() => viewport.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
  await update(page, { count: 0 });
  await expect(viewport.getByRole('button')).toHaveCount(0);
  await hoverEdge(page, 'right');
  await expect(right).toHaveCount(0);
  await update(page, { count: 2 });
  await hoverEdge(page, 'right');
  await expect(right).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('mixer profile requests require an active visible avatar and reset with identity scope', async ({ page }) => {
  const errors = await fixture(page);
  const profiles = () => page.evaluate(() => (window as unknown as { __mixerSync: { calls: { profile: string[] } } }).__mixerSync.calls.profile);
  expect(await profiles()).toEqual([]);
  await update(page, { active: true });
  await expect.poll(profiles).toEqual(['42']);
  await page.locator('.mixer-fixture').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect.poll(profiles).toEqual(['42', '43']);
  await update(page, { active: false, scope: 'next-account' });
  expect(await profiles()).toEqual(['42', '43']);
  await update(page, { active: true });
  await expect.poll(profiles).toEqual(['42', '43', '43']);
  await expect(page.locator('.mv-mixer-avatar').last()).toHaveCSS('width', '22px');
  expect(errors).toEqual([]);
});

test.describe('touch shortcut rail', () => {
  test.use({ hasTouch: true, isMobile: true });
  test('native horizontal swipe preserves every room sound toggle', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 650 });
    const errors = await fixture(page);
    const viewport = page.locator('.mv-shortcut-rooms');
    const bounds = (await viewport.boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    try {
      const x = bounds.x + bounds.width * .8, y = bounds.y + bounds.height / 2;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (let step = 1; step <= 8; step++) await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove', touchPoints: [{ x: x - bounds.width * .6 * step / 8, y }]
      });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expect.poll(() => viewport.evaluate(element => element.scrollLeft)).toBeGreaterThan(20);
    } finally { await cdp.detach(); }
    expect(await page.evaluate(() => (window as unknown as { __mixerSync: { calls: { toggle: number[] } } }).__mixerSync.calls.toggle)).toEqual([]);
    await expect(page.getByRole('button', { name: /向[左右]滚动房间音量列表/ })).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
