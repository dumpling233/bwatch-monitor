import { LiveWS } from '@laplace.live/ws/browser';
import { normalizeDanmaku } from './normalize';
import { DanmakuOutputQueue } from './outputQueue';
import type { DanmakuWorkerCommand, DanmakuWorkerEvent } from './types';

const context = globalThis as unknown as {
  postMessage(event: DanmakuWorkerEvent): void;
  onmessage: ((event: MessageEvent<DanmakuWorkerCommand>) => void) | null;
  close(): void;
};
interface Connection {
  roomId: string;
  generation: number;
  live: LiveWS;
  watchdog: ReturnType<typeof setTimeout>;
  stopped: boolean;
}
const connections = new Map<string, Connection>();
const output = new DanmakuOutputQueue(event => context.postMessage(event));
const current = (connection: Connection): boolean => !connection.stopped && connections.get(connection.roomId) === connection;
function stop(connection: Connection): void {
  connection.stopped = true;
  clearTimeout(connection.watchdog);
  output.remove(connection.roomId, connection.generation);
  connection.live.close();
}
function fail(connection: Connection, error: string): void {
  if (!current(connection)) return;
  stop(connection);
  context.postMessage({ type: 'state', roomId: connection.roomId, generation: connection.generation, state: { status: 'error', error } });
}
function armWatchdog(connection: Connection, ms: number): void {
  clearTimeout(connection.watchdog);
  connection.watchdog = setTimeout(() => fail(connection, '弹幕连接超时，正在恢复'), ms);
}
function connect(command: Extract<DanmakuWorkerCommand, { type: 'connect' }>): void {
  if (!output.current(command.roomId, command.generation)) return;
  const previous = connections.get(command.roomId);
  if (previous) stop(previous);
  connections.delete(command.roomId);
  try {
    const host = command.bootstrap.hosts[command.hostIndex];
    const url = new URL(host?.url || '');
    if (url.protocol !== 'wss:' || !/^([a-z0-9-]+\.)*chat\.bilibili\.com$/i.test(url.hostname) || url.pathname !== '/sub' || url.username || url.password || url.search || url.hash) throw new Error('Invalid host');
    const uid = command.bootstrap.uid === undefined ? 0 : Number(command.bootstrap.uid);
    if (!Number.isSafeInteger(uid) || uid < 0 || (command.bootstrap.mode === 'authenticated' && uid === 0)) throw new Error('Invalid uid');
    const live = new LiveWS(Number(command.bootstrap.roomId), {
      address: url.href, uid, key: command.bootstrap.token, buvid: command.bootstrap.buvid, protover: 3,
    });
    const connection: Connection = { roomId: command.roomId, generation: command.generation, live,
      watchdog: setTimeout(() => {}, 0), stopped: false };
    connections.set(command.roomId, connection);
    armWatchdog(connection, 12000);
    live.addEventListener('live', () => {
      if (!current(connection)) return;
      armWatchdog(connection, 45000);
      context.postMessage({ type: 'state', roomId: command.roomId, generation: command.generation, state: { status: 'live' } });
    });
    live.addEventListener('heartbeat', () => { if (current(connection)) armWatchdog(connection, 45000); });
    live.addEventListener('msg', event => {
      if (!current(connection) || !live.live) return;
      armWatchdog(connection, 45000);
      output.add(command.roomId, connection.generation, normalizeDanmaku(command.roomId, event.data));
    });
    live.addEventListener('close', () => fail(connection, '弹幕连接已断开'));
    live.addEventListener('error', () => fail(connection, '弹幕认证或数据解析失败'));
  } catch {
    context.postMessage({ type: 'state', roomId: command.roomId, generation: command.generation, state: { status: 'error', error: '当前浏览器无法建立弹幕连接' } });
  }
}

context.onmessage = event => {
  const command = event.data;
  if (command.type === 'begin') {
    const previous = connections.get(command.roomId);
    if (previous && previous.generation > command.generation) return;
    if (previous) { stop(previous); connections.delete(command.roomId); }
    output.begin(command.roomId, command.generation, command.clearVersion, command.superChats);
  } else if (command.type === 'connect') connect(command);
  else if (command.type === 'ack') output.ack(command.batchId);
  else if (command.type === 'clear') output.clear(command.roomId, command.generation, command.clearVersion);
  else if (command.type === 'disconnect') {
    const connection = connections.get(command.roomId);
    if (connection && connection.generation <= command.generation) { stop(connection); connections.delete(command.roomId); }
    output.remove(command.roomId, command.generation);
  } else if (command.type === 'dispose') {
    for (const connection of connections.values()) stop(connection);
    connections.clear();
    output.dispose();
    context.close();
  }
};
