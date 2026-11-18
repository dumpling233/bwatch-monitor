import React, { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, ExternalLink, Headphones, HelpCircle, MessageSquare, Puzzle, RefreshCw, ShieldCheck, Unplug } from 'lucide-react';
import { ActionButton, AnimatedCollapse, InfoDialog } from '../ui';
import { LOCAL_LOGIN_EXTENSION_NAME } from '../../shared/extensionBrand';
import type { LocalLoginState } from './useLocalLogin';
import { localLoginPresentation } from './localLoginPresentation';
import { LocalExtensionGuide } from './LocalExtensionGuide';
import { useExtensionUpdates } from './useExtensionUpdates';
import { distributionBase, type ExtensionPackage } from './extensionDistribution';
import { compareExtensionVersions, isExtensionUpdateSatisfied, MIN_MEDAL_SELECTION_VERSION, supportsMedalSelection, type ExtensionUpdateTarget } from './extensionUpdates';
import './local-login.css';

/** Only a current personal media session that has actually advanced proves success. */
export function LocalLoginIndicator({ login, streamReady }: { login: LocalLoginState; streamReady: boolean }) {
  if (!streamReady || !login.enabled || !login.connected || !login.authorizationCurrent) return null;
  const label = `本机登录取流成功 · ${login.account?.name ?? 'B站账号'}`;
  return <span className="mv-local-login-indicator" data-testid="local-login-indicator"
    title={label} aria-label={label}><ShieldCheck size={13} aria-hidden="true" /></span>;
}

type SetupStep = 1 | 2 | 3;
export type LocalAccountSetupFeature = 'chat' | 'following' | 'medals';
export interface LocalAccountSetupRequest { id: number; feature: LocalAccountSetupFeature; context: string; }
export const localAccountSetupContext = (login: Pick<LocalLoginState, 'account' | 'status' | 'revocationState'>) =>
  JSON.stringify([login.account?.uid ?? '', login.account?.authEpoch ?? '', login.revocationState,
    ['logged-out', 'account-changed'].includes(login.status) ? login.status : '']);
const setupSteps = ['安装浏览器扩展', '登录 B站', '授权使用'] as const;

/** Shared presentation only: navigation never grants an account capability. */
function AccountConnectionSteps({ installed, loggedIn, authorized = false, current, compact = false, disabled = false, onSelect }: {
  installed: boolean;
  loggedIn: boolean;
  authorized?: boolean;
  current: SetupStep;
  compact?: boolean;
  disabled?: boolean;
  onSelect?: (step: SetupStep) => void;
}) {
  return <ol className={`mv-local-steps ${compact ? 'mv-extension-prerequisites' : 'mv-local-onboarding-progress'}`}
    aria-label={compact ? '连接B站账号的步骤' : '连接账号的三个步骤'}>
    {setupSteps.map((label, index) => {
      const number = index + 1 as SetupStep;
      const done = number === 1 ? installed : number === 2 ? loggedIn : authorized;
      const active = current === number;
      const status = done ? 'completed' : active ? 'current' : 'pending';
      const content = <><span className="mv-local-step-marker" aria-hidden="true">{done ? <Check size={compact ? 12 : 14} /> : number}</span>
        <span className="mv-local-step-label">{compact && number === 1 ? '安装扩展' : label}</span></>;
      return <li key={label} data-state={status} data-complete={done} data-current={active} aria-current={active ? 'step' : undefined}>
        {onSelect ? <button type="button" aria-current={active ? 'step' : undefined}
          aria-label={'第' + number + '步：' + label + (done ? '，已完成' : '')}
          disabled={disabled || (number !== 1 && !installed)} onClick={() => onSelect(number)}>{content}</button>
          : <div className="mv-local-step-content">{content}<span className="sr-only">{done ? '，已完成' : active ? '，当前步骤' : '，待完成'}</span></div>}
      </li>;
    })}
  </ol>;
}

export function LocalLoginSettings({ login, setupRequest, onSetupRequestHandled, hasDrafts = false, active = true }: {
  login: LocalLoginState;
  streamReady?: boolean;
  setupRequest?: LocalAccountSetupRequest | null;
  onSetupRequestHandled?: (id: number) => void;
  hasDrafts?: boolean;
  active?: boolean;
}) {
  const [helpOpen, setHelpOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [guideMode, setGuideMode] = useState<'setup' | 'update'>('setup');
  const [installationDetails, setInstallationDetails] = useState(false);
  const [selectedStep, setSelectedStep] = useState<SetupStep | null>(null);
  const [loginAcknowledged, setLoginAcknowledged] = useState(false);
  const [installationChecked, setInstallationChecked] = useState(false);
  const [checkingInstallation, setCheckingInstallation] = useState(false);
  const [installationError, setInstallationError] = useState('');
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateFeedback, setUpdateFeedback] = useState('');
  const [updateCheckError, setUpdateCheckError] = useState('');
  const [guideTargets, setGuideTargets] = useState<{ download: ExtensionUpdateTarget | null;
    downloadPackage: ExtensionPackage | null }>({ download: null, downloadPackage: null });
  const [guideMinimumVersion, setGuideMinimumVersion] = useState<string | null>(null);
  const [updateCompletedNotice, setUpdateCompletedNotice] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [confirmReload, setConfirmReload] = useState(false);
  const authorizationRef = useRef<HTMLButtonElement>(null);
  const installationRef = useRef<HTMLButtonElement>(null);
  const dialogPrimaryRef = useRef<HTMLButtonElement>(null);
  const stepHeadingRef = useRef<HTMLHeadingElement>(null);
  const installationHeadingRef = useRef<HTMLElement | null>(null);
  const cardRef = useRef<HTMLElement>(null);
  const wasPending = useRef(login.authorizationPending);
  const checkGeneration = useRef(0);
  const handledSetupRequest = useRef<number | null>(null);
  const previousStep = useRef<SetupStep | null>(null);
  const id = useId();
  const state = localLoginPresentation(login);
  const updates = useExtensionUpdates({ active, installedVersion: login.extensionVersion ?? '', capabilities: login.capabilities, installationType: login.installationType });
  const account = login.account;
  const extensionDetected = Boolean(login.extensionVersion);
  const audioSupported = extensionDetected && Boolean(login.capabilities?.includes('audio-playback'));
  const followingSupported = extensionDetected && Boolean(login.capabilities?.includes('following'));
  const extensionReady = audioSupported && login.authorizationSupported;
  const needsExtensionSetup = !extensionReady;
  const extensionGuide = guideMode === 'update';
  const updateNeeded = extensionDetected && (updates.updateAvailable || !extensionReady);
  const eligibleGuideTarget = (target: ExtensionUpdateTarget | null) => target && (!guideMinimumVersion ||
    (compareExtensionVersions(target.version, guideMinimumVersion) ?? -1) >= 0) ? target : null;
  const guideTarget = eligibleGuideTarget(guideTargets.download);
  const updateComplete = extensionGuide && isExtensionUpdateSatisfied(guideTarget, login.extensionVersion ?? '', login.capabilities);
  const audioLabel = !login.initialReady ? '正在检测…' : audioSupported ? '已支持 · 无需登录' : extensionDetected ? '更新后可用' : '安装后可用';
  const extensionTone = !login.initialReady || (extensionDetected && !extensionReady) ? 'pending' : extensionDetected ? 'success' : 'neutral';
  const audioTone = !login.initialReady ? 'pending' : audioSupported ? 'success' : 'neutral';
  const previousIdentity = useRef({ uid: account?.uid, status: login.status });
  const previousNavigationStage = useRef(state.stage);
  const installed = Boolean(login.connected && login.extensionVersion && login.authorizationSupported && state.nextAction !== 'update');
  const knownLoggedIn = account?.state === 'logged-in' && state.stage !== 'login';
  const onboarding = ['install', 'login', 'authorize'].includes(state.stage);
  const complete = state.stage === 'ready' && login.authorizationCurrent;
  const suggestedStep: SetupStep = state.stage === 'install' ? 1 : state.stage === 'login' && !loginAcknowledged ? 2 : knownLoggedIn || loginAcknowledged || login.authorizationPending ? 3 : 2;
  const step: SetupStep = state.stage === 'install' ? 1 : selectedStep ?? suggestedStep;
  const installationReady = installed && extensionReady;
  const setupComplete = complete && selectedStep === null;
  const showSetupSteps = onboarding || complete || selectedStep === 1;
  const statusStep: SetupStep = !installed ? 1 : knownLoggedIn || login.authorizationPending ? 3 : 2;
  const feedback = state.stage === 'recover' || state.stage === 'revoke' ? login.message
    : login.authorizationCurrent && !login.authorizationPending ? '' : login.authorizationMessage;

  useEffect(() => () => { checkGeneration.current++; }, []);
  useEffect(() => {
    if (active) return;
    checkGeneration.current++; setCheckingInstallation(false); setCheckingUpdate(false);
  }, [active]);
  useEffect(() => {
    if (!updateFeedback) return;
    const timer = window.setTimeout(() => setUpdateFeedback(''), 3000);
    return () => window.clearTimeout(timer);
  }, [updateFeedback]);
  useEffect(() => {
    if (!guideOpen || !extensionGuide || !updateComplete) return;
    setUpdateCompletedNotice(true); setUpdateFeedback('浏览器扩展已更新');
    const timer = window.setTimeout(() => setUpdateCompletedNotice(false), 3000);
    return () => window.clearTimeout(timer);
  }, [guideOpen, extensionGuide, updateComplete]);
  useEffect(() => {
    if (!guideOpen || !extensionGuide) return;
    // Capture each channel's first eligible target and matching file. A later
    // manifest response cannot move an update goal that is already being followed.
    setGuideTargets(current => {
      const availableDownload = eligibleGuideTarget(updates.downloadTarget);
      const availablePackage = updates.download;
      const download = eligibleGuideTarget(current.download) ?? (availablePackage && availablePackage.version === availableDownload?.version ? availableDownload : null);
      const downloadPackage = download === current.download ? current.downloadPackage
        : availablePackage && availablePackage.version === download?.version ? { ...availablePackage } : null;
      if (download === current.download && downloadPackage === current.downloadPackage) return current;
      const copy = (target: ExtensionUpdateTarget | null) => target ? { version: target.version, requiredCapabilities: [...target.requiredCapabilities] } : null;
      return { download: copy(download), downloadPackage };
    });
  }, [guideOpen, extensionGuide, guideMinimumVersion, updates.downloadTarget?.version, updates.download]);
  useEffect(() => {
    const identityChanged = previousIdentity.current.uid !== account?.uid;
    const explicitIdentityChange = previousIdentity.current.status !== login.status && (login.status === 'logged-out' || login.status === 'account-changed');
    // A verification pass briefly uses `preparing`; retain the user's place
    // when it returns to the same meaningful connection stage.
    const stageChanged = state.stage !== 'preparing' && previousNavigationStage.current !== state.stage;
    if (identityChanged || explicitIdentityChange || stageChanged || !login.authorizationSupported) {
      // Detecting an installation completes the first step in place. Only the
      // user's Continue action advances to login; account changes clear it.
      const keepInstallationStep = guideOpen && !extensionGuide && selectedStep === 1
        && !identityChanged && !explicitIdentityChange && state.stage !== 'revoke';
      if (!keepInstallationStep) setSelectedStep(null);
      setInstallationChecked(false);
    }
    if (identityChanged || explicitIdentityChange || state.stage === 'install' || state.stage === 'revoke') setLoginAcknowledged(false);
    previousIdentity.current = { uid: account?.uid, status: login.status };
    if (state.stage !== 'preparing') previousNavigationStage.current = state.stage;
  }, [state.stage, login.status, account?.uid, login.authorizationSupported, guideOpen, extensionGuide]);
  useEffect(() => {
    if (wasPending.current && !login.authorizationPending) {
      // The trusted confirmation can report the same logged-out status that
      // existed before this attempt; discard only the local navigation hint.
      if (state.stage === 'login') { setLoginAcknowledged(false); setSelectedStep(null); }
      (guideOpen ? dialogPrimaryRef.current : authorizationRef.current ?? installationRef.current ?? cardRef.current)?.focus({ preventScroll: true });
    }
    wasPending.current = login.authorizationPending;
  }, [login.authorizationPending, guideOpen, state.stage]);
  useEffect(() => {
    if (guideOpen && !extensionGuide && previousStep.current !== null && previousStep.current !== step) {
      const heading = step === 1 ? installationHeadingRef.current : stepHeadingRef.current;
      heading?.focus({ preventScroll: true });
      const scroll = heading?.closest('.feature-guide-body');
      if (scroll) scroll.scrollTop = 0;
    }
    previousStep.current = guideOpen && !extensionGuide ? step : null;
  }, [guideOpen, step, extensionGuide]);
  useEffect(() => {
    if (guideOpen && (extensionGuide || step === 1)) installationHeadingRef.current?.focus({ preventScroll: true });
  }, [guideOpen, extensionGuide, updateComplete, installationReady, step, installationDetails]);

  const closeGuide = () => {
    checkGeneration.current++; setCheckingInstallation(false); setCheckingUpdate(false); setGuideOpen(false);
    if (login.authorizationPending) void login.cancelAuthorization();
  };
  const openUpdateGuide = () => {
    setGuideMinimumVersion(null);
    checkGeneration.current++; setCheckingInstallation(false); setCheckingUpdate(false); setInstallationChecked(false);
    setInstallationError(''); setUpdateCompletedNotice(false);
    const copy = (target: ExtensionUpdateTarget | null) => target ? { version: target.version, requiredCapabilities: [...target.requiredCapabilities] } : null;
    const download = updates.download?.version === updates.downloadTarget?.version ? updates.downloadTarget : null;
    setGuideTargets({ download: copy(download), downloadPackage: download && updates.download ? { ...updates.download } : null });
    setInstallationDetails(false); setGuideMode('update'); setGuideOpen(true);
  };
  const openSetupGuide = (initialStep: SetupStep | null = null) => {
    setGuideMinimumVersion(null);
    checkGeneration.current++; setCheckingInstallation(false); setCheckingUpdate(false); setInstallationChecked(false); setInstallationError('');
    setInstallationDetails(false); setSelectedStep(initialStep); setGuideMode('setup'); setGuideOpen(true);
  };
  const openAccountGuide = () => openSetupGuide();
  const openInstallationGuide = () => openSetupGuide(1);
  useEffect(() => {
    if (!active || !setupRequest || handledSetupRequest.current === setupRequest.id) return;
    // The parent clears consumed requests, so remounting settings cannot replay
    // an authorization. The ref also guards repeated effects before that render.
    handledSetupRequest.current = setupRequest.id;
    if (setupRequest.context !== localAccountSetupContext(login)) {
      onSetupRequestHandled?.(setupRequest.id);
      return;
    }
    cardRef.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    (authorizationRef.current ?? installationRef.current ?? cardRef.current)?.focus({ preventScroll: true });
    const featureNeedsUpdate = setupRequest.feature === 'following' ? !followingSupported : setupRequest.feature === 'medals'
      ? !supportsMedalSelection(login.extensionVersion, login.capabilities) : !login.capabilities?.includes('chat');
    if (login.authorizationPending || ['preparing', 'recover', 'revoke'].includes(state.stage)) {
      openAccountGuide();
      if (login.authorizationPending) setSelectedStep(3);
    } else if (!extensionDetected) {
      openInstallationGuide();
    } else if (!login.authorizationSupported || featureNeedsUpdate || state.nextAction === 'update') {
      openUpdateGuide();
      if (setupRequest.feature === 'medals') {
        setGuideMinimumVersion(MIN_MEDAL_SELECTION_VERSION);
        void checkUpdates();
      }
    } else if (!complete) {
      openAccountGuide();
      // A feature entry is an explicit request to connect. Installation and
      // update completion never reach this branch without a new user action.
      if (state.stage === 'authorize' && login.authorizationSupported && !login.busy) {
        setSelectedStep(3);
        void login.authorize();
      }
    }
    onSetupRequestHandled?.(setupRequest.id);
  }, [active, setupRequest, onSetupRequestHandled, state.stage, state.nextAction, complete,
    followingSupported, extensionDetected, login.extensionVersion, login.capabilities, login.authorizationPending, login.authorizationSupported, login.busy]);
  const checkInstallation = async () => {
    if (checkingInstallation || !active || document.hidden) return;
    const generation = ++checkGeneration.current;
    setCheckingUpdate(false);
    setCheckingInstallation(true); setInstallationError('');
    try { await login.checkExtension(); }
    catch { if (generation === checkGeneration.current) setInstallationError('暂时无法检测扩展，请确认扩展已启用，再重试。当前播放和账号不受影响。'); }
    finally { if (generation === checkGeneration.current) { setCheckingInstallation(false); setInstallationChecked(true); } }
  };
  const checkUpdates = async () => {
    if (checkingUpdate || checkingInstallation || !active || document.hidden) return;
    const generation = ++checkGeneration.current;
    setCheckingUpdate(true); setUpdateFeedback(''); setUpdateCheckError('');
    const results = await Promise.allSettled([login.checkExtension(), updates.check(true)]);
    if (generation !== checkGeneration.current) return;
    setCheckingUpdate(false);
    if (results[0].status === 'rejected') setUpdateCheckError('暂时无法检查扩展，请确认已启用后重试。当前账号和播放保持不变。');
    else setUpdateFeedback('扩展版本已检查');
  };
  const reload = () => hasDrafts ? setConfirmReload(true) : window.location.reload();
  const advanceLogin = () => { setLoginAcknowledged(true); setSelectedStep(3); };
  const footerAction = extensionGuide ? updateComplete
    ? <ActionButton ref={dialogPrimaryRef} className="mv-onboarding-primary" onClick={closeGuide}>完成</ActionButton>
    : <ActionButton ref={dialogPrimaryRef} className="mv-onboarding-primary" busy={checkingInstallation} busyLabel="正在检测浏览器扩展…" disabled={!guideTarget} onClick={() => void checkInstallation()}>我已更新，重新检测</ActionButton>
    : setupComplete ? <ActionButton ref={dialogPrimaryRef} className="mv-onboarding-primary" onClick={closeGuide}>开始使用</ActionButton>
    : showSetupSteps && step === 1 ? installationReady ? <>
      {!login.authorizationCurrent && !state.revoking && <ActionButton onClick={() => setSelectedStep(knownLoggedIn ? 3 : 2)}>继续连接账号</ActionButton>}
      <ActionButton ref={dialogPrimaryRef} className="mv-onboarding-primary" onClick={closeGuide}>完成</ActionButton>
    </> : extensionDetected && !extensionReady
      ? <ActionButton ref={dialogPrimaryRef} className="mv-onboarding-primary" onClick={openUpdateGuide}>更新浏览器扩展</ActionButton>
      : <ActionButton ref={dialogPrimaryRef} className="mv-onboarding-primary" busy={checkingInstallation} busyLabel="正在检测浏览器扩展…" onClick={() => void checkInstallation()}>已安装，检测浏览器扩展</ActionButton>
    : state.stage === 'recover' ? <ActionButton ref={dialogPrimaryRef} className="mv-onboarding-primary" busy={state.checking} busyLabel="正在重新连接…" onClick={() => void login.refresh()}>重试连接</ActionButton>
    : !showSetupSteps ? <ActionButton onClick={closeGuide}>返回</ActionButton>
    : step === 2 ? <ActionButton ref={dialogPrimaryRef} className="mv-onboarding-primary" onClick={advanceLogin}>我已登录，下一步</ActionButton>
    : complete ? <ActionButton ref={dialogPrimaryRef} className="mv-onboarding-primary" onClick={closeGuide}>完成</ActionButton>
    : <ActionButton ref={dialogPrimaryRef} data-testid="local-login-authorize" className="mv-onboarding-primary" busy={login.authorizationPending} busyLabel="等待你在浏览器扩展中确认…" disabled={state.revoking || login.busy}
      onClick={() => void login.authorize()}>授权使用 B站账号</ActionButton>;

  return <section ref={cardRef} tabIndex={-1} className="mv-local-login" aria-label={`${LOCAL_LOGIN_EXTENSION_NAME} 能力增强扩展`} data-testid="local-login-card">
    <div className="mv-local-login-heading"><strong>{LOCAL_LOGIN_EXTENSION_NAME}</strong><span>浏览器能力增强扩展</span></div>
    <div className="mv-extension-installation">
      <p className="mv-note">安装扩展后即可观看直播；连接 B站账号后，可查看关注并参与互动。</p>
      <div className="mv-extension-detection"><span className="mv-extension-capability" data-tone={extensionTone} role="status">{!login.initialReady ? '正在检测浏览器扩展…' : extensionDetected ? extensionReady ? '已检测到扩展' : '扩展需要更新' : '尚未检测到扩展'}</span>
        {extensionDetected && <span className="mv-extension-version">v{login.extensionVersion}{updateNeeded && <span className="mv-extension-update-badge">有更新</span>}</span>}</div>
      {login.initialReady && (needsExtensionSetup || updateNeeded) && <ActionButton ref={installationRef} className="mv-onboarding-primary" data-testid="local-login-start" onClick={extensionDetected ? openUpdateGuide : openInstallationGuide}>{extensionDetected ? '更新浏览器扩展' : '安装浏览器扩展'}</ActionButton>}
      {updateNeeded && <p className="mv-extension-update-benefit">{updates.missingFeatures.length ? `新版支持${updates.missingFeatures.map(feature => feature.label).join('、')}，请下载文件并手动更新。` : '新版改进了直播观看与互动体验。'}当前已可用的功能继续保留。</p>}
      {extensionDetected && <div className="mv-extension-update-check"><button type="button" className="mv-text-button" disabled={checkingUpdate || checkingInstallation} onClick={() => void checkUpdates()}>
        <RefreshCw size={12} className={checkingUpdate ? 'mv-spin' : undefined} aria-hidden="true" />{checkingUpdate ? '正在检查更新…' : updateCheckError ? '重试检查更新' : '检查更新'}</button>
        {updateFeedback && !updateCheckError && <span role="status">{updateFeedback}</span>}
      </div>}
      {updateCheckError && <p className="mv-extension-update-feedback" role="status">{updateCheckError}</p>}
    </div>
    <fieldset className="mv-extension-feature" data-testid="local-login-account-feature">
      <legend><ShieldCheck size={15} aria-hidden="true" />B站账号功能</legend>
      <p className="mv-note">使用账号支持的画质，{followingSupported ? '查看关注直播间，' : ''}接收和发送弹幕及已解锁表情。</p>
      {extensionDetected && !followingSupported && <p className="mv-extension-feature-hint">B站关注：当前扩展暂不支持，请查看上方更新指引。</p>}
    <div className="mv-local-login-summary" role="status" aria-live="polite" aria-atomic="true">
      <div className="mv-local-login-status mv-extension-capability" data-tone={complete ? 'success' : state.tone}><span>{state.label}</span></div>
      {(state.stage !== 'install' || !login.initialReady) && <p className="mv-note">{state.description}</p>}
    </div>
    {onboarding && <AccountConnectionSteps compact installed={installed} loggedIn={knownLoggedIn} current={statusStep} />}
    {onboarding && !needsExtensionSetup && <ActionButton ref={authorizationRef} className="mv-onboarding-primary" data-testid="local-login-start" disabled={state.revoking}
      onClick={openAccountGuide}>继续连接 B站账号</ActionButton>}
    {state.stage === 'recover' && <ActionButton ref={authorizationRef} className="mv-onboarding-primary" busy={state.checking} busyLabel="正在重新连接…" disabled={login.authorizationPending || state.revoking} onClick={() => void login.refresh()}>重试连接</ActionButton>}
    {!guideOpen && <AnimatedCollapse open={Boolean(feedback)}><p className="mv-local-login-message" role="status">{feedback}</p></AnimatedCollapse>}
    {login.revocationState === 'unconfirmed' && <ActionButton onClick={() => void login.disconnect()}>重试撤销</ActionButton>}
    <div className="mv-local-login-links"><button className="mv-text-button mv-local-login-help-toggle" type="button" aria-expanded={helpOpen} aria-controls={id + '-help'} onClick={() => setHelpOpen(value => !value)}>账号与帮助<ChevronDown size={13} data-open={helpOpen} /></button></div>
    <AnimatedCollapse open={helpOpen}><div className="mv-local-login-help" id={id + '-help'}>
      <p>账号凭据只由扩展在本机处理，仅用于直连 B站。刷新页面通常无需再次授权；退出 B站、换号或撤销后，需要重新连接。</p>
      <p>画质和表情能否使用，以 B站当前账号和房间的权限为准。设置上的盾牌只在实际使用账号播放成功后出现。</p>
      <a href={(distributionBase(window.location.origin) ?? '/') + 'extension-privacy.html'} target="_blank" rel="noopener noreferrer">隐私与账号信息说明<ExternalLink size={12} aria-hidden="true" /></a>
      <div className="mv-local-login-details">
        {knownLoggedIn && <span>账号 UID：{account.uid}</span>}
        {login.lastVerifiedAt > 0 && <span>最近检查：{new Date(login.lastVerifiedAt).toLocaleString('zh-CN')}</span>}
      </div>
      {login.message && login.message !== feedback && <p>{login.message}</p>}
      {login.extensionVersion && state.stage !== 'install' && <ActionButton className="mv-local-login-check" busy={state.checking && !state.revoking} busyLabel="检查中…" disabled={state.revoking || login.authorizationPending}
        aria-label="重新检查B站账号" onClick={() => void login.refresh()}><RefreshCw size={13} />重新检查账号</ActionButton>}
      {(login.granted || state.revoking) && <ActionButton className="mv-local-login-revoke" disabled={login.revocationState === 'pending'} onClick={() => setConfirmRevoke(true)}><Unplug size={13} />撤销本站授权</ActionButton>}
    </div></AnimatedCollapse>
    </fieldset>
    <fieldset className="mv-extension-feature" data-testid="local-extension-audio-feature">
      <legend><Headphones size={15} aria-hidden="true" />省流量收听</legend>
      <div className="mv-extension-capability" data-supported={audioSupported} data-tone={audioTone} role="status">{audioLabel}</div>
      <p className="mv-note">安装扩展后，选择播放器的“仅听声音”，会自动尝试只加载音频，减少流量消耗。</p>
      <p className="mv-extension-feature-hint">无需登录或授权 B站账号。是否已省流量，以播放器提示为准；暂不支持时仍可收听，但不会节省流量。</p>
    </fieldset>
    <div className="mv-local-login-links"><button type="button" className="mv-text-button" onClick={openInstallationGuide}><HelpCircle size={13} aria-hidden="true" />安装与使用帮助</button></div>

    <InfoDialog open={guideOpen} onClose={closeGuide} title={extensionGuide ? `更新 ${LOCAL_LOGIN_EXTENSION_NAME}` : '安装扩展与连接 B站账号'} description={extensionGuide ? '下载新版文件，覆盖原扩展文件夹并重新加载，完成后回到本页确认。' : '按步骤安装扩展；匿名观看无需连接 B站账号。'} icon={<HelpCircle size={22} />}
      actions={footerAction} footerNote={login.authorizationPending ? '关闭将取消尚未确认的授权。' : extensionGuide ? '更新不会自动开始账号授权。' : setupComplete ? '以后打开本页，会自动恢复同一账号。' : undefined}
      className="mv-local-login-dialog mv-local-login-guide" suspended={confirmReload}>
      <div className="mv-local-onboarding" data-testid="local-login-onboarding">
        {extensionGuide ? updateComplete && !installationDetails ? <div className="mv-local-onboarding-complete" role="status"><span><Puzzle size={30} aria-hidden="true" /></span><h3 ref={element => { installationHeadingRef.current = element; }} tabIndex={-1}>浏览器扩展已就绪</h3>
          <p>B站关注、省流量收听与账号功能已由新版扩展支持。</p>{updateCompletedNotice && <p className="mv-extension-update-success" role="status">更新完成</p>}
          <button type="button" className="mv-text-button" onClick={() => setInstallationDetails(true)}>查看安装与更新步骤</button>
        </div> : <div ref={element => { installationHeadingRef.current = element; }} tabIndex={-1} className="mv-local-installation-content" aria-label="扩展更新步骤">
          {guideTarget && <div className="mv-local-installation-target">目标版本 v{guideTarget.version}</div>}
          <LocalExtensionGuide updating active={active && guideOpen} installationType={login.installationType} installedVersion={login.extensionVersion ?? ''} capabilities={login.capabilities}
            downloadTarget={eligibleGuideTarget(guideTargets.download)}
            downloadPackage={guideTargets.downloadPackage} onRetryInfo={checkUpdates} onReload={reload} />
          <AnimatedCollapse open={installationChecked && !checkingInstallation && !updateComplete}><div className="mv-local-login-reload" role="status">
            <p>{installationError || `仍未确认更新完成${login.extensionVersion ? `，当前检测到 v${login.extensionVersion}` : ''}。请确认扩展已更新并启用，再试一次。`}</p>
            <button type="button" className="mv-text-button" onClick={() => void checkInstallation()}>重新检测浏览器扩展</button>
            <button type="button" className="mv-text-button" onClick={reload}>仍无法连接？刷新本页</button>
          </div></AnimatedCollapse>
        </div> : setupComplete ? <div className="mv-local-onboarding-complete" role="status"><span><ShieldCheck size={30} aria-hidden="true" /></span><h3>连接完成</h3>
          <p>{account?.name ? '已连接 ' + account.name + '。' : ''}账号画质、{followingSupported ? '关注直播间、' : ''}弹幕和表情功能已可使用。</p>{!followingSupported && <p>B站关注仍需更新扩展；其他账号功能可以正常使用。</p>}<p>无需分别开启功能。发送弹幕只会由你主动操作。</p></div> : showSetupSteps ? <>
          <AccountConnectionSteps installed={installed} loggedIn={knownLoggedIn} authorized={complete} current={step}
            disabled={login.authorizationPending} onSelect={setSelectedStep} />
          {step === 1 ? <div className="mv-local-installation-content" aria-label="扩展安装步骤" ref={installationReady && !installationDetails ? undefined : element => { installationHeadingRef.current = element; }} tabIndex={-1}>
              {installationReady && !installationDetails ? <div className="mv-local-onboarding-complete" role="status"><span><Puzzle size={30} aria-hidden="true" /></span>
                <h3 ref={element => { installationHeadingRef.current = element; }} tabIndex={-1}>浏览器扩展已就绪</h3><p>{login.authorizationCurrent ? '账号也已连接，可直接完成。' : '可以直接完成安装，也可以继续连接 B站账号。'}</p>
                <button type="button" className="mv-text-button" onClick={() => setInstallationDetails(true)}>查看安装步骤</button></div>
                : <LocalExtensionGuide active={active && guideOpen} />}
              <AnimatedCollapse open={installationChecked && !checkingInstallation && !installationReady}><div className="mv-local-login-reload" role="status">
                <p>{installationError || '还没有检测到。请确认扩展已开启，并允许它在当前网站运行，再试一次。'}</p>
                <button type="button" className="mv-text-button" onClick={() => void checkInstallation()}>重新检测浏览器扩展</button>
                <button type="button" className="mv-text-button" onClick={reload}>仍无法连接？刷新本页</button>
              </div></AnimatedCollapse>
          </div> : <div className="mv-local-onboarding-panel" key={step} aria-labelledby={id + '-step-title'}>
            <div className="mv-local-onboarding-title"><span>第 {step} 步</span><h3 ref={stepHeadingRef} tabIndex={-1} id={id + '-step-title'}>{setupSteps[step - 1]}</h3></div>
            {step === 2 ? <>
              <p>在这个浏览器中打开 B站并登录，完成后回到本页。已经登录过，可以直接继续。</p>
              <a className="action-button mv-local-onboarding-external" href="https://www.bilibili.com/" target="_blank" rel="noopener noreferrer">打开 B站登录<ExternalLink size={13} aria-hidden="true" /></a>
              <p className="mv-local-onboarding-hint">下一步由浏览器扩展验证账号；这里无需输入密码或复制账号信息。</p>
            </> : <>
              <p>{complete ? `已连接${account?.name ? ' ' + account.name : ' B站账号'}，账号功能已可使用。` : login.authorizationPending ? `请前往刚打开的 ${LOCAL_LOGIN_EXTENSION_NAME} 确认窗口，核对账号后点击“允许并连接”。` : '点击下方“授权使用 B站账号”，在浏览器扩展打开的窗口中核对账号，再选择“允许并连接”。'}</p>
              {!complete && <p className="mv-local-onboarding-hint">授权后，画质、弹幕和表情功能一起可用。弹幕只会在你主动提交时发送。</p>}
              {login.authorizationPending ? <button type="button" className="mv-text-button" onClick={() => void login.cancelAuthorization()}>取消本次授权</button>
                : <button type="button" className="mv-text-button" onClick={() => setSelectedStep(2)}>返回登录步骤</button>}
            </>}
          </div>}
          <p className="mv-local-onboarding-privacy"><ShieldCheck size={13} aria-hidden="true" />账号信息只在当前浏览器使用，不上传本站。</p>
        </> : <div className="mv-local-onboarding-panel" role="status"><h3>{state.label}</h3><p>{state.description}</p></div>}
        <AnimatedCollapse open={Boolean(feedback)}><p className="mv-local-login-message" role="status">{feedback}</p></AnimatedCollapse>
      </div>
    </InfoDialog>
    <InfoDialog open={confirmRevoke} onClose={() => setConfirmRevoke(false)} className="mv-local-login-dialog mv-local-login-confirm" title="撤销本站授权？" description="此网站的所有标签页都将停止使用 B站账号。不会退出 B站。"
      icon={<Unplug size={22} />} actions={<><ActionButton onClick={() => setConfirmRevoke(false)}>取消</ActionButton>
        <ActionButton className="danger-action" onClick={() => { setConfirmRevoke(false); void login.disconnect(); }}>撤销本站授权</ActionButton></>}>
      <p>之后仍可匿名观看和使用省流量收听。需要使用账号功能时，请重新连接并授权。</p>
    </InfoDialog>
    <InfoDialog open={confirmReload} onClose={() => setConfirmReload(false)} className="mv-local-login-dialog mv-local-login-confirm" title="刷新前保留草稿" description="本页仍有未发送的弹幕草稿，刷新后会清除。"
      icon={<MessageSquare size={22} />} actions={<><ActionButton onClick={() => setConfirmReload(false)}>返回保留草稿</ActionButton>
        <ActionButton onClick={() => window.location.reload()}>仍然刷新</ActionButton></>}>
      <p>可以先复制需要的文字，再刷新页面连接浏览器扩展。</p>
    </InfoDialog>
  </section>;
}
