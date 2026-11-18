import React, { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, useSyncExternalStore, type Ref } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { LoaderCircle, Send, ShieldCheck, X } from 'lucide-react';
import { UiPopoverContent } from '../../ui';
import type { LocalChatContext, LocalDanmakuSendResult, LocalPublicProfile } from '../../../shared/localDanmaku';
import { DanmakuEmotePicker } from './DanmakuEmotePicker';
import { repeatContentRestriction, type DanmakuRepeatContent, type DanmakuRepeatState } from './repeatMessage';
import { emoticonUseRestriction } from './emoticonUse';
import { DanmakuMedalPicker } from './DanmakuMedalPicker';
import type { DanmakuMedalAdapter } from '../localMedalClient';

export interface DanmakuChatAdapter {
  available: boolean;
  enabled: boolean;
  accountUid?: string;
  authEpoch?: string;
  /** Stable for one authorized account; transport credential renewals do not change it. */
  sessionScope?: string;
  reason?: string;
  draftScope?: string;
  context(roomId: string, signal: AbortSignal, force?: boolean): Promise<LocalChatContext>;
  send(roomId: string, request: { operationId: string; authEpoch: string; text?: string; emoticonUnique?: string }, signal: AbortSignal): Promise<LocalDanmakuSendResult>;
  result?(operationId: string, signal: AbortSignal): Promise<LocalDanmakuSendResult>;
  profile?(uid: string, signal: AbortSignal): Promise<LocalPublicProfile | null>;
  rememberAvatar?(uid: string, face: string): void;
  rejectAvatar?(uid: string, face: string): void;
  medals?: DanmakuMedalAdapter;
  openMedalSetup?(): void;
  enable?(): void;
  openSetup?(): void;
  onDraftPresenceChange?(hasDrafts: boolean): void;
}
type PendingSend = { operationId: string; owner: string; text?: string; emoticonUnique?: string; preserveDraft?: boolean; onRepeatSubmitted?: () => void };
export interface DanmakuComposerHandle { repeat(content: DanmakuRepeatContent, roomId: string): boolean; }
type Feedback = { key: string; source: 'context' | 'send'; kind: 'success' | 'error' | 'unknown' | 'progress'; text: string };
const CONTEXT_REUSE_MS = 24 * 60 * 60_000;
const noMedalSubscription = () => () => {};
const noMedalWrite = () => false;

/** Detail stays out of the fixed footer's layout, including on narrow sidebars. */
function ComposerFeedback({ text, kind, active }: { text: string; kind?: Feedback['kind']; active: boolean }) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [container, setContainer] = useState<Element | undefined>(undefined);
  useEffect(() => { setOpen(false); }, [text, active]);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const hide = () => { if (document.hidden) close(); };
    document.addEventListener('visibilitychange', hide);
    document.addEventListener('fullscreenchange', close);
    return () => { document.removeEventListener('visibilitychange', hide); document.removeEventListener('fullscreenchange', close); };
  }, [open]);
  const detailed = Boolean(text && (kind === 'error' || kind === 'unknown'));
  return <div className="mv-danmaku-compose-feedback" aria-live="polite" data-kind={kind}>
    {detailed ? <Popover.Root open={open && active} onOpenChange={value => {
      if (value) setContainer(document.fullscreenElement ?? triggerRef.current?.closest('.mv-shell') ?? undefined);
      setOpen(value);
    }}>
      <Popover.Trigger asChild><button ref={triggerRef} type="button" className="mv-danmaku-composer-notice" title={text} aria-label="查看发言提示详情">{text}</button></Popover.Trigger>
      <Popover.Portal container={container}><UiPopoverContent returnFocusRef={triggerRef} className="mv-danmaku-compose-detail" side="top" align="end" sideOffset={8} collisionPadding={10} aria-label="发言提示详情"
        onEscapeKeyDown={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}>
        <header><strong>发言提示</strong><Popover.Close asChild><button type="button" aria-label="关闭发言提示"><X size={14} /></button></Popover.Close></header><p>{text}</p>
      </UiPopoverContent></Popover.Portal>
    </Popover.Root> : <span className="mv-danmaku-composer-notice">{text}</span>}
  </div>;
}

/** Sending belongs to a room and account authorization, independently of transport renewal. */
export function DanmakuComposer({ roomId, chat, active = true, repeatRef, onRepeatStateChange, onRepeatSubmitted }: {
  roomId: string | null; chat?: DanmakuChatAdapter; active?: boolean; repeatRef?: Ref<DanmakuComposerHandle>;
  onRepeatStateChange?: (state: DanmakuRepeatState | null) => void;
  onRepeatSubmitted?: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [contextValue, setContext] = useState<{ key: string; value: LocalChatContext } | null>(null);
  const [loading, setLoading] = useState(false);
  const [emoteOpenKey, setEmoteOpenKey] = useState<string | null>(null);
  const [medalOpenKey, setMedalOpenKey] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [pending, setPending] = useState<PendingSend | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [clock, setClock] = useState(Date.now());
  const [contextRevision, setContextRevision] = useState(0);
  const contextCacheRef = useRef<{ key: string; revision: number; until: number; value: LocalChatContext } | null>(null);
  const forceContextRef = useRef(false);
  const operationRef = useRef<AbortController | null>(null);
  const inFlightRef = useRef(false);
  const composingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const draftsRef = useRef(new Map<string, string>());
  const operationsRef = useRef(new Map<string, PendingSend>());
  const authorizationScopeRef = useRef('');
  const draftPresenceRef = useRef(chat?.onDraftPresenceChange);
  draftPresenceRef.current = chat?.onDraftPresenceChange;
  const draftAccount = chat?.draftScope ?? canDraftAccount(chat);
  const draftKey = `${draftAccount}:${roomId ?? ''}`;
  const operationScope = draftAccount ? `${chat?.sessionScope ?? 'legacy'}:${draftAccount}` : '';
  const operationKey = `${roomId ?? ''}:${operationScope}`;
  const operationKeyRef = useRef(operationKey);
  operationKeyRef.current = operationKey;
  const currentKey = `${operationKey}:${chat?.accountUid ?? ''}:${chat?.authEpoch ?? ''}:${Boolean(chat?.enabled)}`;
  const keyRef = useRef(currentKey);
  keyRef.current = currentKey;
  // A same-account worker restart changes credentials while the requested
  // medal operation is still running. Keep its progress and result visible.
  const medalKey = `${operationKey}:${chat?.accountUid ?? ''}:${Boolean(chat?.enabled)}`;
  const medalKeyRef = useRef(medalKey);
  medalKeyRef.current = medalKey;
  const showEmotes = emoteOpenKey === currentKey;
  const setShowEmotes = useCallback((open: boolean) => {
    if (keyRef.current === currentKey) { setEmoteOpenKey(open ? currentKey : null); if (open) setMedalOpenKey(null); }
  }, [currentKey]);
  const setShowMedals = useCallback((open: boolean) => {
    if (medalKeyRef.current === medalKey) { setMedalOpenKey(open ? medalKey : null); if (open) setEmoteOpenKey(null); }
  }, [medalKey]);
  useEffect(() => { setMedalOpenKey(null); }, [medalKey]);
  const canConnect = Boolean(roomId && chat?.available && chat.enabled && chat.authEpoch && chat.accountUid);
  const context = contextValue?.key === currentKey ? contextValue.value : null;
  const currentPending = pending?.owner === operationKey ? pending : null;
  const currentFeedback = feedback?.key === operationKey ? feedback : null;
  const setNotice = (text: string, kind: Feedback['kind'] = 'error') => setFeedback(text ? { key: operationKey, source: 'send', text, kind } : null);

  useEffect(() => {
    contextCacheRef.current = null;
    forceContextRef.current = false;
    operationRef.current?.abort(); operationRef.current = null; inFlightRef.current = false;
    if (!operationScope || operationScope !== authorizationScopeRef.current) { draftsRef.current.clear(); operationsRef.current.clear(); }
    draftPresenceRef.current?.(draftsRef.current.size > 0);
    authorizationScopeRef.current = operationScope;
    const priorOperation = operationsRef.current.get(draftKey) ?? null;
    setDraft(draftsRef.current.get(draftKey) ?? ''); setPending(priorOperation); setUncertain(Boolean(priorOperation)); setNotice(priorOperation ? '上次发送结果尚未确认，请先确认结果' : '', 'unknown'); setContext(null); setShowEmotes(false); setCooldownUntil(0);
    return () => operationRef.current?.abort();
  }, [operationKey, operationScope]);
  useEffect(() => () => draftPresenceRef.current?.(false), []);
  useEffect(() => {
    if (!active || !canConnect || !roomId || !chat) { setLoading(false); return; }
    const cached = contextCacheRef.current;
    if (cached?.key === currentKey && cached.revision === contextRevision && cached.until > Date.now()) {
      setContext({ key: currentKey, value: cached.value }); setLoading(false); return;
    }
    // Reuse only a successful, current context when the UI is activated again;
    // expiry never schedules background work and explicit retries bypass it.
    contextCacheRef.current = null;
    const controller = new AbortController(), expected = currentKey, expectedOperation = operationKey;
    setLoading(true);
    const force = forceContextRef.current;
    forceContextRef.current = false;
    void chat.context(roomId, controller.signal, force).then(value => {
      if (controller.signal.aborted || expected !== keyRef.current) return;
      if (value.roomId !== roomId || value.authEpoch !== chat.authEpoch || value.accountUid !== chat.accountUid) throw new Error('暂时无法发送，请稍后重试');
      if (value.emoticonsAvailable !== false) contextCacheRef.current = { key: expected, revision: contextRevision, until: Date.now() + CONTEXT_REUSE_MS, value };
      setContext({ key: expected, value });
      setFeedback(previous => previous?.key === expectedOperation && previous.source === 'context' ? null : previous);
    }).catch(() => { if (!controller.signal.aborted && expected === keyRef.current) {
      setContext(null);
      setFeedback(previous => previous?.key === expectedOperation && previous.source === 'send' ? previous : {
        key: expectedOperation, source: 'context', kind: 'error', text: '暂时无法发送，请稍后重试'
      });
    } })
      .finally(() => { if (!controller.signal.aborted && expected === keyRef.current) setLoading(false); });
    return () => controller.abort();
  }, [currentKey, contextRevision, canConnect, active]);
  useEffect(() => { if (!active) setShowEmotes(false); }, [active]);
  useEffect(() => {
    if (feedback?.kind !== 'success') return;
    const clear = () => setFeedback(previous => previous === feedback ? null : previous);
    if (!active || document.hidden || feedback.key !== operationKey) { clear(); return; }
    const timer = window.setTimeout(clear, 2000);
    const hide = () => { if (document.hidden) clear(); };
    document.addEventListener('visibilitychange', hide);
    return () => { window.clearTimeout(timer); document.removeEventListener('visibilitychange', hide); };
  }, [feedback, operationKey, active]);
  useEffect(() => {
    if (!active) return;
    setClock(Date.now());
    if (cooldownUntil <= Date.now()) return;
    const timer = window.setTimeout(() => setClock(Date.now()), cooldownUntil - Date.now());
    return () => window.clearTimeout(timer);
  }, [cooldownUntil, active]);
  const cooldown = Math.max(0, Math.ceil((cooldownUntil - clock) / 1000));
  const refreshContext = () => {
    if (loading) return;
    forceContextRef.current = true;
    setContextRevision(value => value + 1);
  };
  const maxLength = context?.maxLength ?? 500;
  const count = Array.from(draft).length;
  const medalWritePending = useSyncExternalStore(chat?.medals?.subscribe ?? noMedalSubscription, () => {
    const value = chat?.medals?.getSnapshot();
    return Boolean(value?.changing && !value.automaticChanging);
  }, noMedalWrite);
  const canSend = active && canConnect && Boolean(context) && !context?.muted && !currentPending && !loading && !cooldown && !medalWritePending;
  const writeDraft = (value: string) => {
    setFeedback(previous => previous?.kind === 'success' ? null : previous);
    setDraft(value);
    if (!draftAccount) return;
    draftsRef.current.delete(draftKey);
    if (value) draftsRef.current.set(draftKey, value);
    while (draftsRef.current.size > 16) draftsRef.current.delete(draftsRef.current.keys().next().value!);
    draftPresenceRef.current?.(draftsRef.current.size > 0);
  };

  const applyResult = (value: LocalDanmakuSendResult, operation: PendingSend) => {
    if (value.operationId !== operation.operationId) { setUncertain(true); setNotice('发送结果尚未确认，请确认结果后再发送', 'unknown'); return; }
    if (value.status === 'submitted') {
      // A submitted POST is distinct from a WebSocket echo; the list remains upstream-only.
      if (operation.text && !operation.preserveDraft) {
        setDraft(previous => previous === operation.text ? '' : previous);
        if (draftsRef.current.get(draftKey) === operation.text) draftsRef.current.delete(draftKey);
        draftPresenceRef.current?.(draftsRef.current.size > 0);
      }
      operationsRef.current.delete(draftKey); setPending(null); setUncertain(false); setNotice('已发送', 'success'); setShowEmotes(false);
      const seconds = context?.cooldownSeconds;
      if (seconds && seconds > 0) { const now = Date.now(); setClock(now); setCooldownUntil(now + seconds * 1000); }
      operation.onRepeatSubmitted?.();
    } else if (value.status === 'rejected') {
      operationsRef.current.delete(draftKey); setPending(null); setUncertain(false); setNotice(value.message || '发送失败，请检查发言权限');
      // The helper rechecks image permission before dispatch. Read its updated
      // catalogue after a refusal while keeping the concrete failure visible.
      if (operation.emoticonUnique) { forceContextRef.current = true; setContextRevision(revision => revision + 1); }
    }
    else { setUncertain(true); setNotice(value.message || '发送结果尚未确认，请确认结果后再发送', 'unknown'); }
  };
  const send = (emoticonUnique?: string, repeated?: DanmakuRepeatContent): boolean => {
    if (!canSend || !roomId || !chat?.authEpoch || inFlightRef.current) return false;
    if (operationsRef.current.size >= 16 && !operationsRef.current.has(draftKey)) { setNotice('请先确认其他直播间的待确认发送结果'); return false; }
    const content = repeated?.text ?? draft;
    const imageUnique = repeated?.emoticonUnique ?? emoticonUnique;
    if (repeated) {
      const restriction = repeatContentRestriction(repeated, context);
      if (restriction) { setNotice(restriction); return false; }
    }
    if (imageUnique) {
      const restriction = emoticonUseRestriction(context, imageUnique, 'image');
      if (restriction) { setNotice(restriction); return false; }
    }
    if (!imageUnique && (!content.trim() || Array.from(content).length > maxLength)) return false;
    const operation: PendingSend = { operationId: crypto.randomUUID(), owner: operationKey, ...(imageUnique ? { emoticonUnique: imageUnique } : { text: content }),
      ...(repeated ? { preserveDraft: true, onRepeatSubmitted } : {}) };
    const controller = new AbortController(), expected = operationKey;
    operationsRef.current.set(draftKey, operation);
    operationRef.current = controller; inFlightRef.current = true; setPending(operation); setUncertain(false); setNotice('发送中…', 'progress');
    void chat.send(roomId, { operationId: operation.operationId, text: operation.text, emoticonUnique: operation.emoticonUnique, authEpoch: chat.authEpoch }, controller.signal).then(value => {
      if (!controller.signal.aborted && expected === operationKeyRef.current) applyResult(value, operation);
    }).catch(() => { if (!controller.signal.aborted && expected === operationKeyRef.current) { setUncertain(true); setNotice('发送结果尚未确认，请先确认结果', 'unknown'); } })
      .finally(() => { if (expected === operationKeyRef.current) inFlightRef.current = false; });
    return true;
  };
  const queryResult = () => {
    if (!currentPending || !chat?.result || inFlightRef.current) return;
    const controller = new AbortController(), expected = operationKey;
    operationRef.current = controller; inFlightRef.current = true; setNotice('发送中…', 'progress');
    void chat.result(currentPending.operationId, controller.signal).then(value => { if (!controller.signal.aborted && expected === operationKeyRef.current) applyResult(value, currentPending); })
      .catch(() => { if (!controller.signal.aborted && expected === operationKeyRef.current) setNotice('发送结果尚未确认，请稍后再确认', 'unknown'); })
      .finally(() => { if (expected === operationKeyRef.current) inFlightRef.current = false; });
  };

  useImperativeHandle(repeatRef, () => ({ repeat: (content, expectedRoom) => expectedRoom === roomId && send(undefined, content) }));
  useLayoutEffect(() => {
    onRepeatStateChange?.({ roomId, accountUid: chat?.accountUid, authEpoch: chat?.authEpoch, sessionScope: chat?.sessionScope,
      ready: canSend, context });
  }, [onRepeatStateChange, roomId, chat?.accountUid, chat?.authEpoch, chat?.sessionScope, canSend, context]);
  useEffect(() => () => onRepeatStateChange?.(null), [onRepeatStateChange]);

  const retainSendingUi = Boolean(operationScope && (currentPending || currentFeedback?.source === 'send'));
  if (!canConnect && !retainSendingUi) return <div className="mv-danmaku-composer mv-danmaku-composer-locked">
    <div className="mv-danmaku-compose-prompt" title={chat?.reason} role="status"><ShieldCheck size={14} aria-hidden="true" /><span>{!roomId ? '选择直播间后可发言' : chat?.enabled ? '暂时无法发送，请稍后重试' : '连接 B站账号即可发言'}</span></div>
    {roomId && (chat?.enable || chat?.openSetup) && <button type="button" className="mv-text-button" onClick={() => (chat.enable ?? chat.openSetup)?.()}>{chat.enabled ? '查看账号状态' : '连接账号'}</button>}
  </div>;
  const footerText = currentFeedback?.text || (context?.muted ? '当前直播间暂时无法发言' : '');
  const footerKind = currentFeedback?.kind ?? (context?.muted ? 'error' : undefined);
  return <div className="mv-danmaku-composer">
    <div className="mv-danmaku-compose-input-row">
      <DanmakuMedalPicker adapter={chat?.medals} active={active && canConnect} disabled={Boolean(currentPending)} open={medalOpenKey === medalKey}
        onOpenChange={setShowMedals} onSetup={chat?.openMedalSetup} />
      <input ref={inputRef} type="text" autoComplete="off" aria-label="发送弹幕" placeholder="发个弹幕吧~" title={currentPending ? currentFeedback?.kind === 'progress' ? '发送中…' : '请先确认发送结果' : !context ? '暂时无法发送，请稍候' : context.muted ? '当前直播间暂时无法发言' : 'Enter 发送弹幕'} maxLength={1000} disabled={!context || context.muted || Boolean(currentPending)} value={draft}
        onCompositionStart={() => { composingRef.current = true; }} onCompositionEnd={() => { composingRef.current = false; }} onChange={event => writeDraft(event.target.value)}
        onPaste={event => {
          const pasted = event.clipboardData.getData('text');
          if (!/[\r\n]/.test(pasted)) return;
          event.preventDefault();
          const input = event.currentTarget, start = input.selectionStart ?? draft.length, end = input.selectionEnd ?? start;
          const text = pasted.replace(/[\r\n]+/g, ' ');
          writeDraft(`${draft.slice(0, start)}${text}${draft.slice(end)}`.slice(0, 1000));
        }}
        onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !composingRef.current && event.keyCode !== 229) { event.preventDefault(); if (!event.repeat) send(); } }} />
      <DanmakuEmotePicker key={currentKey} context={context} open={showEmotes && active} onOpenChange={setShowEmotes}
        disabled={!context || Boolean(currentPending) || !active} blocked={!canSend} busy={loading} onRetry={refreshContext} onChoose={emote => {
          if (!canSend || emoticonUseRestriction(context, emote.unique, emote.kind)) return;
          if (emote.kind === 'text') { writeDraft(`${draft}${emote.text}`.slice(0, 500)); setShowEmotes(false); inputRef.current?.focus(); }
          else { setShowEmotes(false); send(emote.unique); }
        }} />
      {uncertain && currentPending && chat?.result ? <button className="mv-text-button mv-danmaku-compose-submit" disabled={currentFeedback?.kind === 'progress' || !active} onClick={queryResult}>确认发送结果</button> : <button className="mv-text-button mv-danmaku-compose-submit" disabled={!canSend || !draft.trim() || count > maxLength} onClick={() => send()} title={medalWritePending ? '请先在粉丝勋章中确认切换结果' : cooldown ? '发言间隔内，请稍后发送' : undefined}>{(currentPending || loading) && active ? <LoaderCircle size={13} className="mv-danmaku-spinner" /> : <Send size={13} />}{cooldown ? '稍后发送' : '发送'}</button>}
    </div>
    <div className="mv-danmaku-compose-meta" data-visible={Boolean(count || footerText || (!context && !loading && !currentPending))}>
      <small className={count > maxLength ? 'mv-danmaku-error' : ''} aria-live="off">{count ? `${count}/${maxLength}` : ''}</small>
      <ComposerFeedback key={`feedback:${operationKey}`} text={footerText} kind={footerKind} active={active} />
      {!context && !loading && !currentPending && <button className="mv-text-button" onClick={refreshContext}>重试</button>}
    </div>
  </div>;
}

function canDraftAccount(chat?: DanmakuChatAdapter): string {
  return chat?.available && chat.enabled && chat.accountUid && chat.authEpoch ? `${chat.accountUid}:${chat.authEpoch}` : '';
}
