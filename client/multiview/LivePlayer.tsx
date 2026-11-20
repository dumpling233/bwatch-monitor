import React, { useEffect, useLayoutEffect, useRef } from 'react';
import type { PlaybackFormatPreference, PlaybackInfo, PlaybackMediaMode, PlaybackSource } from '../../shared/playback';
import { connectPlaybackSource, orderPlaybackSources, supportsPlaybackSource, type PlaybackMode } from './playbackAdapters';
import { createPlaybackSession, createPlaybackRecoveryState, type PlaybackOptionsState, type PlaybackSession, type PlayerStatus } from './playbackSession';
import type { LocalPlaybackResolver } from './localLoginProvider';
import type { LocalAudioPlaybackResolver } from './localAudioProvider';
import { preparePlaybackAudio, releasePlaybackAudioBalance, setPlaybackAudioBalance } from './playbackAudioBalance';

export type { PlayerStatus } from './playbackSession';
export { playbackRouteKey, playbackCdnKey } from './playbackSession';
export interface LivePlayerProps {
  roomId: string;
  /** Catalog rooms use the visibility-scoped endpoint; custom rooms use the monitor-only endpoint. */
  source?: 'custom';
  resolvePlayback?: LocalPlaybackResolver;
  resolveAudioPlayback?: LocalAudioPlaybackResolver;
  audioCapabilityKey?: string;
  /** Public media may survive account authorization; personal media never survives identity loss. */
  authSessionKey?: string;
  requestedQuality: number;
  muted: boolean;
  volume: number;
  balance?: number;
  onBalanceUnavailable?: (unavailable: boolean) => void;
  paused: boolean;
  active: boolean;
  visible?: boolean;
  playbackMode?: PlaybackMode;
  mediaMode?: PlaybackMediaMode;
  preferredRoute?: string | null;
  preferredFormat?: PlaybackFormatPreference;
  autoReconnect?: boolean;
  refreshToken?: number;
  routeSelection?: { key: string | null; info: PlaybackInfo; token: number };
  onPlaybackInfo?: (info: PlaybackInfo, identityScope?: string) => void;
  onOptionsStateChange?: (state: PlaybackOptionsState) => void;
  onSourceChange?: (source: PlaybackSource | null, identityScope?: string) => void;
  onPendingSourceChange?: (source: PlaybackSource | null) => void;
  onCooldown?: (seconds: number) => void;
  onStatusChange?: (status: PlayerStatus, message?: string) => void;
  onAutoplayBlockedChange?: (resume: (() => void) | null) => void;
  onMediaModeRejected?: (mode: PlaybackMediaMode, message: string) => void;
  onAudioDeliveryChange?: (delivery: 'audio-only' | 'full-stream' | null) => void;
}

export function LivePlayer(props: LivePlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const callbacks = useRef(props);
  const sessionRef = useRef<PlaybackSession | null>(null);
  const pageHiddenRef = useRef(false);
  const recoveryRef = useRef({ roomId: props.roomId, authSessionKey: props.authSessionKey, state: createPlaybackRecoveryState() });
  const refreshRef = useRef(props.refreshToken);
  const modeRef = useRef(props.playbackMode);
  callbacks.current = props;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = Number.isFinite(props.volume) ? Math.min(1, Math.max(0, props.volume)) : 0;
    video.muted = props.muted;
  }, [props.volume, props.muted]);

  useEffect(() => {
    const video = videoRef.current;
    if (video) return () => releasePlaybackAudioBalance(video);
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (!props.active || props.paused) { releasePlaybackAudioBalance(video); return; }
    const watchBalance = () => setPlaybackAudioBalance(video, props.balance, props.onBalanceUnavailable
      ? unavailable => callbacks.current.onBalanceUnavailable?.(unavailable) : undefined);
    let unwatch = pageHiddenRef.current ? undefined : watchBalance();
    const hide = () => {
      unwatch?.();
      unwatch = undefined;
      releasePlaybackAudioBalance(video);
    };
    const show = (event: PageTransitionEvent) => { if (event.persisted && !unwatch) unwatch = watchBalance(); };
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', show);
    return () => {
      unwatch?.();
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', show);
    };
  }, [props.roomId, props.active, props.paused, props.balance, Boolean(props.onBalanceUnavailable)]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let disposed = false;
    let generation = 0;
    let session: PlaybackSession | null = null;
    const stop = () => {
      ++generation;
      const previous = session; session = null;
      if (sessionRef.current === previous) sessionRef.current = null;
      previous?.destroy();
      callbacks.current.onAutoplayBlockedChange?.(null);
      callbacks.current.onOptionsStateChange?.({ state: 'idle' });
      callbacks.current.onAudioDeliveryChange?.(null);
    };
    const start = () => {
      if (disposed || pageHiddenRef.current || session || !callbacks.current.active || callbacks.current.paused) return;
      const currentGeneration = ++generation;
      const current = () => !disposed && !pageHiddenRef.current && generation === currentGeneration
        && callbacks.current.roomId === props.roomId && callbacks.current.source === props.source
        && (recoveryRef.current.authSessionKey === callbacks.current.authSessionKey || (recoveryRef.current.authSessionKey ?? 'anonymous') === 'anonymous')
        && callbacks.current.active && !callbacks.current.paused;
      const sameRoom = recoveryRef.current.roomId === props.roomId && recoveryRef.current.authSessionKey === callbacks.current.authSessionKey;
      const initialReason = sameRoom && refreshRef.current !== callbacks.current.refreshToken ? 'manual' : 'initial';
      if (!sameRoom) recoveryRef.current = { roomId: props.roomId, authSessionKey: callbacks.current.authSessionKey, state: createPlaybackRecoveryState() };
      refreshRef.current = callbacks.current.refreshToken;
      modeRef.current = callbacks.current.playbackMode;
      session = createPlaybackSession({
        initialReason,
        audioCapabilityKey: callbacks.current.audioCapabilityKey,
        identityScope: callbacks.current.authSessionKey ?? 'anonymous',
        requestedQuality: callbacks.current.requestedQuality,
        preferredRoute: callbacks.current.preferredRoute,
        preferredFormat: callbacks.current.preferredFormat,
        mediaMode: callbacks.current.mediaMode,
        autoReconnect: callbacks.current.autoReconnect,
        recoveryState: recoveryRef.current.state,
        resolve: (signal, context) => {
          if (callbacks.current.resolvePlayback) return callbacks.current.resolvePlayback({ roomId: props.roomId,
            source: callbacks.current.source ?? 'custom', qn: context.qn, force: context.force, signal,
            onQueued: context.onQueued, onStarted: context.onStarted });
          return Promise.reject(new Error('请先安装并连接浏览器扩展'));
        },
        resolveAudioPlayback: (signal, context) => {
          if (!callbacks.current.resolveAudioPlayback) return Promise.reject(new Error('Pure audio is unavailable'));
          return callbacks.current.resolveAudioPlayback({ roomId: props.roomId, source: callbacks.current.source ?? 'custom',
            qn: 150, force: context.force, signal, onQueued: context.onQueued, onStarted: context.onStarted });
        },
        connect: (source, signal, events, mediaMode) => connectPlaybackSource(video, source, signal, events, callbacks.current.playbackMode,
          { framesExpected: () => callbacks.current.visible !== false, mediaMode }),
        orderSources: sources => orderPlaybackSources(video, sources),
        supportsSource: source => supportsPlaybackSource(video, source),
        isForeground: () => (typeof document === 'undefined' || !document.hidden) && callbacks.current.visible !== false,
        onInfo: (info, scope) => { if (current()) callbacks.current.onPlaybackInfo?.(info, scope); },
        onOptionsState: (state, message, context) => {
          if (current()) callbacks.current.onOptionsStateChange?.({ state, message, qn: context?.qn, reason: context?.reason });
        },
        onSource: (source, scope) => { if (current()) callbacks.current.onSourceChange?.(source, scope); },
        onSourceCleared: () => { if (current()) callbacks.current.onSourceChange?.(null); },
        onPendingSource: source => { if (current()) callbacks.current.onPendingSourceChange?.(source); },
        onCooldown: seconds => { if (current()) callbacks.current.onCooldown?.(seconds); },
        onStatus: (status, message) => { if (current()) callbacks.current.onStatusChange?.(status, message); },
        onAutoplayBlockedChange: resume => {
          if (current()) callbacks.current.onAutoplayBlockedChange?.(resume ? () => {
            if (!current()) return;
            if (callbacks.current.balance) preparePlaybackAudio();
            resume();
          } : null);
        },
        onMediaModeRejected: (mode, message) => { if (current()) callbacks.current.onMediaModeRejected?.(mode, message); },
        onAudioDeliveryChange: delivery => { if (current()) callbacks.current.onAudioDeliveryChange?.(delivery); },
      });
      sessionRef.current = session;
    };
    if (!props.active || props.paused) callbacks.current.onStatusChange?.('paused', props.paused ? '直播已暂停' : '画面已停止加载');
    const hide = () => { pageHiddenRef.current = true; stop(); };
    const show = (event: PageTransitionEvent) => { if (event.persisted) { pageHiddenRef.current = false; start(); } };
    const online = () => session?.networkRestored();
    start();
    window.addEventListener('online', online);
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', show);
    return () => {
      disposed = true; stop();
      window.removeEventListener('online', online);
      window.removeEventListener('pagehide', hide); window.removeEventListener('pageshow', show);
    };
  }, [props.roomId, props.source, props.active, props.paused]);

  useLayoutEffect(() => {
    // Change the provider for future requests without recreating a public media element.
    // This also cancels stale metadata and removes any previous account's signed media.
    recoveryRef.current.authSessionKey = props.authSessionKey;
    sessionRef.current?.setIdentityScope(props.authSessionKey ?? 'anonymous');
  }, [props.authSessionKey]);

  useEffect(() => { sessionRef.current?.updateQuality(props.requestedQuality); }, [props.requestedQuality]);
  useEffect(() => { sessionRef.current?.selectFormat(props.preferredFormat ?? 'auto', props.preferredRoute ?? null); }, [props.preferredFormat]);
  useEffect(() => {
    const selection = props.routeSelection;
    sessionRef.current?.selectRoute(props.preferredRoute ?? null,
      selection?.key === (props.preferredRoute ?? null) ? selection.info : undefined);
  }, [props.preferredRoute, props.routeSelection]);
  useEffect(() => { sessionRef.current?.setAutoReconnect(props.autoReconnect ?? true); }, [props.autoReconnect]);
  useEffect(() => { sessionRef.current?.setMediaMode(props.mediaMode ?? 'video'); }, [props.mediaMode]);
  useEffect(() => { sessionRef.current?.audioCapabilityAvailable(props.audioCapabilityKey); }, [props.audioCapabilityKey]);
  useEffect(() => { sessionRef.current?.checkHealth?.(true); }, [props.visible]);
  useEffect(() => {
    if (refreshRef.current !== props.refreshToken || modeRef.current !== props.playbackMode) sessionRef.current?.reconnect();
    refreshRef.current = props.refreshToken; modeRef.current = props.playbackMode;
  }, [props.refreshToken, props.playbackMode]);

  return <video ref={videoRef} className="mv-video-element" autoPlay playsInline muted={props.muted} crossOrigin="anonymous"
    aria-label={`直播画面 ${props.roomId}`} disablePictureInPicture={false} />;
}
