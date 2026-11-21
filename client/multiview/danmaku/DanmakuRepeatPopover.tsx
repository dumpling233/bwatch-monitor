import React, { useEffect, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Send, X } from 'lucide-react';
import { ActionButton, UiPopoverContent } from '../../ui';
import type { DanmakuChatAdapter } from './DanmakuComposer';
import type { DanmakuMessage } from './types';
import { DanmakuImage } from './DanmakuImage';
import { emotePreview } from './emotePreview';
import { repeatContentRestriction, repeatMessageContent, type DanmakuRepeatSender, type DanmakuRepeatState } from './repeatMessage';

/** One visible row owns its non-modal confirmation; unmounting the row also removes its portal. */
export function DanmakuRepeatPopover({ message, chat, state, onRepeat, onOpen, active }: {
  message: DanmakuMessage; chat?: DanmakuChatAdapter; state?: DanmakuRepeatState | null; onRepeat: DanmakuRepeatSender; onOpen?: () => void; active: boolean;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [container, setContainer] = useState<Element | undefined>();
  const candidate = repeatMessageContent(message);
  const loggedIn = Boolean(chat?.enabled && chat.available && chat.accountUid && chat.authEpoch);
  const sameContext = Boolean(loggedIn && state?.roomId === message.roomId && state.accountUid === chat?.accountUid &&
    state.authEpoch === chat?.authEpoch && state.sessionScope === chat?.sessionScope && state.context?.roomId === message.roomId &&
    state.context.accountUid === chat?.accountUid && state.context.authEpoch === chat?.authEpoch);
  const needsLogin = !loggedIn && !candidate.content?.emoticonUnique && Boolean(chat?.enable || chat?.openSetup);
  const reason = candidate.reason || (!loggedIn ? '连接 B站账号后可发送' : !sameContext ? '暂无法确认当前直播间的发言权限'
    : candidate.content ? repeatContentRestriction(candidate.content, state?.context ?? null) : '这条弹幕暂不支持复读') ||
    (!state?.ready ? '暂时无法发送，请稍后重试' : undefined);
  const canOpen = active && Boolean(candidate.content) && (needsLogin || !reason);
  useEffect(() => { setOpen(false); }, [message.id, message.roomId, chat?.enabled, chat?.available, chat?.accountUid, chat?.authEpoch, chat?.sessionScope, active, canOpen]);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const visibility = () => { if (document.hidden) close(); };
    document.addEventListener('visibilitychange', visibility);
    document.addEventListener('fullscreenchange', close);
    return () => { document.removeEventListener('visibilitychange', visibility); document.removeEventListener('fullscreenchange', close); };
  }, [open]);
  return <Popover.Root modal={false} open={open && canOpen} onOpenChange={value => {
    if (value && !canOpen) return;
    if (value) {
      // Stop follow before Radix moves focus or the next receive batch paints.
      // Closing the preview never changes the user's retained reading intent.
      onOpen?.();
      setContainer(document.fullscreenElement ?? triggerRef.current?.closest('.mv-shell') ?? undefined);
    }
    setOpen(value);
  }}>
    <span className="mv-danmaku-repeat-anchor" title={reason || '复读这条弹幕'}>
      <Popover.Trigger asChild><button ref={triggerRef} type="button" className="mv-danmaku-repeat-button" disabled={!canOpen}
        aria-label={`复读这条弹幕${reason && !needsLogin ? `：${reason}` : ''}`} data-testid="danmaku-repeat-button">+1</button></Popover.Trigger>
    </span>
    <Popover.Portal container={container}><UiPopoverContent returnFocusRef={triggerRef} className="mv-danmaku-repeat-popover" side="top" align="end" sideOffset={6} collisionPadding={10}
      aria-label="复读弹幕" onEscapeKeyDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}>
      <header><strong>复读这条弹幕</strong><Popover.Close asChild><button type="button" className="mv-icon-button" aria-label="关闭复读预览"><X size={14} /></button></Popover.Close></header>
      <div className="mv-danmaku-repeat-preview ui-inset-scroll-frame">
        <div className="ui-inset-scroll" tabIndex={0}><p className="ui-inset-scroll-content">{message.segments?.length ? message.segments.map((part, index) => part.type === 'emote'
        ? <DanmakuImage key={index} {...emotePreview(part.url, part.dynamic, true)} active={active && open} text={part.text} priority="content" placeholder="skeleton"
          className={`mv-danmaku-inline-emote${part.emoteSize === 'small' ? ' mv-danmaku-inline-emote-small' : ''}`} width={part.emoteSize === 'small' ? 24 : part.width} height={part.emoteSize === 'small' ? 24 : part.height} />
        : <span key={index}>{part.text}</span>) : message.text}</p></div>
      </div>
      <div className="mv-danmaku-repeat-actions"><span>{needsLogin ? '连接账号后可发言' : '发送到当前直播间'}</span>
        {needsLogin ? <ActionButton onClick={() => { setOpen(false); (chat?.enable ?? chat?.openSetup)?.(); }}>连接 B站账号</ActionButton>
          : <ActionButton onClick={() => { if (canOpen && candidate.content && onRepeat(candidate.content, message.roomId)) setOpen(false); }}><Send size={12} />确认发送</ActionButton>}
      </div>
    </UiPopoverContent></Popover.Portal>
  </Popover.Root>;
}
