import React, { useEffect, useId, useRef, useState } from 'react';
import { Copy, Download } from 'lucide-react';
import { ActionButton, AnimatedCollapse, SegmentedControl } from '../ui';
import { LOCAL_LOGIN_EXTENSION_NAME } from '../../shared/extensionBrand';
import { distributionBase, getExtensionBrowser, type ExtensionBrowser, type ExtensionPackage } from './extensionDistribution';
import { useExtensionUpdates } from './useExtensionUpdates';
import { fetchExtensionPackageBlob } from './extensionPackageDownload';
import type { ExtensionUpdateTarget } from './extensionUpdates';
import './local-extension-guide.css';

const browsers: Array<{ value: ExtensionBrowser; label: string }> = [
  { value: 'chrome', label: 'Chrome' }, { value: 'edge', label: 'Edge' }, { value: 'other', label: '其他浏览器' }
];
export type ExtensionGuideMethod = 'file';

/** Installation never authorizes a B站 account. */
export function LocalExtensionGuide({ updating = false, active = true, installationType, installedVersion = '', capabilities,
  downloadTarget, downloadPackage, onRetryInfo, onReload }: {
  updating?: boolean; active?: boolean; installationType?: string; installedVersion?: string; capabilities?: readonly string[];
  method?: ExtensionGuideMethod | null; onMethodChange?: (method: ExtensionGuideMethod) => void;
  downloadPackage?: ExtensionPackage | null; downloadTarget?: ExtensionUpdateTarget | null;
  onRetryInfo?: () => Promise<void>; onReload?: () => void;
}) {
  const [browser, setBrowser] = useState<ExtensionBrowser>(() => getExtensionBrowser(navigator.userAgent));
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [fileState, setFileState] = useState<'idle' | 'preparing' | 'ready' | 'error'>('idle');
  const [preparedUrl, setPreparedUrl] = useState('');
  const copyGeneration = useRef(0), fileGeneration = useRef(0);
  const fileRequest = useRef<AbortController | null>(null), objectUrl = useRef('');
  const id = useId();
  const updates = useExtensionUpdates({ active, browser, installedVersion, capabilities, installationType });
  const supported = browser !== 'other';
  const download = downloadPackage === undefined ? updates.download : downloadPackage;
  const confirmedTarget = downloadTarget === undefined ? updates.downloadTarget : downloadTarget;
  const matchingDownload = !updating || download?.version === confirmedTarget?.version ? download : null;
  const address = browser === 'edge' ? 'edge://extensions' : 'chrome://extensions';
  const name = browser === 'edge' ? 'Edge' : 'Chrome';
  useEffect(() => {
    const stop = () => {
      ++fileGeneration.current; fileRequest.current?.abort(); fileRequest.current = null;
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = ''; setPreparedUrl(''); setFileState('idle');
    };
    stop(); return stop;
  }, [active, browser, matchingDownload?.url, matchingDownload?.sha256]);
  useEffect(() => {
    const stop = () => {
      ++fileGeneration.current; fileRequest.current?.abort(); fileRequest.current = null;
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = ''; setPreparedUrl(''); setFileState('idle');
    };
    const visibility = () => { if (document.hidden) stop(); };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('offline', stop); window.addEventListener('pagehide', stop);
    return () => {
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('offline', stop); window.removeEventListener('pagehide', stop);
    };
  }, []);
  useEffect(() => {
    setCopyState('idle'); ++copyGeneration.current;
    return () => { ++copyGeneration.current; };
  }, [active, browser]);
  const prepareDownload = async (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (preparedUrl && fileState === 'ready') return;
    event.preventDefault();
    if (!active || document.hidden || !matchingDownload || fileRequest.current) return;
    const controller = new AbortController(), generation = ++fileGeneration.current;
    fileRequest.current = controller; setFileState('preparing');
    try {
      const blob = await fetchExtensionPackageBlob(matchingDownload, controller.signal);
      if (controller.signal.aborted || generation !== fileGeneration.current) return;
      const url = URL.createObjectURL(blob);
      objectUrl.current = url; setPreparedUrl(url); setFileState('ready');
      const link = document.createElement('a');
      link.href = url; link.download = matchingDownload.url.split('/').at(-1)!; link.hidden = true;
      document.body.append(link);
      try { link.click(); } finally { link.remove(); }
    } catch {
      if (!controller.signal.aborted && generation === fileGeneration.current) setFileState('error');
    } finally { if (generation === fileGeneration.current) fileRequest.current = null; }
  };
  const retryInfo = () => void Promise.allSettled([updates.check(true), onRetryInfo?.()]);
  const copyAddress = async () => {
    if (!active) return;
    const generation = ++copyGeneration.current;
    try { await navigator.clipboard.writeText(address); if (copyGeneration.current === generation) setCopyState('copied'); }
    catch { if (copyGeneration.current === generation) setCopyState('failed'); }
  };
  return <div className="mv-extension-guide" data-testid="local-extension-guide">
    <section className="mv-extension-guide-choice" aria-labelledby={id + '-browser'}>
      <h3 className="mv-extension-guide-heading" id={id + '-browser'}>选择浏览器</h3>
      <SegmentedControl value={browser} defaultValue="chrome" options={browsers} onChange={setBrowser} label="安装扩展的浏览器" />
    </section>
    {!supported ? <div className="mv-extension-guide-callout"><p>请使用电脑上的 Chrome 120 及以上版本或对应版本的 Edge。</p><p>安装扩展后即可观看直播；Firefox、Safari 和手机浏览器暂不支持完整功能。</p></div> : <section className="mv-extension-guide-details" aria-labelledby={id + '-instructions'}>
      <h3 className="mv-extension-guide-heading" id={id + '-instructions'}>{updating ? '按步骤更新' : '按步骤安装'}<small>{name} · 文件安装</small></h3>
      <p className="mv-extension-guide-muted">Chrome 和 Edge 使用同一安装包。扩展通过文件安装，后续需要手动更新。</p>
      <div className="mv-extension-guide-instructions"><div className="mv-extension-guide-manual">
        {updating && !confirmedTarget ? <div className="mv-extension-guide-callout"><p>尚未获取到可用更新包，请保留当前扩展。</p><button type="button" className="mv-extension-guide-disclosure" disabled={updates.checking} onClick={retryInfo}>重新检查新版信息</button></div> : <ol>
          <li><strong>{updating ? '下载新版并替换原文件夹' : '下载安装包并解压'}</strong>
            {matchingDownload ? <a className="action-button" href={preparedUrl || (distributionBase(window.location.origin) ?? '/') + matchingDownload.url}
              download={matchingDownload.url.split('/').at(-1)} aria-disabled={fileState === 'preparing'} onClick={event => void prepareDownload(event)}>
              <Download size={14} aria-hidden="true" />{fileState === 'preparing' ? '正在校验安装包…' : fileState === 'ready' ? '再次保存 ' + LOCAL_LOGIN_EXTENSION_NAME + ' v' + matchingDownload.version : '下载 ' + LOCAL_LOGIN_EXTENSION_NAME + ' v' + matchingDownload.version}</a>
              : <><p className="mv-extension-guide-muted" role="status">{updates.checking ? '正在查找安装包…' : '暂时没有可用的安装包，请稍后重试。'}</p><button type="button" className="mv-extension-guide-disclosure" disabled={updates.checking} onClick={retryInfo}>重新检查安装包</button></>}
            {fileState === 'ready' && <p className="mv-extension-guide-muted" role="status">安装包已校验。如果浏览器未开始保存，请点击“再次保存”。</p>}
            {fileState === 'error' && <div className="mv-extension-guide-callout" role="status"><p>下载或完整性校验失败，请刷新本页后重试。</p>{onReload && <ActionButton onClick={onReload}>刷新本页获取安装包</ActionButton>}</div>}
            <p>{updating ? '将新版 ZIP 解压到原来的扩展文件夹并覆盖旧文件，保持原文件夹位置。' : '将 ZIP 解压到一个会保留的文件夹；浏览器运行时仍需要这些文件。'}</p></li>
          <li><strong>打开浏览器的扩展管理页</strong><p>将以下地址复制到 {name} 地址栏并回车。</p>
            <div className="mv-extension-guide-address"><input aria-label={name + ' 扩展管理页地址'} readOnly value={address} onFocus={event => event.currentTarget.select()} />
              <ActionButton disabled={!active} onClick={() => void copyAddress()}><Copy size={13} aria-hidden="true" />{copyState === 'copied' ? '已复制' : '复制地址'}</ActionButton>
              <AnimatedCollapse className="mv-extension-guide-copy-feedback" open={copyState === 'failed'}><p role="status">请选中地址，手动复制到浏览器地址栏。</p></AnimatedCollapse></div></li>
          <li><strong>{updating ? '重新加载扩展' : '加载解压后的文件夹'}</strong>
            <p>{updating ? '找到 ' + LOCAL_LOGIN_EXTENSION_NAME + ' 并点击“重新加载”；如提示权限变更，请确认并启用。' : '开启“开发者模式”，点击“' + (browser === 'edge' ? '加载解压缩的扩展' : '加载已解压的扩展程序') + '”，选择刚才的文件夹。'}</p>
            <p>完成后回到本页，点击下方按钮检测连接。下载文件本身不会完成安装或账号授权。</p></li>
        </ol>}
      </div></div>
    </section>}
  </div>;
}
