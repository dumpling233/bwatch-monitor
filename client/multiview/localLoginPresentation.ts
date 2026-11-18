import type { LocalLoginSnapshot } from './localLoginController';
import { LOCAL_LOGIN_EXTENSION_NAME } from '../../shared/extensionBrand';

export type LocalLoginNextAction = 'install' | 'authorize' | 'login' | 'update' | null;
export type LocalLoginStage = 'preparing' | 'install' | 'login' | 'authorize' | 'ready' | 'recover' | 'revoke';

/** Authorization intent, current verification and actual media progress are separate UI facts. */
export function localLoginPresentation(login: LocalLoginSnapshot) {
  const unavailable = login.verificationState === 'unavailable' || login.status === 'disconnected' || login.status === 'recovering';
  const checking = login.verificationState === 'checking';
  const loggedIn = login.account?.state === 'logged-in';
  const revoking = login.revocationState === 'pending' || login.revocationState === 'unconfirmed';
  let label: string;
  let description: string;
  let tone: 'neutral' | 'pending' = 'neutral';
  let nextAction: LocalLoginNextAction = null;
  let stage: LocalLoginStage = 'preparing';

  if (login.revocationState === 'pending') {
    label = '正在撤销授权…'; description = '本页已停止使用 B站账号，正在确认其他页面的状态。'; tone = 'pending'; stage = 'revoke';
  } else if (login.revocationState === 'unconfirmed') {
    label = '撤销尚未确认'; description = '本页已停止使用账号，请重试以完成撤销。'; tone = 'pending'; stage = 'revoke';
  } else if (login.revocationState === 'revoked') {
    label = '已停止使用 B站账号'; description = '你仍可匿名观看，需要时可以重新连接。';
    nextAction = !login.extensionVersion && !login.connected ? 'install' : login.authorizationSupported ? 'authorize' : 'update';
    stage = nextAction === 'authorize' ? 'authorize' : 'install';
  } else if (login.authorizationPending) {
    label = '请在弹出的窗口确认'; description = '核对 B站账号后，点击“允许并连接”。'; tone = 'pending'; stage = 'authorize';
  } else if (!login.initialReady || login.status === 'restoring') {
    label = '正在检查连接…'; description = '已有授权会自动恢复，请稍候。'; tone = 'pending';
  } else if (unavailable && login.authorizationCurrent) {
    label = '连接暂不可用，授权已保留';
    description = '现有播放与弹幕继续，下次使用账号功能时会尝试恢复。'; tone = 'pending'; stage = 'recover';
  } else if (!login.extensionVersion && !login.connected) {
    label = '尚未安装浏览器扩展'; description = `安装 ${LOCAL_LOGIN_EXTENSION_NAME} 后即可匿名观看；连接 B站账号为可选项。`; nextAction = 'install'; stage = 'install';
  } else if (!login.authorizationSupported || login.status === 'update-required') {
    label = `请先更新 ${LOCAL_LOGIN_EXTENSION_NAME}`; description = '更新浏览器扩展后，可继续连接 B站账号。'; nextAction = 'update'; tone = 'pending'; stage = 'install';
  } else if (unavailable && !['unauthorized', 'logged-out', 'account-changed'].includes(login.status)) {
    label = '暂时无法连接 B站账号'; description = '可以重试连接；当前仍可匿名观看。'; tone = 'pending'; stage = 'recover';
  } else if (login.status === 'logged-out' || login.account?.state === 'logged-out') {
    label = '请先登录 B站'; description = '匿名观看仍可使用；登录并授权后，可查看关注列表及使用账号功能。'; nextAction = 'login'; stage = 'login';
  } else if (login.status === 'account-changed') {
    label = loggedIn ? `请确认新账号 · ${login.account!.name}` : 'B站账号已切换';
    description = '原账号已停止使用，请重新确认当前账号。'; nextAction = 'authorize'; tone = 'pending'; stage = 'authorize';
  } else if (!login.granted || login.status === 'unauthorized') {
    label = '浏览器扩展已就绪，可匿名观看'; description = '连接 B站账号后，可查看关注直播间并发送弹幕、表情。'; nextAction = 'authorize'; stage = 'authorize';
  } else if (login.status === 'authorization-required' || !login.authorizationCurrent) {
    label = loggedIn ? `请重新授权 · ${login.account!.name}` : '尚未完成账号授权';
    description = '确认一次后，即可使用账号支持的画质、弹幕和表情。'; nextAction = 'authorize'; stage = 'authorize';
  } else if (checking) {
    label = loggedIn ? `正在检查 · ${login.account!.name}` : '正在检查 B站账号…'; description = '请稍候，已有授权会继续保留。'; tone = 'pending'; stage = 'preparing';
  } else {
    label = loggedIn ? `已连接 · ${login.account!.name}` : '正在连接 B站账号…';
    description = '可使用账号支持的画质，发送弹幕和已解锁表情。不会自动发言。'; stage = loggedIn ? 'ready' : 'preparing';
  }

  return { label, description, tone, nextAction, checking, revoking, stage };
}
