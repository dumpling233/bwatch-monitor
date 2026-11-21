import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { useVirtualizer } from '@tanstack/react-virtual';
import { LockKeyhole, Smile, X } from 'lucide-react';
import { UiPopoverContent } from '../../ui';
import type { LocalChatContext, LocalChatEmoticon } from '../../../shared/localDanmaku';
import { DanmakuImage } from './DanmakuImage';
import { emotePreview } from './emotePreview';
import { EMOTE_GROUP_CELL_LIMIT, retainEmoteGroups } from './emoteGroupRetention';
import { chatEmoticonsByUnique, emoticonUseRestriction } from './emoticonUse';

type Group = { id: string; name: string; icon: string; items: LocalChatEmoticon[] };

function groupsFor(context: LocalChatContext): Group[] {
  const byId = chatEmoticonsByUnique(context);
  if (context.emoticonPackages?.length) return context.emoticonPackages.map(group => ({
    id: group.id, name: group.name, icon: group.icon,
    items: group.emoticonUniques.flatMap(id => { const item = byId.get(id); return item ? [item] : []; }),
  }));
  // Older helpers return a flat catalogue. Keep every entry and group it locally.
  const groups = new Map<string, Group>();
  for (const item of context.emoticons) {
    const id = item.packageId ?? item.packageName;
    if (!groups.has(id)) groups.set(id, { id, name: item.packageName || '直播表情', icon: item.url, items: [] });
    groups.get(id)!.items.push(item);
  }
  return [...groups.values()];
}

const EmoteGrid = React.memo(function EmoteGrid({ items, context, enabled, blocked, onChoose, onDescribe }: {
  context: LocalChatContext;
  items: LocalChatEmoticon[]; enabled: boolean; blocked: boolean;
  onChoose(item: LocalChatEmoticon): void; onDescribe(item: LocalChatEmoticon): void;
}) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const small = items.every(item => item.kind === 'text');
  const columns = small ? 5 : 4;
  const rowHeight = small ? 44 : 78;
  const virtualized = items.length > EMOTE_GROUP_CELL_LIMIT;
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: Math.ceil(items.length / columns), getScrollElement: () => element,
    estimateSize: () => rowHeight, overscan: 3, enabled: enabled && virtualized,
  });
  const renderItem = (item: LocalChatEmoticon) => {
    const restriction = emoticonUseRestriction(context, item.unique, item.kind);
    const hint = restriction || (item.kind === 'text' ? '点击插入输入框' : '点击立即发送');
    const preview = emotePreview(item.url, item.dynamic);
    return <button type="button" key={item.unique} disabled={blocked} aria-disabled={Boolean(restriction) || blocked}
      aria-label={`${item.text}，${hint}`} title={`${item.text} · ${hint}`} data-locked={Boolean(restriction)} data-kind={item.kind}
      onPointerEnter={() => onDescribe(item)} onFocus={() => onDescribe(item)}
      onClick={() => { onDescribe(item); if (!emoticonUseRestriction(context, item.unique, item.kind) && !blocked) onChoose(item); }}>
      <DanmakuImage {...preview} active={enabled} priority="picker" placeholder="skeleton" text={item.text} className="mv-danmaku-emote-preview" />
      {restriction && <><LockKeyhole className="mv-danmaku-emote-lock" size={11} aria-hidden="true" />
        <span className="mv-danmaku-emote-badge">{item.unlockLabel || '未解锁'}</span></>}
    </button>;
  };
  return <div ref={setElement} className="mv-danmaku-emote-scroll ui-inset-scroll" aria-label="表情列表" tabIndex={0}>
    {virtualized ? <div className="ui-inset-scroll-content" style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
      {virtualizer.getVirtualItems().map(row => <div key={row.key} className="mv-danmaku-emote-grid" data-small={small}
        style={{ position: 'absolute', top: row.start, height: row.size, width: '100%', gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
        {items.slice(row.index * columns, (row.index + 1) * columns).map(renderItem)}
      </div>)}
    </div> : <div className="mv-danmaku-emote-grid ui-inset-scroll-content" data-small={small}
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gridAutoRows: rowHeight - 4 }}>
      {items.map(renderItem)}
    </div>}
  </div>;
});

/** Mounted only for one open picker and one room/account/epoch. Hidden ordinary
 * groups keep their img nodes; visiting a group never preloads unvisited ones. */
function RetainedEmoteGroups({ groups, context, current, blocked, onChoose, onDescribe }: {
  context: LocalChatContext;
  groups: Group[]; current: string; blocked: boolean;
  onChoose(item: LocalChatEmoticon): void; onDescribe(item: LocalChatEmoticon): void;
}) {
  const [visited, setVisited] = useState<string[]>([]);
  const retained = useMemo(() => retainEmoteGroups(visited, groups.map(group => ({ id: group.id, count: group.items.length })), current), [visited, groups, current]);
  useEffect(() => {
    setVisited(previous => previous.length === retained.length && previous.every((id, index) => id === retained[index]) ? previous : retained);
  }, [retained]);
  return <>{retained.map(id => {
    const group = groups.find(item => item.id === id)!;
    return <div key={id} className="mv-danmaku-emote-group ui-inset-scroll-frame" role="tabpanel" aria-label={group.name} hidden={id !== current}>
      <div className="mv-danmaku-emote-group-title">{group.name}<small>{group.items.length} 个</small></div>
      {group.items.length ? <EmoteGrid items={group.items} context={context} enabled={id === current} blocked={blocked} onChoose={onChoose} onDescribe={onDescribe} /> : <p className="mv-danmaku-emote-empty">当前分组暂无表情</p>}
    </div>;
  })}</>;
}

/** A catalogue is loaded by the composer on demand; the picker never polls or sends on open. */
export function DanmakuEmotePicker({ context, open, onOpenChange, disabled, blocked, busy, onChoose, onRetry }: {
  context: LocalChatContext | null; open: boolean; onOpenChange(open: boolean): void;
  disabled: boolean; blocked: boolean; busy: boolean; onChoose(item: LocalChatEmoticon): void; onRetry(): void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const [container, setContainer] = useState<Element | undefined>(undefined);
  const [selected, setSelected] = useState({ scope: '', id: '' });
  const [described, setDescribed] = useState<LocalChatEmoticon | null>(null);
  const [visibleTabs, setVisibleTabs] = useState<Set<string>>(new Set());
  const groups = useMemo(() => context ? groupsFor(context) : [], [context]);
  const scope = context ? `${context.roomId}:${context.accountUid}:${context.authEpoch}` : '';
  const group = groups.find(item => selected.scope === scope && item.id === selected.id) ?? groups[0];
  const describedItem = described && context ? chatEmoticonsByUnique(context).get(described.unique) : undefined;
  const describedRestriction = describedItem ? emoticonUseRestriction(context, describedItem.unique, describedItem.kind) : undefined;
  const changeGroup = (id: string) => { setSelected({ scope, id }); setDescribed(null); };
  useEffect(() => {
    if (!open) return;
    const close = () => onOpenChange(false);
    const hide = () => { if (document.hidden) close(); };
    document.addEventListener('visibilitychange', hide);
    document.addEventListener('fullscreenchange', close);
    return () => { document.removeEventListener('visibilitychange', hide); document.removeEventListener('fullscreenchange', close); };
  }, [open, onOpenChange]);
  useEffect(() => {
    if (!open || !tabsRef.current) { setVisibleTabs(new Set()); return; }
    const visible = new Set<string>();
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.emoteTab!;
        if (entry.isIntersecting) visible.add(id); else visible.delete(id);
      }
      setVisibleTabs(new Set(visible));
    }, { root: tabsRef.current });
    for (const item of tabsRef.current.querySelectorAll('[data-emote-tab]')) observer.observe(item);
    return () => observer.disconnect();
  }, [open, groups]);
  return <Popover.Root open={open && !disabled} onOpenChange={value => {
    if (value) { setContainer(document.fullscreenElement ?? triggerRef.current?.closest('.mv-shell') ?? undefined); setDescribed(null); }
    onOpenChange(value);
  }}>
    <Popover.Trigger asChild><button ref={triggerRef} type="button" className="mv-icon-button" aria-label="直播间表情" disabled={disabled}><Smile size={16} /></button></Popover.Trigger>
    <Popover.Portal container={container}><UiPopoverContent returnFocusRef={triggerRef} className="mv-danmaku-emotes" side="top" align="start" sideOffset={8} collisionPadding={10} aria-label="直播间表情选择" inert={!open} aria-hidden={!open || undefined}
      onEscapeKeyDown={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}>
      <header><strong>直播表情</strong><Popover.Close asChild><button type="button" className="mv-icon-button" aria-label="关闭表情"><X size={14} /></button></Popover.Close></header>
      {context?.emoticonsAvailable === false ? <div className="mv-danmaku-emote-empty">表情暂时无法获取<button type="button" disabled={busy} className="mv-text-button" onClick={onRetry}>{busy ? '正在获取…' : '重试'}</button></div> : <>
        <div ref={tabsRef} className="mv-danmaku-emote-tabs" role="tablist" aria-label="表情分组">
          {groups.map((item, index) => <button type="button" role="tab" key={item.id} data-emote-tab={item.id} aria-label={item.name} title={item.name}
            aria-selected={item.id === group?.id} tabIndex={item.id === group?.id ? 0 : -1}
            onClick={() => changeGroup(item.id)} onKeyDown={event => {
              const next = event.key === 'ArrowRight' ? (index + 1) % groups.length : event.key === 'ArrowLeft' ? (index + groups.length - 1) % groups.length : event.key === 'Home' ? 0 : event.key === 'End' ? groups.length - 1 : -1;
              if (next < 0) return;
              event.preventDefault(); event.stopPropagation(); changeGroup(groups[next].id);
              const target = tabsRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next];
              target?.focus({ preventScroll: true }); target?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            }}>
            {open && visibleTabs.has(item.id) && <DanmakuImage {...emotePreview(item.icon)} priority="picker" placeholder="skeleton" text={item.name} className="mv-danmaku-emote-tab-image" />}
            <span>{item.name}</span>
          </button>)}
        </div>
        {context && group && open && !disabled && <RetainedEmoteGroups key={scope} groups={groups} context={context} current={group.id} blocked={blocked} onChoose={onChoose} onDescribe={setDescribed} />}
        {!groups.length && <p className="mv-danmaku-emote-empty">当前暂无表情</p>}
      </>}
      <div className="mv-danmaku-emote-detail" aria-live="polite">{describedItem ? <><strong>{describedItem.text}</strong><span>{describedRestriction || (describedItem.kind === 'text' ? '点击插入输入框，随文字发送' : '点击立即发送此表情')}</span></> : '小表情插入输入框，大表情点击立即发送'}{context?.emoticonsTruncated && <span>表情较多，当前目录仅展示部分内容</span>}</div>
      {(context?.emoticonPermissionsVerified === false || describedRestriction) && <div className="mv-danmaku-emote-permissions"><span>{context?.emoticonPermissionsVerified === false ? '使用条件以发送时为准' : null}</span><button type="button" className="mv-text-button" disabled={busy} onClick={onRetry}>{busy ? '正在更新…' : '更新表情权限'}</button></div>}
    </UiPopoverContent></Popover.Portal>
  </Popover.Root>;
}
