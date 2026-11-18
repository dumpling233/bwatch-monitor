import { browser } from 'wxt/browser';
import '../popup/style.css';
import './style.css';
import { LOCAL_BUILD } from '../../lib/origins';
import { authorizationPermissionRequest, isFirefoxRuntime } from '../../lib/browserCompatibility';
import { LOCAL_LOGIN_EXTENSION_NAME } from '../../../shared/extensionBrand';
const firefox = isFirefoxRuntime(browser.runtime.getURL('/'));
const el = (id: string) => document.getElementById(id)!;
document.title = `连接 B站账号 · ${LOCAL_LOGIN_EXTENSION_NAME}`;
el('extension-name').textContent = `${LOCAL_LOGIN_EXTENSION_NAME} 浏览器扩展`;
const allow = el('allow') as HTMLButtonElement, cancel = el('cancel') as HTMLButtonElement;
let busy = false, loaded = false;
async function command(action: string) {
  const response = await browser.runtime.sendMessage({ action });
  if (!response?.ok) throw new Error(response?.message || '本次确认已失效，请返回 monitor 重新开启。');
  return response.approval as { origin: string; name: string; uid: string; status: string };
}
async function load() {
  try {
    const state = await command('APPROVAL_STATE');
    el('origin').textContent = state.origin;
    el('account').textContent = state.name;
    el('status').textContent = state.uid ? '请确认网站和账号，再连接并授权。' : '允许后将验证当前浏览器账号；未登录或验证失败时不会启用。';
    loaded = true; allow.disabled = false;
  } catch (failure) { el('status').textContent = failure instanceof Error ? failure.message : '本次确认已失效。'; el('login').hidden = false; }
}
async function decide(approved: boolean) {
  if (busy) return;
  if (!approved && !loaded) { window.close(); return; }
  busy = true; allow.disabled = true; cancel.disabled = true;
  el('status').textContent = approved ? '正在验证并连接…' : '正在取消…';
  try {
    if (approved && !await browser.permissions.request(authorizationPermissionRequest(firefox, LOCAL_BUILD)))
      throw new Error('尚未允许浏览器访问权限，账号功能未开启。请返回 monitor 重新连接并授权。');
    const state = await command(approved ? 'APPROVAL_ALLOW' : 'APPROVAL_CANCEL');
    el('status').textContent = state.status === 'approved' ? '账号已连接并授权，可以返回 monitor。' : '已取消，账号功能保持原状。';
    window.close();
  } catch (failure) {
    el('status').textContent = failure instanceof Error ? failure.message : '未能开启，请返回 monitor 重试。';
    el('login').hidden = false;
    cancel.disabled = false; cancel.textContent = '关闭'; loaded = false; busy = false;
  }
}
allow.addEventListener('click', () => void decide(true));
cancel.addEventListener('click', () => void decide(false));
window.addEventListener('keydown', event => { if (event.key === 'Escape' && !busy) void decide(false); });
void load();
