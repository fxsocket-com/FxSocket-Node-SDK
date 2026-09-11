import { WebSocketServer } from 'ws';
import { Stream } from '../src/terminal/stream.js';

const wss = new WebSocketServer({ port: 0 });
await new Promise<void>((r) => wss.once('listening', () => r()));
const port = (wss.address() as { port: number }).port;

const sockets: import('ws').WebSocket[] = [];
wss.on('connection', (ws) => {
  sockets.push(ws);
  console.log('[server] connection #' + sockets.length);
  ws.on('message', (m) => console.log('[server] recv', m.toString()));
});

const stream = new Stream({
  wsUrl: `ws://127.0.0.1:${port}`,
  apiKey: 'k',
  platform: 'mt5',
  pingIntervalMs: 0,
});

let ticks = 0;
stream.on('tick', () => { ticks += 1; console.log('[client] tick listener fired, total', ticks); });
stream.on('close', () => console.log('[client] close event'));

// Race: start connect(), then close() before open resolves.
const connecting = stream.connect();
await stream.close();
console.log('[client] close() resolved. isConnected =', stream.isConnected);
try { await connecting; } catch (e) { console.log('[client] connect rejected:', (e as Error).message); }
await new Promise((r) => setTimeout(r, 150));
console.log('[client] after settle: isConnected =', stream.isConnected, 'server clients =', wss.clients.size);

// Does the server-side socket still work? push a tick.
for (const s of sockets) {
  if (s.readyState === 1) s.send(JSON.stringify({ type: 'tick', symbol: 'EURUSD', data: { bid: 1, ask: 2 } }));
}
await new Promise((r) => setTimeout(r, 150));
console.log('[client] ticks delivered after close():', ticks);
console.log('[client] server clients still open:', wss.clients.size);

wss.close();
for (const s of sockets) s.terminate();
process.exit(0);
