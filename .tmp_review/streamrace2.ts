import { WebSocketServer } from 'ws';
import { Stream } from '../src/terminal/stream.js';

const wss = new WebSocketServer({ port: 0 });
await new Promise<void>((r) => wss.once('listening', () => r()));
const port = (wss.address() as { port: number }).port;

let n = 0;
const sockets: import('ws').WebSocket[] = [];
wss.on('connection', (ws) => {
  n += 1;
  sockets.push(ws);
  console.log('[server] connection #' + n);
  ws.on('message', (m) => console.log('[server] recv', m.toString()));
});

const stream = new Stream({
  wsUrl: `ws://127.0.0.1:${port}`,
  apiKey: 'k',
  platform: 'mt5',
  pingIntervalMs: 0,
});
let ticks = 0;
stream.on('tick', () => { ticks += 1; });
stream.on('reconnected', (e) => console.log('[client] reconnected', e));
stream.on('close', () => console.log('[client] close event'));
stream.on('error', (e) => console.log('[client] error', e.message));

await stream.connect();
await stream.subscribePrices('EURUSD');
console.log('[client] connected, subs =', JSON.stringify(stream.subscriptions));

// Server drops -> reconnect loop starts (attempt 0 opens immediately).
sockets[0]!.terminate();
// Wait for the drop to register, then close() while the reconnect is sleeping/opening.
await new Promise((r) => setTimeout(r, 5));
const closing = stream.close();
await closing;
console.log('[client] close() resolved; isConnected =', stream.isConnected);

await new Promise((r) => setTimeout(r, 1200));
console.log('[client] after settle: isConnected =', stream.isConnected, 'server clients =', wss.clients.size, 'total conns =', n);
for (const s of sockets) if (s.readyState === 1) s.send(JSON.stringify({ type: 'tick', symbol: 'EURUSD', data: { bid: 1, ask: 2 } }));
await new Promise((r) => setTimeout(r, 100));
console.log('[client] ticks after close():', ticks);

// Does anything keep the loop alive?
const handles = (process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles();
console.log('[client] active handles:', handles.length);
wss.close();
for (const s of sockets) s.terminate();
process.exit(0);
