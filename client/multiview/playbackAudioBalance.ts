import { normalizeRoomAudioBalance } from './preferences';

type BalanceGraph = {
  source: MediaElementAudioSourceNode;
  stereo: GainNode;
  left: GainNode;
  right: GainNode;
  output: ChannelMergerNode;
  connected: boolean;
};

let context: AudioContext | undefined;
let hlsUsesMediaSource: Promise<boolean> | undefined;
const graphs = new WeakMap<HTMLMediaElement, BalanceGraph>();

function resumeAudio() {
  if (context && context.state !== 'running' && context.state !== 'closed') {
    void context.resume().catch(() => { /* A later user gesture can unlock the context. */ });
  }
}

function contextConstructor() {
  const runtime = globalThis as typeof globalThis & { webkitAudioContext?: typeof globalThis.AudioContext };
  return runtime.AudioContext ?? runtime.webkitAudioContext;
}

function sharedContext(): AudioContext | undefined {
  if (context) return context;
  const Context = contextConstructor();
  if (!Context || typeof window === 'undefined') return;
  let audio: AudioContext;
  try { audio = new Context(); } catch { return; }
  context = audio;
  const syncUnlockListeners = () => {
    if (audio.state === 'running' || audio.state === 'closed') {
      window.removeEventListener('click', resumeAudio, true);
      window.removeEventListener('keydown', resumeAudio, true);
    } else {
      window.addEventListener('click', resumeAudio, true);
      window.addEventListener('keydown', resumeAudio, true);
    }
  };
  audio.addEventListener('statechange', syncUnlockListeners);
  syncUnlockListeners();
  return audio;
}

/** Run inside the control's user gesture for browsers that gate Web Audio. */
export function preparePlaybackAudio() {
  if (sharedContext()) resumeAudio();
}

function createGraph(audio: AudioContext, video: HTMLMediaElement): BalanceGraph {
  const stereo = audio.createGain();
  // Upmix mono to both sides and use the standard speaker downmix for wider sources.
  stereo.channelCount = 2;
  stereo.channelCountMode = 'explicit';
  stereo.channelInterpretation = 'speakers';
  const split = audio.createChannelSplitter(2);
  const left = audio.createGain();
  const right = audio.createGain();
  const output = audio.createChannelMerger(2);
  stereo.connect(split);
  split.connect(left, 0);
  split.connect(right, 1);
  left.connect(output, 0, 0);
  right.connect(output, 0, 1);
  const source = audio.createMediaElementSource(video);
  return { source, stereo, left, right, output, connected: false };
}

function applyBalance(audio: AudioContext, graph: BalanceGraph, balance: number) {
  const left = 1 - Math.max(0, balance / 100);
  const right = 1 + Math.min(0, balance / 100);
  if (!graph.connected) {
    graph.left.gain.value = left;
    graph.right.gain.value = right;
    graph.source.connect(graph.stereo);
    graph.output.connect(audio.destination);
    graph.connected = true;
    return;
  }
  // A brief gain ramp avoids clicks on each slider increment.
  const now = audio.currentTime;
  for (const [gain, target] of [[graph.left.gain, left], [graph.right.gain, right]] as const) {
    gain.cancelScheduledValues(now);
    gain.setTargetAtTime(target, now, 0.015);
  }
}

export function setPlaybackAudioBalance(video: HTMLMediaElement, value = 0, onUnavailable?: (unavailable: boolean) => void): (() => void) | undefined {
  const balance = normalizeRoomAudioBalance(value);
  let graph = graphs.get(video);
  if (balance === 0 && !graph && !onUnavailable) return;
  if (!contextConstructor()) { onUnavailable?.(true); return; }
  let audio = context;
  let failed = false;
  let stopped = false;
  let nativeHlsChecked = false;
  let checkingNativeHls = false;
  const cleanup = () => {
    stopped = true;
    audio?.removeEventListener('statechange', attach);
    video.removeEventListener('loadedmetadata', attach);
    video.removeEventListener('emptied', attach);
  };
  const attach = () => {
    // FLV and hls.js deliver CORS-checked bytes into a local MediaSource blob.
    // Native HLS has platform-specific Web Audio support and retains native output.
    const mediaSource = video.currentSrc.startsWith('blob:');
    const native = !!video.currentSrc && !mediaSource;
    if (native || failed) { onUnavailable?.(true); return; }
    onUnavailable?.(false);
    if (graph && audio) {
      if (mediaSource) resumeAudio();
      if (graph.connected || mediaSource) applyBalance(audio, graph, balance);
      return;
    }
    if (balance === 0 || !mediaSource) return;
    if (!nativeHlsChecked && video.canPlayType('application/vnd.apple.mpegurl')) {
      // Binding is permanent for an element. A browser that can switch from FLV
      // to native HLS needs its native output even while the current route is FLV.
      if (!checkingNativeHls) {
        checkingNativeHls = true;
        hlsUsesMediaSource ??= import('hls.js').then(({ default: Hls }) => Hls.isSupported()).catch(() => false);
        void hlsUsesMediaSource.then(supported => {
          if (stopped) return;
          nativeHlsChecked = true;
          failed = !supported;
          attach();
        });
      }
      return;
    }
    if (!audio) {
      audio = sharedContext();
      if (!audio) { onUnavailable?.(true); return; }
    }
    if (audio.state !== 'running') {
      audio.addEventListener('statechange', attach);
      resumeAudio();
      return;
    }
    audio.removeEventListener('statechange', attach);
    try { graph = createGraph(audio, video); } catch { /* Keep native media output if the processing graph is unavailable. */ }
    if (!graph) { failed = true; onUnavailable?.(true); return; }
    graphs.set(video, graph);
    applyBalance(audio, graph, balance);
  };
  video.addEventListener('loadedmetadata', attach);
  video.addEventListener('emptied', attach);
  attach();
  return cleanup;
}

export function releasePlaybackAudioBalance(video: HTMLMediaElement) {
  const graph = graphs.get(video);
  if (!graph?.connected) return;
  graph.source.disconnect();
  graph.output.disconnect();
  graph.connected = false;
}
