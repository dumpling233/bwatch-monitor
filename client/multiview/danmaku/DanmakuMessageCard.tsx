import React, { memo, useEffect, useState, type CSSProperties } from 'react';
import { Anchor, ShieldCheck, UserRound } from 'lucide-react';
import type { LocalPublicProfile } from '../../../shared/localDanmaku';
import type { DanmakuChatAdapter } from './DanmakuComposer';
import type { DanmakuMessage } from './types';
import { DanmakuImage } from './DanmakuImage';
import { danmakuAssetUrl } from './normalize';
import { avatarPreview } from './avatarPreview';
import { emotePreview } from './emotePreview';
import { resolveSuperChatColors, superChatTextColor, superChatTier } from './superChatColors';
import { isOwnDanmaku } from './selfIdentity';
import { DanmakuRepeatPopover } from './DanmakuRepeatPopover';
import { DanmakuMedalBadge } from './DanmakuMedalBadge';
import type { DanmakuRepeatSender, DanmakuRepeatState } from './repeatMessage';

const timeFormatter = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const guardNames = { 1: '总督', 2: '提督', 3: '舰长' } as const;

/** Only genuinely visible rows request assets; transient failure stays recoverable. */
export const DanmakuMessageCard = memo(function DanmakuMessageCard({ message, chat, hydrate = true, repeatState, onRepeat, onRepeatOpen }: {
  message: DanmakuMessage; chat?: DanmakuChatAdapter; hydrate?: boolean; repeatState?: DanmakuRepeatState | null; onRepeat?: DanmakuRepeatSender; onRepeatOpen?: () => void;
}) {
  const [profile, setProfile] = useState<{ scope: string; value: LocalPublicProfile } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [sourceFailed, setSourceFailed] = useState(false);
  const [foreground, setForeground] = useState(() => typeof document === 'undefined' || !document.hidden);
  const [recovery, setRecovery] = useState(0);
  const [failedPreview, setFailedPreview] = useState<string | null>(null);
  const privateIdentity = message.userIdentity === 'masked' || message.isMystery;
  const uid = privateIdentity ? undefined : message.userId;
  const profileScope = `${uid ?? ''}:${chat?.accountUid ?? ''}:${chat?.authEpoch ?? ''}`;
  const currentProfile = profile?.scope === profileScope && profile.value.uid === uid ? profile.value : null;
  const sourceAvatar = privateIdentity ? undefined : danmakuAssetUrl(message.avatarUrl);
  const active = hydrate && foreground;
  const resolvedAvatar = privateIdentity ? undefined : !sourceFailed && sourceAvatar ? sourceAvatar : currentProfile?.face;
  const originalAvatar = hydrate ? resolvedAvatar : undefined;
  const preview = avatarPreview(originalAvatar);
  const displayAvatar = failedPreview === preview ? originalAvatar : preview;
  useEffect(() => {
    const sync = () => setForeground(!document.hidden);
    const online = () => setRecovery(value => value + 1);
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('online', online);
    return () => { document.removeEventListener('visibilitychange', sync); window.removeEventListener('online', online); };
  }, []);
  useEffect(() => { setSourceFailed(false); }, [uid, sourceAvatar, chat?.authEpoch, chat?.accountUid]);
  useEffect(() => { setFailedPreview(null); }, [uid, resolvedAvatar, chat?.authEpoch, chat?.accountUid]);
  useEffect(() => {
    setExpanded(false);
    // A hidden tab pauses new work; it does not invalidate public profile data
    // or turn an already displayed image back into an empty placeholder.
    if (!active) return;
    setProfile(previous => previous?.scope === profileScope ? previous : null);
    if (!uid || (sourceAvatar && !sourceFailed) || !chat?.profile) return;
    const controller = new AbortController();
    void chat.profile(uid, controller.signal).then(value => { if (!controller.signal.aborted && value?.uid === uid) setProfile({ scope: profileScope, value }); }).catch(() => {});
    return () => controller.abort();
  }, [uid, sourceAvatar, sourceFailed, chat?.profile, active, recovery, profileScope, chat?.authEpoch, chat?.accountUid]);
  const isSc = message.kind === 'sc';
  const palette = isSc ? resolveSuperChatColors(message.price, message.scColors) : undefined;
  const colors = palette ? { '--sc-header': palette.background, '--sc-body': palette.body, '--sc-price': palette.price,
    '--sc-header-text': superChatTextColor(palette.background), '--sc-body-text': superChatTextColor(palette.body), '--sc-price-text': superChatTextColor(palette.price) } as CSSProperties : undefined;
  const source = [message.sourceTime, message.receivedAt].find(time => Number.isFinite(time) && time > 0 && time < 8.64e15) ?? Date.now();
  const date = new Date(source);
  const formattedTime = timeFormatter.format(date);
  const currentRole = !privateIdentity && message.roleRoomId === message.roomId;
  const guard = currentRole && message.guardLevel ? message.guardLevel : undefined;
  const self = isOwnDanmaku(message, chat?.accountUid);
  const medal = !privateIdentity ? message.medal : undefined;
  const title = [uid ? `UID ${uid}` : privateIdentity ? '隐私身份，无法查看公开资料' : '身份信息未提供', formattedTime,
    message.sourceRoomId && message.sourceRoomId !== message.roomId ? `来自房间 ${message.sourceRoomId}；身份属于来源房间` : ''].filter(Boolean).join(' · ');
  return <article className={`mv-danmaku-message mv-danmaku-rich-message${isSc ? ' mv-danmaku-superchat' : ''}${self ? ' mv-danmaku-self' : ''}${!isSc && onRepeat ? ' mv-danmaku-repeatable' : ''}`} style={colors} data-sc-tier={isSc ? superChatTier(message.price) : undefined}>
    <header className="mv-danmaku-message-meta">
      <button className={`mv-danmaku-avatar${guard ? ` mv-danmaku-avatar-guard-${guard}` : ''}`} title={title} aria-label={`查看${message.userName}资料`} disabled={!uid} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
        <DanmakuImage url={displayAvatar} active={active} dynamic={displayAvatar === originalAvatar && /\.(?:gif|apng|webp)(?:\?|$)/i.test(displayAvatar ?? '')} text="" priority="avatar" className="mv-danmaku-avatar-image" width={32} height={32}
          onError={failed => {
            // A CDN transform failure does not invalidate the original profile.
            // Try that direct CDN URL once; all further network retry/backoff is
            // owned by DanmakuImage, never by a per-message profile polling loop.
            if (failed === preview && preview !== originalAvatar) { setFailedPreview(preview); return; }
            if (uid && originalAvatar) chat?.rejectAvatar?.(uid, originalAvatar);
            if (originalAvatar === sourceAvatar && !sourceFailed && uid && chat?.profile) setSourceFailed(true);
          }} onLoad={face => { if (uid && originalAvatar && (face === preview || face === originalAvatar)) chat?.rememberAvatar?.(uid, originalAvatar); }} />
        <UserRound className="mv-danmaku-avatar-placeholder" size={17} />
      </button>
      <div className="mv-danmaku-author"><div className="mv-danmaku-author-line">
        {medal && <DanmakuMedalBadge medal={medal} title={`${medal.name} ${medal.level}级${medal.targetRoomId ? ` · 房间 ${medal.targetRoomId}` : ''}${medal.guardLevel ? ` · 该勋章关联${guardNames[medal.guardLevel]}` : ''}`} />}
        {currentRole && message.isModerator === true && <span className="mv-danmaku-role mv-danmaku-moderator" title="当前直播间房管"><ShieldCheck size={11} />房管</span>}
        {currentRole && message.isAnchor === true && <span className="mv-danmaku-role mv-danmaku-anchor" title="当前直播间主播"><Anchor size={11} />主播</span>}
        {guard && <span className={`mv-danmaku-role mv-danmaku-guard-${guard}`} title={`当前直播间${guardNames[guard]}`}><Anchor size={11} />{guardNames[guard]}</span>}
        {self && <span className="mv-danmaku-role mv-danmaku-self-label">我</span>}
        <button className="mv-danmaku-name" disabled={!uid} title={title} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{message.userName || '匿名用户'}</button>
      </div></div>
      {isSc && uid && <span className="mv-danmaku-identity">UID {uid}</span>}
      <div className="mv-danmaku-message-details">{isSc && <b>¥{message.price ?? 0}</b>}
        <time className="mv-danmaku-message-time" dateTime={date.toISOString()}>{formattedTime}</time>
      </div>
    </header>
    <div className="mv-danmaku-message-content">
      <p>{message.segments?.length ? message.segments.map((part, index) => part.type === 'emote' ? <DanmakuImage key={index} {...emotePreview(hydrate ? part.url : undefined, part.dynamic, true)} active={active} text={part.text} priority="content" placeholder="skeleton" className={`mv-danmaku-inline-emote${part.emoteSize === 'small' ? ' mv-danmaku-inline-emote-small' : ''}`} width={part.emoteSize === 'small' ? 24 : part.width} height={part.emoteSize === 'small' ? 24 : part.height} /> : <span key={index}>{part.text}</span>) : message.text}</p>
      {!isSc && onRepeat && <DanmakuRepeatPopover message={message} chat={chat} state={repeatState} onRepeat={onRepeat} onOpen={onRepeatOpen} active={active} />}
    </div>
    {expanded && uid && <div className="mv-danmaku-profile"><strong>{message.userName}</strong><span>UID {uid}{currentProfile?.level !== undefined ? ` · 等级 ${currentProfile.level}` : ''}</span>
      {currentProfile?.sign && <span>{currentProfile.sign}</span>}
      {message.sourceRoomId && message.sourceRoomId !== message.roomId && <span>来源房间 {message.sourceRoomId}，徽章不代表本房间身份</span>}
    </div>}
  </article>;
});
