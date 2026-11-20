import { expect, test, type Page, type TestInfo } from '@playwright/test';

test.use({ baseURL: 'http://127.0.0.1:5173/' });

declare global {
  interface Window {
    __danmakuPanelUI: {
      update(patch: Record<string, unknown>): void;
      preferences: () => { rooms: Record<string, { enabled: boolean }>; autoWearRoomMedal?: boolean };
      calls: { clears: string[]; reconnects: string[]; setup: number; contexts: string[]; sends: string[]; medalReads: number; medalSets: number };
    };
  }
}

async function fixture(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/__danmaku_panel_ui', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><head><meta charset="UTF-8"></head><body style="margin:0;background:#111827;color:#ddd"><div id="root" class="mv-shell" style="--mv-sidebar-expanded-width:min(360px,100vw);width:min(360px,100vw);height:100dvh;display:flex;border:0;border-radius:0;box-sizing:border-box"></div><script type="module">
    import React from '/node_modules/.vite/deps/react.js';
    import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
    import { DanmakuSidebar } from '/client/multiview/danmaku/DanmakuSidebar.tsx';
    import { defaultDanmakuPreferences } from '/client/multiview/danmaku/displayPreferences.ts';
    import '/client/style.css';
    import '/client/modern.css';
    import '/client/multiview/multiview.css';
    const root=ReactDOM.createRoot(document.getElementById('root'));
    const calls={clears:[],reconnects:[],setup:0,contexts:[],sends:[],medalReads:0,medalSets:0};
    const selectedMedal={id:'10',targetUid:'42',name:'测试勋章',level:20,anchorName:'测试主播',lighted:true,color:'#309ac6'};
    const medalSnapshot={scope:'test-account:room-1',revision:0,items:[selectedMedal],wearing:selectedMedal,selectedMedal,selectedMedalId:'10',displayConfirmed:true,loaded:true,loading:false,changing:false,page:1,hasMore:false,error:'',unknown:false};
    const medals={getSnapshot:()=>medalSnapshot,subscribe:()=>()=>{},load:async()=>{calls.medalReads++;},loadRoom:async()=>{calls.medalReads++;},select:async()=>{calls.medalSets++;return true;}};
    const message=(roomId,index)=>({id:roomId+':'+index,roomId,kind:'danmaku',text:'可正常换行的弹幕正文 '+index,userName:'完整昵称_这是一个足够长而且不应截断的发送者名字',userId:'123',sourceTime:Date.now(),receivedAt:Date.now()});
    const rooms=Object.fromEntries(['1','2','3'].map(id=>[id,{status:'live',receiveMode:'anonymous',messages:[message(id,1),message(id,2)],superChats:[]}]));
    const state={roomIds:['1','2','3'],visibleIds:['1'],currentRoomId:'1',active:true,loggedIn:false,reason:'浏览器扩展尚未安装：只用于详细说明的状态，不应重复显示成大段提示',preferences:{...defaultDanmakuPreferences(),rooms:{'1':{enabled:true},'2':{enabled:false},'3':{enabled:false}}},rooms};
    const harness={update(patch){Object.assign(state,patch);render();},preferences:()=>state.preferences,calls};
    window.__danmakuPanelUI=harness;
    function render(){
      const chat={available:true,enabled:state.loggedIn,accountUid:state.loggedIn?'123':undefined,authEpoch:state.loggedIn?'epoch-1':undefined,draftScope:state.loggedIn?'123:grant-1':'',reason:state.reason,
        openSetup:()=>{calls.setup++;},medals,
        context:async(roomId)=>{calls.contexts.push(roomId);return{roomId,accountUid:'123',authEpoch:'epoch-1',emoticons:[],emoticonsAvailable:true};},
        send:async(roomId,request)=>{calls.sends.push(request.text);return{status:'submitted',operationId:request.operationId};}};
      root.render(React.createElement('div',{className:'mv-sidebar-content mv-sidebar-danmaku',style:{position:'relative',inset:'auto',width:'100%',height:'100%'}},
        React.createElement(DanmakuSidebar,{...state,chat,roomName:id=>id==='1'?'测试主播_完整长名称':'主播'+id,
          onRoomChange:id=>{state.currentRoomId=id;render();},
          onChange:next=>{state.preferences=next;render();},
          onClear:id=>{calls.clears.push(id);state.rooms={...state.rooms,[id]:{...state.rooms[id],messages:[],superChats:[]}};render();},
          onReconnect:id=>{calls.reconnects.push(id);}})));
    }
    render();
  </script></body></html>` }));
  await page.goto('/__danmaku_panel_ui');
  await expect(page.locator('.mv-danmaku-sidebar')).toBeVisible();
  return errors;
}
const update = (page: Page, patch: Record<string, unknown>) => page.evaluate(patch => window.__danmakuPanelUI.update(patch), patch);
const currentToggle = (page: Page) => page.getByRole('button', { name: /^当前直播间画面弹幕/ });
const allToggle = (page: Page) => page.getByRole('button', { name: /^全部已选直播间画面弹幕/ });
const preferences = (page: Page) => page.evaluate(() => window.__danmakuPanelUI.preferences());
const calls = (page: Page) => page.evaluate(() => window.__danmakuPanelUI.calls);
const visibleLayoutFits = (page: Page) => page.locator('.mv-danmaku-chat-view').evaluate(view => {
  const clip = view.getBoundingClientRect();
  return ['.mv-danmaku-controls', '.mv-danmaku-messages', '.mv-danmaku-composer'].every(selector => {
    const element = view.querySelector<HTMLElement>(selector)!;
    const bounds = element.getBoundingClientRect();
    return element.scrollWidth <= element.clientWidth + 1 && bounds.left >= clip.left - 1 && bounds.right <= clip.right + 1;
  });
});
async function capture(page: Page, testInfo: TestInfo, name: string) {
  await page.locator('.mv-danmaku-sidebar').evaluate(async element => {
    await Promise.all(element.getAnimations({ subtree: true })
      .filter(animation => animation.effect?.getTiming().iterations !== Infinity)
      .map(animation => animation.finished.catch(() => {})));
  });
  await expect(page.locator('.mv-danmaku-composer')).toBeInViewport();
  expect(await page.locator('.mv-danmaku-composer').evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return bounds.top >= 0 && bounds.bottom <= innerHeight + 1;
  })).toBe(true);
  await page.screenshot({ path: testInfo.outputPath(`danmaku-panel-${name}.png`), animations: 'disabled' });
}

test('top controls distinguish the current room and every selected room, including hidden rooms and mixed preferences', async ({ page }, testInfo) => {
  const errors = await fixture(page);
  await expect(currentToggle(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(allToggle(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(allToggle(page)).toHaveAccessibleName('全部已选直播间画面弹幕，部分开启');
  const group = page.locator('.mv-danmaku-heading-actions');
  expect(await group.getByRole('button').allTextContents()).toEqual(['本房', '全部· 部分', '']);
  await allToggle(page).click();
  expect((await preferences(page)).rooms).toEqual({ '1': { enabled: true }, '2': { enabled: true }, '3': { enabled: true } });
  await currentToggle(page).click();
  expect((await preferences(page)).rooms).toEqual({ '1': { enabled: false }, '2': { enabled: true }, '3': { enabled: true } });
  await expect(allToggle(page)).toHaveAccessibleName('全部已选直播间画面弹幕，部分开启');
  await allToggle(page).click();
  await allToggle(page).click();
  expect((await preferences(page)).rooms).toEqual({ '1': { enabled: false }, '2': { enabled: false }, '3': { enabled: false } });
  expect((await calls(page)).reconnects).toEqual([]);
  expect((await calls(page)).contexts).toEqual([]);
  await capture(page, testInfo, 'messages-desktop');
  expect(errors).toEqual([]);
});

test('normal reception keeps recovery actions out of the toolbar and failures expose a scoped retry', async ({ page }, testInfo) => {
  const errors = await fixture(page);
  await expect(page.locator('.mv-danmaku-status')).toHaveText('匿名接收');
  await expect(page.getByRole('button', { name: '自动滚动', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '重新连接弹幕', exact: true })).toHaveCount(0);
  await expect(page.getByRole('group', { name: '消息类型', exact: true })).toBeVisible();
  await update(page, { rooms: { '1': { status: 'retrying', messages: [], superChats: [], error: '正在等待自动恢复' } } });
  await expect(page.locator('.mv-danmaku-status')).toHaveText('等待重连');
  await expect(page.getByText('连接恢复后将继续接收弹幕', { exact: true })).toBeVisible();
  await expect(page.getByText('等待新的弹幕…', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '重新连接弹幕', exact: true })).toHaveCount(0);
  expect((await calls(page)).reconnects).toEqual([]);
  await update(page, { rooms: { '1': { status: 'error', messages: [], superChats: [], error: '本机连接暂不可用，请检查网络后重试' } } });
  await expect(page.locator('.mv-danmaku-status')).toHaveText('连接失败');
  await expect(page.getByText('连接恢复后将继续接收弹幕', { exact: true })).toBeVisible();
  await expect(page.getByText('本机连接暂不可用，请检查网络后重试', { exact: true })).toBeVisible();
  await capture(page, testInfo, 'connection-error');
  await page.getByRole('button', { name: '重新连接弹幕', exact: true }).click();
  expect((await calls(page)).reconnects).toEqual(['1']);
  await update(page, { rooms: { '1': { status: 'live', receiveMode: 'anonymous', messages: [], superChats: [] } } });
  await expect(page.getByRole('button', { name: '重新连接弹幕', exact: true })).toHaveCount(0);
  await expect(page.getByText('等待新的弹幕…', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('an interruption stays between messages and gains its recovery time in the same row', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 290, height: 620 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors = await fixture(page);
  const start = await page.evaluate(() => new Date().setHours(17, 10, 10, 0));
  const endedAt = start + 117_000;
  const before = { id: 'before-gap', roomId: '1', kind: 'danmaku', text: '断开前', userName: '测试用户', color: '#ffffff',
    connectionGeneration: 1, receivedAt: start, sourceTime: start };
  const after = { ...before, id: 'after-gap', text: '恢复后', connectionGeneration: 2, sourceTime: endedAt + 1000 };
  const room = { status: 'live', receiveMode: 'anonymous', superChats: [] };
  const gap = { id: 'pause', startedAt: start, reason: 'background', interruptedGeneration: 1 };
  const log = page.getByRole('log', { name: '普通弹幕列表' });
  const marker = log.locator('[data-gap-id="pause"]');

  await update(page, { rooms: { '1': { ...room, status: 'retrying', messages: [before], gaps: [gap] }, '2': room } });
  await expect(marker).toContainText('后台暂停接收');
  await expect(marker).toContainText('17:10:10 暂停');
  await expect(marker).toContainText('等待恢复');
  await expect(marker.locator('time')).toHaveCount(1);
  const pendingRow = await marker.elementHandle();

  await update(page, { rooms: { '1': { ...room, messages: [before, after], gaps: [{ ...gap, endedAt }] }, '2': room } });
  await expect(marker).toContainText('17:12:07 已恢复');
  await expect(marker.locator('time').nth(1)).toHaveAttribute('datetime', new Date(endedAt).toISOString());
  expect(await marker.evaluate((element, pending) => element === pending, pendingRow)).toBe(true);
  expect(await log.locator('[data-timeline-key]').evaluateAll(rows => rows.map(row => (row as HTMLElement).dataset.timelineKey)))
    .toEqual(['before-gap', 'gap:pause', 'after-gap']);
  await expect(page.locator('.mv-danmaku-record-count')).toHaveText('2 条弹幕');
  expect(await visibleLayoutFits(page)).toBe(true);
  await capture(page, testInfo, 'interruption-narrow');

  await page.getByRole('button', { name: 'SC', exact: true }).click();
  await expect(page.getByRole('log', { name: 'SC消息列表' }).locator('[data-gap-id="pause"]')).toContainText('17:12:07 已恢复');
  await expect(page.locator('.mv-danmaku-record-count')).toHaveText('0 条 SC');
  await update(page, { currentRoomId: '2' });
  await expect(page.locator('[data-gap-id]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('account setting replaces record cleanup and stays independent of display style scopes', async ({ page }, testInfo) => {
  const errors = await fixture(page);
  await expect(page.getByRole('button', { name: '清空测试主播_完整长名称的弹幕和SC', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '弹幕显示设置', exact: true }).click();
  await expect(page.getByTestId('danmaku-chat-view')).not.toBeVisible();
  await expect(page.getByRole('heading', { name: '当前直播间记录', exact: true })).toHaveCount(0);
  const automaticMedal = page.getByRole('button', { name: '切房自动佩戴勋章', exact: true });
  await expect(automaticMedal).toHaveAttribute('aria-pressed', 'false');
  await automaticMedal.click();
  await expect(automaticMedal).toHaveAttribute('aria-pressed', 'true');
  expect((await preferences(page)).autoWearRoomMedal).toBe(true);
  await page.getByRole('combobox', { name: '弹幕设置范围', exact: true }).click();
  await page.getByRole('option', { name: '主播2', exact: true }).click();
  await page.getByRole('button', { name: '恢复默认样式', exact: true }).click();
  await expect(automaticMedal).toHaveAttribute('aria-pressed', 'true');
  expect((await calls(page)).clears).toEqual([]);
  expect((await calls(page)).reconnects).toEqual([]);
  await automaticMedal.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('danmaku-panel-settings-auto-medal.png'), animations: 'disabled' });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '弹幕显示设置', exact: true })).toBeFocused();
  await expect(page.getByRole('log').locator('article')).toHaveCount(2);
  await expect(page.locator('.mv-danmaku-status')).toHaveText('匿名接收');
  expect(errors).toEqual([]);
});

test('anonymous invitation stays on one aligned row, opens setup once and becomes the authorized composer', async ({ page }, testInfo) => {
  const errors = await fixture(page);
  await page.setViewportSize({ width: 360, height: 760 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const locked = page.locator('.mv-danmaku-composer-locked');
  const entry = page.getByRole('button', { name: '连接账号', exact: true });
  await expect(entry).toBeVisible();
  await expect(locked).toContainText('连接 B站账号即可发言');
  await expect(locked).not.toContainText('浏览器扩展尚未安装');
  const boxes = await locked.evaluate(element => {
    const label = element.querySelector('span')!.getBoundingClientRect();
    const button = element.querySelector('button')!.getBoundingClientRect();
    return { labelMiddle: label.top + label.height / 2, buttonMiddle: button.top + button.height / 2, overflows: element.scrollWidth > element.clientWidth };
  });
  expect(Math.abs(boxes.labelMiddle - boxes.buttonMiddle)).toBeLessThan(3);
  expect(boxes.overflows).toBe(false);
  await entry.focus(); await page.keyboard.press('Enter');
  expect((await calls(page)).setup).toBe(1);
  expect((await calls(page)).sends).toEqual([]);
  await capture(page, testInfo, 'anonymous-narrow');
  await page.setViewportSize({ width: 320, height: 700 });
  await expect(entry).toBeInViewport();
  expect(await locked.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await capture(page, testInfo, 'anonymous-small');
  await update(page, { loggedIn: true });
  const input = page.getByRole('textbox', { name: '发送弹幕', exact: true });
  await expect(input).toBeEnabled();
  await expect(entry).toHaveCount(0);
  await input.fill('由用户主动发送');
  await input.press('Enter');
  await expect(input).toHaveValue('');
  expect((await calls(page)).sends).toEqual(['由用户主动发送']);
  await capture(page, testInfo, 'authorized-small');
  await page.setViewportSize({ width: 360, height: 760 });
  await capture(page, testInfo, 'authorized-narrow');
  expect(errors).toEqual([]);
});

test('empty selection and long room names fit a narrow sidebar, including rapid tab and settings reversals', async ({ page }, testInfo) => {
  const errors = await fixture(page);
  await page.setViewportSize({ width: 360, height: 640 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (let index = 0; index < 4; index++) {
    await page.getByRole('button', { name: 'SC', exact: true }).click();
    await expect(page.getByRole('log')).toHaveAccessibleName('SC消息列表');
    await page.getByRole('button', { name: '普通弹幕', exact: true }).click();
    await page.getByRole('button', { name: '弹幕显示设置', exact: true }).click();
    await page.keyboard.press('Escape');
  }
  expect(await visibleLayoutFits(page)).toBe(true);
  await capture(page, testInfo, 'messages-narrow');
  await page.setViewportSize({ width: 320, height: 640 });
  await expect(currentToggle(page)).toBeInViewport();
  await expect(allToggle(page)).toBeInViewport();
  await expect(page.getByRole('button', { name: '弹幕显示设置', exact: true })).toBeInViewport();
  expect(await visibleLayoutFits(page)).toBe(true);
  await capture(page, testInfo, 'messages-small');
  await update(page, { roomIds: [], visibleIds: [], currentRoomId: null });
  await expect(currentToggle(page)).toBeDisabled();
  await expect(allToggle(page)).toBeDisabled();
  await expect(page.getByRole('combobox', { name: '查看弹幕直播间', exact: true })).toBeDisabled();
  await expect(page.getByRole('log')).toContainText('选择直播间后查看弹幕');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('the medal quick toggle shares settings without changing the worn medal or sending a draft', async ({ page }) => {
  const errors = await fixture(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await update(page, { loggedIn: true });
  const input = page.getByRole('textbox', { name: '发送弹幕', exact: true });
  await expect(input).toBeEnabled();
  await input.fill('保留我的草稿');
  const trigger = page.getByRole('button', { name: '切换粉丝勋章，当前佩戴测试勋章20级', exact: true });
  await trigger.click();
  const picker = page.locator('.mv-danmaku-medal-popover');
  await expect(picker).toBeVisible();
  const quick = picker.getByRole('button', { name: '切房自动佩戴勋章', exact: true });
  await expect(quick).toHaveAttribute('aria-pressed', 'false');
  const before = await calls(page);
  await quick.click();
  await expect(quick).toHaveAttribute('aria-pressed', 'true');
  await expect(picker).toBeVisible();
  await expect(input).toHaveValue('保留我的草稿');
  expect((await preferences(page)).autoWearRoomMedal).toBe(true);
  expect((await calls(page)).medalSets).toBe(0);
  expect((await calls(page)).medalReads).toBe(before.medalReads);
  expect((await calls(page)).sends).toEqual([]);
  await picker.getByRole('button', { name: '关闭粉丝勋章', exact: true }).click();
  await page.getByRole('button', { name: '弹幕显示设置', exact: true }).click();
  const setting = page.getByTestId('danmaku-settings-view').getByRole('button', { name: '切房自动佩戴勋章', exact: true });
  await expect(setting).toHaveAttribute('aria-pressed', 'true');
  await setting.click();
  await page.keyboard.press('Escape');
  await trigger.click();
  await expect(quick).toHaveAttribute('aria-pressed', 'false');
  await expect(input).toHaveValue('保留我的草稿');
  expect((await calls(page)).medalSets).toBe(0);
  expect((await calls(page)).sends).toEqual([]);
  expect(errors).toEqual([]);
});
