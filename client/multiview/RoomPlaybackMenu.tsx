import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PlaybackInfo, PlaybackSource } from '../../shared/playback';
import { PlaybackQualityMenu } from './PlaybackQualityMenu';
import { PlaybackMetadataController, type PlaybackMetadataSnapshot } from './playbackMetadata';
import { buildPlaybackOptions, playbackQualityLabel } from './playbackOptions';
import { playbackCdnKey, type PlaybackOptionsState, type PlayerStatus } from './playbackSession';
import type { PlaybackRequestPool } from './playbackRequestPool';

export interface RoomPlaybackMenuProps {
  roomId: string;
  source: 'custom';
  name: string;
  identityScope: string;
  rpcScope: string;
  anonymous: boolean;
  pool: PlaybackRequestPool;
  mediaInfo?: PlaybackInfo;
  /** Identity that resolved mediaInfo, independent from today's authorized account. */
  mediaInfoIdentityScope?: string;
  currentMediaIdentityScope: string;
  actualSource?: PlaybackSource;
  pendingSource?: PlaybackSource | null;
  mediaOptionsState?: PlaybackOptionsState;
  status: PlayerStatus;
  quality: number;
  preferredRoute: string;
  audioOnly: boolean;
  visible: boolean;
  supportsSource(source: Pick<PlaybackSource, 'protocol' | 'format'>): boolean;
  onQualityChange(quality: number): void;
  onRouteChange(key: string, info: PlaybackInfo): void;
}

/** A stable room owns menu work independently of the video and its recovery timers. */
export function RoomPlaybackMenu(props: RoomPlaybackMenuProps) {
  const latest = useRef(props); latest.current = props;
  const [snapshot, setSnapshot] = useState<PlaybackMetadataSnapshot>({ state: 'idle', stale: true, invalidated: false });
  const [open, setOpen] = useState(false);
  const [environment, setEnvironment] = useState(() => ({ visible: !document.hidden, online: navigator.onLine }));
  const [selectingRoute, setSelectingRoute] = useState(false);
  const [selectionNotice, setSelectionNotice] = useState('');
  const [routeInfo, setRouteInfo] = useState<PlaybackInfo>();
  const selectionId = useRef(0);
  const observed = useRef<{ info: PlaybackInfo; identityScope?: string; currentScope: string } | undefined>(undefined);
  const initialized = useRef<PlaybackMetadataController | undefined>(undefined);
  const controller = useMemo(() => new PlaybackMetadataController({
    roomId: props.roomId,
    resolve: (qn, signal, lifecycle) => {
      const current = latest.current;
      return current.pool.resolve({ roomId: current.roomId, source: current.source, qn, force: false, signal, ...lifecycle }, current.rpcScope, 'metadata');
    },
    onChange: setSnapshot,
  }), [props.roomId, props.identityScope, props.pool]);
  const currentMedia = Boolean(props.actualSource && ['playing', 'stalled'].includes(props.status));
  const actualQuality = props.actualSource?.actualQuality;
  const routeQuality = actualQuality ?? (props.quality || 250);
  // Ordinary playback supplies the descriptive directory. A closed menu must not
  // start metadata work for every healthy player on focus or identity renewal.
  const needed = open || selectingRoute;
  const context = { identityScope: props.identityScope, rpcScope: props.rpcScope, quality: routeQuality,
    needed, visible: props.visible && environment.visible, online: environment.online, menuOpen: open };
  const contextRef = useRef(context); contextRef.current = context;

  useLayoutEffect(() => {
    // Seed from media before enabling automatic work, avoiding a duplicate startup request.
    if (initialized.current !== controller) {
      initialized.current = controller; observed.current = undefined;
      controller.setContext({ ...contextRef.current, needed: false });
      setSnapshot(controller.getSnapshot());
    }
    if (props.mediaInfo && (observed.current?.info !== props.mediaInfo
      || observed.current.identityScope !== props.mediaInfoIdentityScope
      || observed.current.currentScope !== props.currentMediaIdentityScope)) {
      observed.current = { info: props.mediaInfo, identityScope: props.mediaInfoIdentityScope, currentScope: props.currentMediaIdentityScope };
      if (props.mediaInfoIdentityScope && props.mediaInfoIdentityScope === props.currentMediaIdentityScope)
        controller.observe(props.mediaInfo, props.rpcScope);
      else controller.observeDescription(props.mediaInfo);
    }
    controller.setContext(contextRef.current);
  }, [controller, props.mediaInfo, props.mediaInfoIdentityScope, props.currentMediaIdentityScope,
    props.rpcScope, routeQuality, needed, open, props.visible, environment]);

  // Invalidate old route continuations during commit, before a settled promise
  // can run between layout and passive cleanup after an identity replacement.
  useLayoutEffect(() => () => { ++selectionId.current; controller.dispose(); }, [controller]);

  useEffect(() => {
    const update = () => {
      const next = { visible: !document.hidden, online: navigator.onLine };
      if (!next.visible || !next.online) { ++selectionId.current; setSelectingRoute(false); }
      setEnvironment(previous => previous.visible === next.visible && previous.online === next.online ? previous : next);
      controller.setContext({ ...contextRef.current, visible: latest.current.visible && next.visible, online: next.online });
    };
    const leave = () => {
      ++selectionId.current;
      setSelectingRoute(false);
      controller.setContext({ ...contextRef.current, visible: false });
      setEnvironment(value => ({ ...value, visible: false }));
    };
    window.addEventListener('focus', update); window.addEventListener('online', update); window.addEventListener('offline', update);
    window.addEventListener('pageshow', update); window.addEventListener('pagehide', leave);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.removeEventListener('focus', update); window.removeEventListener('online', update); window.removeEventListener('offline', update);
      window.removeEventListener('pageshow', update); window.removeEventListener('pagehide', leave);
      document.removeEventListener('visibilitychange', update);
    };
  }, [controller]);

  useEffect(() => {
    ++selectionId.current; setSelectingRoute(false); setSelectionNotice(''); setRouteInfo(undefined);
  }, [props.rpcScope, routeQuality, snapshot.invalidated]);
  const info = snapshot.invalidated ? undefined : snapshot.info ?? props.mediaInfo;
  const supports = useMemo(() => (source: Pick<PlaybackSource, 'protocol' | 'format'>) =>
    (!props.audioOnly || source.protocol === 'flv') && props.supportsSource(source), [props.audioOnly, props.supportsSource]);
  const options = useMemo(() => buildPlaybackOptions(info, props.audioOnly ? 'flv' : 'auto', supports), [info, props.audioOnly, supports]);
  const routeSnapshot = snapshot.invalidated ? undefined : routeInfo ?? info;
  // Keep the last description visible; selecting a stale entry always ensures a new address first.
  const routeOptions = useMemo(() => {
    const routeDirectory = routeSnapshot === info ? options : buildPlaybackOptions(routeSnapshot, props.audioOnly ? 'flv' : 'auto', supports);
    const routes = routeDirectory.sources.filter(source => source.actualQuality === routeQuality);
    return [...new Map(routes.map(source => [playbackCdnKey(source), source])).entries()];
  }, [routeSnapshot, info, options, props.audioOnly, supports, routeQuality]);
  const currentRoute = props.actualSource ? routeOptions.findIndex(([key]) => key === playbackCdnKey(props.actualSource!)) : -1;
  // A closed menu still renders its trigger. Reuse snapshot-derived labels and
  // compatibility results when another room, playback status or account notice changes.
  const qualityLabel = useMemo(() => {
    const labels = new Map<number, string>();
    return (qn: number) => {
      let label = labels.get(qn);
      if (label === undefined) { label = playbackQualityLabel(qn, info); labels.set(qn, label); }
      return label;
    };
  }, [info]);
  const qualityMenuOptions = useMemo(() => options.qualities.length ? [{ value: '0', label: '默认（推荐）' },
    ...options.qualities.map(option => ({ value: String(option.qn), label: qualityLabel(option.qn) }))] : [], [options.qualities, qualityLabel]);
  const routeMenuOptions = useMemo(() => [{ value: '', label: '自动（推荐）' },
    ...routeOptions.map(([key], index) => ({ value: key, label: `线路 ${index + 1}` }))], [routeOptions]);
  const actualLabel = actualQuality ? qualityLabel(actualQuality) : '';
  const qualityLoading = props.mediaOptionsState?.state === 'loading'
    && ['initial', 'quality', 'manual'].includes(props.mediaOptionsState.reason ?? '');
  const loadingQuality = props.mediaOptionsState?.qn ?? (props.quality || 250);
  const mismatch = actualQuality !== undefined && actualQuality !== (props.quality || 250);
  const unavailable = Boolean(props.quality && info && !options.qualities.some(item => item.qn === props.quality));
  const notice = selectionNotice || (selectingRoute ? '正在切换线路…' : qualityLoading
    ? `正在获取${qualityLabel(loadingQuality)}…` : props.pendingSource
    ? `正在连接${qualityLabel(props.pendingSource.actualQuality)}…`
    : ['error', 'cooldown'].includes(snapshot.state) ? snapshot.message
    : props.quality && mismatch && currentMedia ? `${qualityLabel(props.quality)}暂不可用，正在播放${actualLabel}`
    : props.preferredRoute && currentMedia && props.preferredRoute !== playbackCdnKey(props.actualSource!) ? '所选线路暂不可用，已自动换线'
    : unavailable ? `${qualityLabel(props.quality)}暂不可用，已保留选择` : '');

  const selectRoute = async (key: string) => {
    const operation = ++selectionId.current;
    const identity = props.identityScope, rpc = props.rpcScope;
    setSelectingRoute(true); setSelectionNotice('');
    try {
      const fresh = await controller.ensureRoutes(routeQuality);
      if (operation !== selectionId.current || document.hidden || navigator.onLine === false || !latest.current.visible
        || latest.current.identityScope !== identity || latest.current.rpcScope !== rpc
        || (latest.current.actualSource?.actualQuality ?? (latest.current.quality || 250)) !== routeQuality) return;
      setRouteInfo(fresh);
      if (key && !fresh.sources.some(source => source.actualQuality === routeQuality && supports(source) && playbackCdnKey(source) === key)) {
        setSelectionNotice('该线路暂不可用，继续使用当前线路'); return;
      }
      latest.current.onRouteChange(key, fresh);
    } catch (error) {
      if (operation === selectionId.current && (error as Error)?.name !== 'AbortError') setSelectionNotice('暂时无法切换线路，继续使用当前线路');
    } finally { if (operation === selectionId.current) setSelectingRoute(false); }
  };

  return <PlaybackQualityMenu name={props.name}
    quality={String(props.quality === 0 ? 0 : currentMedia ? actualQuality : props.quality)}
    triggerLabel={props.pendingSource || qualityLoading ? props.actualSource ? '切换中…' : '加载中…' : actualQuality ? `${currentMedia ? '' : '上次 '}${actualLabel}` : '清晰度'}
    notice={notice} emptyMessage={snapshot.state === 'error' || snapshot.state === 'cooldown' ? snapshot.message
      : info?.status === 'offline' ? '直播间未开播' : info?.status === 'restricted' ? '本次取源受限' : '正在获取可用清晰度…'}
    optionsLoading={snapshot.state === 'loading'} routesLoading={selectingRoute}
    onOpenChange={setOpen}
    qualityOptions={qualityMenuOptions}
    onQualityChange={value => { ++selectionId.current; setSelectingRoute(false); setSelectionNotice(''); props.onQualityChange(Number(value)); }}
    currentRouteLabel={currentMedia ? currentRoute >= 0 ? `线路 ${currentRoute + 1}` : '当前线路' : '自动线路'}
    route={props.preferredRoute && currentMedia ? playbackCdnKey(props.actualSource!) : props.preferredRoute}
    routeDisabled={snapshot.invalidated || qualityLoading || Boolean(props.pendingSource) || selectingRoute} onRouteChange={key => void selectRoute(key)}
    routeOptions={routeMenuOptions} />;
}
