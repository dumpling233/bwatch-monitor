import { browser } from 'wxt/browser';
import './style.css';
import { allowedPage, LOCAL_BUILD } from '../../lib/origins';
import { audioBrowserPermissions, audioPermissionRequest, authorizationPermissionRequest, isFirefoxRuntime, supportedPageContext } from '../../lib/browserCompatibility';
import type { LocalAccount, LocalLoginPreferences, LocalLoginSession } from '../../../shared/localLogin';
import { LOCAL_LOGIN_EXTENSION_NAME } from '../../../shared/extensionBrand';

type Snapshot = { ok: boolean; message?: string; origin?: string; account?: LocalAccount; preferences?: LocalLoginPreferences;
  session?: LocalLoginSession; accountUnavailable?: boolean };
const el = (id: string) => document.getElementById(id)!;
const button = (id: string) => el(id) as HTMLButtonElement;
document.title = LOCAL_LOGIN_EXTENSION_NAME;
el('extension-name').textContent = LOCAL_LOGIN_EXTENSION_NAME;
let tabId: number | undefined, origin = '', snapshot: Snapshot | undefined, previousAccount: LocalAccount | undefined;
let loaded = false, sequence = 0, needsRefresh = false, revokeUnconfirmed = false;
const firefox = isFirefoxRuntime(browser.runtime.getURL('/'));
let contextMessage = '';
let audioPermissionKnown = false, audioPermissionGranted = false, audioPermissionBusy = false;
const pending = new Set<string>();
let subscription: chrome.runtime.Port | undefined;
// A native action starts with a tiny provisional viewport. Establish intrinsic
// dimensions in CSS first; only then adapt to a genuinely smaller host area.
let layoutFrame = 0;
function fitPopupHeight() {
  cancelAnimationFrame(layoutFrame);
  layoutFrame = requestAnimationFrame(() => {
    if (window.innerHeight >= 200) document.documentElement.style.setProperty('--popup-height', `${Math.min(500, window.innerHeight)}px`);
  });
}
window.addEventListener('resize', fitPopupHeight);
fitPopupHeight();
function feedback(message: string) { el('feedback').textContent = message; el('feedback').hidden = !message; }
function render() {
  // Host access itself can hide tab.url. Do not hide its repair behind that URL.
  el('audio-permission-card').hidden = !audioPermissionKnown || audioPermissionGranted || !!contextMessage;
  button('allow-audio').disabled = audioPermissionBusy;
  button('allow-audio').textContent = audioPermissionBusy ? '等待浏览器确认…' : '允许省流量收听';
  const prefs = snapshot?.preferences, granted = !!prefs?.granted;
  const revoking = pending.has('REVOKE'), checking = pending.has('CHECK') || pending.has('STATE');
  const authorizing = pending.has('AUTHORIZE');
  const initialized = granted && prefs.authorizationVersion === 2 && prefs.connectionWanted && prefs.playbackWanted && prefs.chatWanted === true && !!prefs.expectedUid;
  const badge = el('grant-badge');
  badge.textContent = !loaded ? '检查中' : revoking ? '撤销中' : revokeUnconfirmed ? '待确认' : initialized ? '已授权' : granted ? '待重新确认' : '未授权';
  badge.classList.toggle('ready', initialized && !revoking && !revokeUnconfirmed);
  el('origin').textContent = origin ? new URL(origin).host : '';
  el('grant-status').textContent = contextMessage ? '当前标签页暂不支持' : tabId === undefined && loaded ? '请在 monitor 页面使用' : !loaded ? '正在检查当前页面…'
    : revoking ? '正在撤销本站授权…' : revokeUnconfirmed ? '撤销尚未确认' : initialized ? '本站已授权' : granted ? '请重新确认完整授权' : '尚未授权本站';
  el('grant-description').textContent = contextMessage || (revokeUnconfirmed ? '个人能力已停用；请重试，确认其他页面也已撤销。'
    : !granted ? '将授权上面的网站，并验证当前浏览器的 B站账号。仅在验证成功后使用账号。'
    : !initialized ? '旧授权、退出或换号后，需要再次确认。确认前全部账号功能保持停用。' : '账号取流、登录弹幕、勋章切换和主动发送已统一授权。');
  button('authorize').hidden = tabId === undefined || !loaded || initialized || revokeUnconfirmed;
  button('authorize').disabled = authorizing || revoking;
  button('authorize').textContent = authorizing ? '正在验证并连接…' : '连接并授权';
  el('initialization').hidden = tabId === undefined || !loaded || initialized || revokeUnconfirmed;
  button('monitor').hidden = tabId !== undefined || !loaded;
  el('account-card').hidden = !granted || !prefs?.connectionWanted || revokeUnconfirmed;
  const account = snapshot?.account;
  if (account?.state === 'logged-in') previousAccount = account;
  el('account-badge').textContent = checking ? '检查中' : snapshot?.accountUnavailable ? '暂不可用' : account?.state === 'logged-in' ? '可用' : '未登录';
  el('account-badge').classList.toggle('ready', !checking && !snapshot?.accountUnavailable && account?.state === 'logged-in');
  el('account-status').textContent = checking ? '正在检查 B站账号…' : snapshot?.accountUnavailable
    ? previousAccount?.state === 'logged-in' ? `上次使用：${previousAccount.name}` : '暂时无法检查账号'
    : account?.state === 'logged-in' ? `账号可用 · ${account.name}` : 'B站尚未登录';
  el('account-description').textContent = checking ? '请稍候，撤销授权仍可使用。' : snapshot?.accountUnavailable ? '连接恢复后会重新验证，不会把网络失败当成退出。'
    : snapshot?.session?.reason === 'account-changed' ? '账号已变化，请重新连接并授权当前账号。' : account?.state === 'logged-in' ? '连接后可使用账号取流、登录弹幕和主动发送。' : '请先前往 B站登录，再连接并授权。';
  button('check').disabled = checking || revoking || authorizing;
  button('check').textContent = checking ? '正在检查…' : '重新检查';
  button('login').textContent = granted && account?.state === 'logged-out' ? '前往 B站登录' : '打开 B站';
  button('revoke').hidden = (!granted && !revokeUnconfirmed) || tabId === undefined;
  button('revoke').disabled = revoking;
  button('revoke').textContent = revoking ? '正在撤销…' : revokeUnconfirmed ? '重试撤销' : '撤销本站授权';
}
async function refreshAudioPermission() {
  try { audioPermissionGranted = await browser.permissions.contains(audioBrowserPermissions(LOCAL_BUILD)); audioPermissionKnown = true; }
  catch { audioPermissionKnown = false; }
  render();
}
const onBrowserPermissions = () => { void refreshAudioPermission(); if (tabId === undefined) void identifyCurrentPage(); };
browser.permissions.onAdded.addListener(onBrowserPermissions);
browser.permissions.onRemoved.addListener(onBrowserPermissions);
button('allow-audio').addEventListener('click', async () => {
  if (audioPermissionBusy) return;
  audioPermissionBusy = true; feedback(''); render();
  try {
    // Invoke directly from a trusted click. This grants site access only; no NAV or account authorization.
    const allowed = await browser.permissions.request(audioPermissionRequest(firefox, LOCAL_BUILD));
    if (!allowed) feedback('浏览器尚未允许网站访问，仍会使用原来的仅声音方式。');
    await refreshAudioPermission();
    if (allowed) await identifyCurrentPage();
  } catch { feedback('暂时无法完成浏览器确认，请重试。'); }
  finally { audioPermissionBusy = false; render(); }
});
async function run(action: string) {
  if (pending.has(action)) return;
  if (action === 'OPEN_BILIBILI' || action === 'OPEN_MONITOR') {
    try { await browser.runtime.sendMessage({ action }); } catch { feedback('暂时无法打开页面，请重试。'); }
    return;
  }
  if (action === 'REVOKE' && !revokeUnconfirmed && !window.confirm('撤销本站授权？\n此网站的账号取流、登录弹幕和发送会停止，B站仍保持登录。')) return;
  const id = ++sequence;
  pending.add(action); if (action !== 'STATE') feedback(''); render();
  try {
    // Keep the browser permission prompt in this trusted click handler, before RPC/async account work.
    if (action === 'AUTHORIZE') {
      if (!await browser.permissions.request(authorizationPermissionRequest(firefox, LOCAL_BUILD)))
        throw new Error('尚未允许浏览器访问权限，账号功能未开启。请再次点击“连接并授权”后允许。');
      await refreshAudioPermission();
    }
    const next = await browser.runtime.sendMessage({ action, tabId,
      ...(action === 'AUTHORIZE' ? { revision: snapshot?.preferences?.revision,
        ...(snapshot?.account?.state === 'logged-in' ? { confirmUid: snapshot.account.uid, authEpoch: snapshot.account.authEpoch } : {}) } : {}) }) as Snapshot;
    if (!next?.ok) throw new Error(next?.message || '浏览器扩展暂不可用，请重试');
    if (id !== sequence) return;
    snapshot = next; loaded = true; origin = next.origin ?? origin;
    if (next.account?.state === 'logged-out' || next.preferences?.granted === false) previousAccount = undefined;
    if (action === 'REVOKE') { revokeUnconfirmed = false; previousAccount = undefined; feedback('本站授权已撤销。'); }
    else if (next.accountUnavailable && action !== 'STATE') feedback(next.message ?? '暂时无法检查账号，请稍后重试。');
  } catch (failure) {
    if (id !== sequence) return;
    loaded = true;
    if (action === 'REVOKE') revokeUnconfirmed = true;
    feedback(failure instanceof Error ? failure.message : '操作暂未完成，请重试。');
    if (action !== 'STATE' && action !== 'REVOKE') needsRefresh = true;
  } finally {
    pending.delete(action); render();
    if (!pending.size && needsRefresh) { needsRefresh = false; void run('STATE'); }
  }
}
for (const [id, action] of Object.entries({ authorize: 'AUTHORIZE', check: 'CHECK', revoke: 'REVOKE', login: 'OPEN_BILIBILI', monitor: 'OPEN_MONITOR' }))
  button(id).addEventListener('click', () => void run(action));
let identifying: Promise<void> | undefined;
function identifyCurrentPage(): Promise<void> {
  if (identifying) return identifying;
  const work = browser.tabs.query({ active: true, currentWindow: true }).then(tabs => {
  const tab = tabs[0];
  contextMessage = tab ? supportedPageContext(tab, firefox) ?? '' : '';
  if (tab?.id !== undefined && allowedPage(tab.url) && !contextMessage && tabId === undefined) {
    tabId = tab.id; origin = new URL(tab.url!).origin;
    subscription = browser.runtime.connect({ name: 'bwatch-monitor-popup-state' });
    subscription.onMessage.addListener(() => { if (pending.size) needsRefresh = true; else void run('STATE'); });
    subscription.onDisconnect.addListener(() => { if (loaded) feedback('浏览器扩展暂时失联，请关闭并重新打开此弹窗。'); });
    void run('STATE');
  } else { loaded = true; render(); }
  }).catch(() => { loaded = true; render(); feedback('暂时无法识别当前页面，请重新打开弹窗。'); });
  identifying = work;
  void work.finally(() => { if (identifying === work) identifying = undefined; });
  return work;
}
void identifyCurrentPage();
void refreshAudioPermission();
window.addEventListener('pagehide', () => {
  subscription?.disconnect(); subscription = undefined; cancelAnimationFrame(layoutFrame); window.removeEventListener('resize', fitPopupHeight);
  browser.permissions.onAdded.removeListener(onBrowserPermissions); browser.permissions.onRemoved.removeListener(onBrowserPermissions);
});
render();
