import { expect, test, type Locator, type Page } from '@playwright/test';

test.use({ baseURL: 'http://127.0.0.1:5173/' });
const collectionKey = 'bwatch-monitor:room-collection:v1';

async function fixture(page: Page, view: 'rooms' | 'popovers') {
  const errors: string[] = [], backend: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) backend.push(request.url()); });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.getByTestId('multiview-panel')).toBeVisible();
  await page.route('**/__tool_scroll?*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><head><meta charset="UTF-8"></head><body style="margin:0;background:#111827;color:#ddd"><div id="root" class="mv-shell" style="--mv-sidebar-expanded-width:min(360px,100vw);width:min(360px,100vw);height:100dvh;display:flex;border:0;border-radius:0"></div><script type="module">
    import React from '/node_modules/.vite/deps/react.js';
    import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
    import { RoomLibraryPicker } from '/client/multiview/RoomLibraryPicker.tsx';
    import { PlaybackQualityMenu } from '/client/multiview/PlaybackQualityMenu.tsx';
    import { DanmakuComposer } from '/client/multiview/danmaku/DanmakuComposer.tsx';
    import { DanmakuRepeatPopover } from '/client/multiview/danmaku/DanmakuRepeatPopover.tsx';
    import { DanmakuEmotePicker } from '/client/multiview/danmaku/DanmakuEmotePicker.tsx';
    import { trackScrollbarGutter } from '/client/scrollbarGutter.ts';
    import '/client/style.css'; import '/client/modern.css'; import '/client/ui-scroll.css';
    import '/client/multiview/multiview.css'; import '/client/multiview/danmaku/danmaku.css';
    trackScrollbarGutter();
    const h=window.__toolScroll={choices:[],repeats:0,sends:0,selected:[],setCount(){}};
    const noop=()=>{}, yes=()=>true;
    const now=Date.now();
    const rooms=Array.from({length:40},(_,i)=>({source:'custom',roomId:String(i+1),uid:i+1,anchorName:'主播'+(i+1),title:'本地收藏直播间',status:'offline',online:null,onlineStale:false,fansCount:null,fansStale:false,guardCount:null,guardStale:false,liveStartTime:null,lastUpdatedAt:now,metadataFetchedAt:now,metadataStale:false}));
    const selected=[rooms[0]];
    const following={rooms,status:'ready',complete:true,indexing:false,refreshing:false,loadedCount:40,unmappedCount:0,scannedPages:1,setVisibleRoomIds:noop,loadMore:noop,reload:noop};
    const context={roomId:'1',accountUid:'42',authEpoch:'test',maxLength:500,emoticonsAvailable:true,emoticonPermissionsVerified:true,
      emoticons:Array.from({length:80},(_,i)=>({unique:'emote-'+i,kind:'text',text:'[表情'+i+']',description:'表情'+i,url:'',packageId:'test',packageName:'文字表情',perm:1}))};
    const chat={available:true,enabled:true,accountUid:'42',authEpoch:'test',sessionScope:'test-grant',draftScope:'test-grant',
      context:async()=>context,send:async(_room,request)=>{h.sends++;return {status:'rejected',operationId:request.operationId,message:'长错误详情用于检查原生滚动。'.repeat(80)};}};
    const message={id:'repeat',roomId:'1',kind:'danmaku',text:'需要完整阅读的弹幕内容'.repeat(30),userName:'测试',color:'#ffffff',receivedAt:now,sourceTime:now};
    function Rooms(){const [count,setCount]=React.useState(40);h.setCount=setCount;return React.createElement('div',{className:'mv-sidebar-content mv-sidebar-room-picker',style:{position:'relative',inset:'auto',width:'100%',height:'100%'}},React.createElement(RoomLibraryPicker,{
      active:true,ready:true,savedRooms:rooms.slice(0,count),selectedRooms:selected,savedIds:new Set(rooms.map(r=>r.roomId)),unavailableIds:new Set(),roomPreferences:{},adaptiveGridEnabled:false,maxWatchingRooms:12,draggingId:null,
      following,onFollowingActiveChange:noop,onOpenFollowingSetup:noop,onSave:yes,onRemoveSaved:noop,onWatch:yes,onToggle:noop,onLocate:noop,onRevalidate:async()=>{},onAddLive:noop,onClearWatching:noop,onDragStart:noop,onClickCapture:noop,resolveRoom:async()=>rooms[0]}));}
    function Popovers(){const [emotes,setEmotes]=React.useState(false);return React.createElement('div',{style:{width:'100%',display:'flex',flexDirection:'column',justifyContent:'end',gap:16,padding:12,boxSizing:'border-box'}},
      React.createElement(PlaybackQualityMenu,{name:'测试主播',quality:'0',route:'0',qualityOptions:Array.from({length:30},(_,i)=>({value:String(i),label:'画质选项'+i})),routeOptions:Array.from({length:30},(_,i)=>({value:String(i),label:'线路选项'+i})),onQualityChange:v=>h.choices.push('q:'+v),onRouteChange:v=>h.choices.push('r:'+v)}),
      React.createElement('div',{style:{position:'relative',height:32}},React.createElement(DanmakuRepeatPopover,{message,chat,state:{roomId:'1',accountUid:'42',authEpoch:'test',sessionScope:'test-grant',ready:true,context},active:true,onRepeat:()=>{h.repeats++;return true;}})),
      React.createElement(DanmakuEmotePicker,{context,open:emotes,onOpenChange:setEmotes,disabled:false,blocked:false,busy:false,onChoose:v=>h.selected.push(v.unique),onRetry:noop}),
      React.createElement(DanmakuComposer,{roomId:'1',chat,active:true}));}
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(${view === 'rooms' ? 'Rooms' : 'Popovers'}));
  </script></body></html>` }));
  await page.goto('/__tool_scroll?view=' + view);
  await expect(page.locator(view === 'rooms' ? '.mv-library-picker' : '.mv-playback-quality-trigger')).toBeVisible();
  return { errors, backend };
}

async function expectScrollable(port: Locator) {
  await expect.poll(() => port.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(20);
  await expect(port).toHaveCSS('overflow-y', 'auto');
  await expect(port).toHaveCSS('scrollbar-gutter', 'stable');
  await port.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => port.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  expect(await port.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
}

test('independent room sources persist through reload and reopen without replacing the choice with watching', async ({ page, context }) => {
  const traffic = await fixture(page, 'rooms');
  const sources = page.getByRole('group', { name: '房间来源', exact: true });
  const mine = sources.getByRole('button', { name: '我的房间', exact: true });
  const following = sources.getByRole('button', { name: 'B站关注', exact: true });
  await expect(sources.getByRole('button')).toHaveCount(2);
  await expect(mine).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(key => { localStorage.setItem('bwatch:multiview:room-collection:v1', 'following'); localStorage.setItem(key, 'catalog'); }, collectionKey);
  await page.reload();
  await expect(mine).toHaveAttribute('aria-pressed', 'true');
  await following.click();
  expect(await page.evaluate(key => localStorage.getItem(key), collectionKey)).toBe('following');
  await page.getByRole('button', { name: /观看中\s*1\s*\/\s*12/ }).click();
  await page.getByRole('button', { name: '观看列表', exact: true }).click();
  await expect(following).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await expect(following).toHaveAttribute('aria-pressed', 'true');
  await page.close();
  const reopened = await context.newPage();
  const reopenedTraffic = await fixture(reopened, 'rooms');
  await expect(reopened.getByRole('button', { name: 'B站关注', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(traffic.errors).toEqual([]); expect(traffic.backend).toEqual([]);
  expect(reopenedTraffic.errors).toEqual([]); expect(reopenedTraffic.backend).toEqual([]);
});

test('saved and followed room lists keep card width when overflow appears or disappears', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  const traffic = await fixture(page, 'rooms');
  const mine = page.getByLabel('我的房间列表', { exact: true });
  await expectScrollable(mine);
  const before = await mine.locator('.mv-library-card-wrap').first().boundingBox();
  await page.evaluate(() => (window as any).__toolScroll.setCount(1));
  await expect(mine.locator('.mv-library-card-wrap')).toHaveCount(1);
  await expect.poll(() => mine.evaluate(element => element.scrollHeight - element.clientHeight)).toBe(0);
  expect((await mine.locator('.mv-library-card-wrap').first().boundingBox())!.width).toBeCloseTo(before!.width, 0);
  await page.getByRole('button', { name: 'B站关注', exact: true }).click();
  await expectScrollable(page.getByLabel('B站关注直播间列表', { exact: true }));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(traffic.errors).toEqual([]); expect(traffic.backend).toEqual([]);
});

test('quality and route menus scroll natively while keyboard selection reaches their final option', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 480 });
  const traffic = await fixture(page, 'popovers');
  const trigger = page.getByRole('button', { name: '测试主播清晰度', exact: true });
  await trigger.focus(); await trigger.press('ArrowDown');
  const qualities = page.getByRole('menu', { name: '测试主播清晰度选项', exact: true });
  await expectScrollable(qualities);
  await page.keyboard.press('End');
  await expect(qualities.getByRole('menuitemradio', { name: '画质选项29', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => (window as any).__toolScroll.choices)).toEqual(['q:29']);
  await trigger.focus(); await trigger.press('ArrowDown');
  await page.getByRole('button', { name: '测试主播线路', exact: true }).click();
  const routes = page.getByRole('menu', { name: '测试主播线路选项', exact: true });
  await expectScrollable(routes);
  await page.keyboard.press('End');
  await expect(routes.getByRole('menuitemradio', { name: '线路选项29', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => (window as any).__toolScroll.choices)).toEqual(['q:29', 'r:29']);
  expect(traffic.errors).toEqual([]); expect(traffic.backend).toEqual([]);
});

test('long repeat previews, emote groups and send details scroll inside their popovers without dispatching extra actions', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 480 });
  const traffic = await fixture(page, 'popovers');
  await page.getByTestId('danmaku-repeat-button').click();
  const repeat = page.getByRole('dialog', { name: '复读弹幕', exact: true });
  await expectScrollable(repeat.locator('.ui-inset-scroll'));
  await expect(repeat.getByRole('button', { name: '确认发送', exact: true })).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath('repeat-scroll-narrow.png'), animations: 'disabled' });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '直播间表情', exact: true }).first().click();
  const emotes = page.getByRole('dialog', { name: '直播间表情选择', exact: true });
  await expectScrollable(emotes.locator('.mv-danmaku-emote-scroll'));
  await emotes.getByRole('button', { name: '关闭表情', exact: true }).click();
  const input = page.getByRole('textbox', { name: '发送弹幕', exact: true });
  await expect(input).toBeEnabled(); await input.fill('保留失败草稿'); await input.press('Enter');
  await page.getByRole('button', { name: '查看发言提示详情', exact: true }).click();
  const details = page.getByRole('dialog', { name: '发言提示详情', exact: true });
  await expectScrollable(details.locator('.ui-inset-scroll'));
  await expect(details.getByRole('button', { name: '关闭发言提示', exact: true })).toBeInViewport();
  await page.keyboard.press('Escape'); await expect(input).toHaveValue('保留失败草稿');
  expect(await page.evaluate(() => ({ repeats: (window as any).__toolScroll.repeats, sends: (window as any).__toolScroll.sends, selected: (window as any).__toolScroll.selected })))
    .toEqual({ repeats: 0, sends: 1, selected: [] });
  expect(traffic.errors).toEqual([]); expect(traffic.backend).toEqual([]);
});
