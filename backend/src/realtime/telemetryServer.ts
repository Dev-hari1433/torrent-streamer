import { WebSocket, WebSocketServer } from 'ws';
import type { Server } from 'node:http';
import type { TorrentEngine } from '../torrent/engine.js';
import { isFrontendOrigin } from '../config/browserAccess.js';

export function telemetryServer(server: Server, engine: TorrentEngine) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
  const alive = new WeakSet<WebSocket>();
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/telemetry' || !isFrontendOrigin(request.headers.origin) || wss.clients.size >= 100) {
      socket.destroy(); return;
    }
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', ws => {
    alive.add(ws); ws.on('pong', () => alive.add(ws)); ws.on('error', () => ws.terminate());
    ws.send(JSON.stringify({ type: 'snapshot', torrents: [...engine.sessions.values()].map(s => engine.snapshot(s)) }));
  });
  const broadcast = setInterval(() => {
    if (!wss.clients.size) return;
    const data = JSON.stringify({ type: 'snapshot', torrents: [...engine.sessions.values()].map(s => engine.snapshot(s)) });
    for (const ws of wss.clients) if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 256 * 1024) ws.send(data);
  }, 500);
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) { ws.terminate(); continue; }
      alive.delete(ws); ws.ping();
    }
  }, 15000);
  return () => { clearInterval(broadcast); clearInterval(heartbeat); for (const ws of wss.clients) ws.terminate(); wss.close(); };
}
