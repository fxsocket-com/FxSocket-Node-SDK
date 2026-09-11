/** Tests for WebSocket streaming, against a real local server. */

import type { AddressInfo } from 'node:net';

import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DealEntry,
  parseEvent,
  Stream,
  StreamError,
  UnsupportedOnPlatformError,
  ValidationError,
  withApiKey,
  type StreamEvent,
  type TickEvent,
} from '../src/index.js';
import { TICK_FRAME } from './helpers/fixtures.js';

type Handler = (socket: ServerSocket, connectionIndex: number) => void | Promise<void>;

interface TestServer {
  url: string;
  /** Every payload the server received, decoded. */
  received: Record<string, unknown>[];
  /** How many connections the server accepted. */
  connections: number;
  /** The request target of each upgrade, so the handshake query is visible. */
  handshakes: string[];
  close: () => Promise<void>;
}

const servers: TestServer[] = [];

async function startServer(handler: Handler): Promise<TestServer> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  const { port } = wss.address() as AddressInfo;

  const server: TestServer = {
    url: `ws://127.0.0.1:${port}/ws`,
    received: [],
    connections: 0,
    handshakes: [],
    close: async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };

  wss.on('connection', (socket, request) => {
    server.connections += 1;
    server.handshakes.push(request.url ?? '');
    const index = server.connections;
    socket.on('message', (raw) => {
      try {
        server.received.push(JSON.parse(raw.toString()) as Record<string, unknown>);
      } catch {
        // ignore
      }
    });
    void handler(socket, index);
  });

  servers.push(server);
  return server;
}

/** Wait for a condition, polling briefly. */
async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function stream(
  url: string,
  options: Partial<ConstructorParameters<typeof Stream>[0]> = {},
) {
  return new Stream({ wsUrl: url, apiKey: 'k', platform: 'mt5', ...options });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

// --------------------------------------------------------------------------- //
// URL handling
// --------------------------------------------------------------------------- //

describe('withApiKey', () => {
  it('adds the key to the query string', () => {
    expect(withApiKey('wss://api.fxsocket.com/mt5/abc/ws', 'fxs_live_x')).toBe(
      'wss://api.fxsocket.com/mt5/abc/ws?api_key=fxs_live_x',
    );
  });

  it('preserves existing query parameters', () => {
    const url = withApiKey('wss://h/ws?foo=1', 'k');
    expect(url).toContain('foo=1');
    expect(url).toContain('api_key=k');
  });
});

// --------------------------------------------------------------------------- //
// parseEvent — every message type, pure function
// --------------------------------------------------------------------------- //

describe('parseEvent', () => {
  it('decodes every known frame type', () => {
    expect(parseEvent(TICK_FRAME).type).toBe('tick');

    const bar = parseEvent({
      type: 'bar',
      symbol: 'EURUSD',
      timeframe: 'M5',
      data: {
        time: 't',
        open: 1.0,
        high: 1.1,
        low: 0.9,
        close: 1.05,
        tickVolume: 5,
        realVolume: 0,
        spread: 2,
      },
    });
    expect(bar.type).toBe('bar');
    if (bar.type === 'bar') {
      expect(bar.timeframe).toBe('M5');
      expect(bar.data.tickVolume).toBe(5);
    }

    const account = parseEvent({
      type: 'account',
      data: {
        balance: 100.0,
        credit: 0.0,
        profit: 1.0,
        equity: 101.0,
        margin: 0.0,
        freeMargin: 101.0,
        marginLevel: 0.0,
        leverage: 100,
        currency: 'USD',
        type: 'Demo',
      },
    });
    expect(account.type).toBe('account');
    if (account.type === 'account') expect(account.data.freeMargin).toBe(101.0);

    const positions = parseEvent({
      type: 'positions',
      data: [
        {
          ticket: 1,
          symbol: 'EURUSD',
          type: 'Buy',
          kind: 'Position',
          lots: 0.1,
          openPrice: 1.0,
          currentPrice: 1.0,
          stopLoss: 0.0,
          takeProfit: 0.0,
          swap: 0.0,
          profit: 0.0,
          magic: 0,
          comment: '',
          openTime: 't',
        },
      ],
    });
    expect(positions.type).toBe('positions');
    if (positions.type === 'positions') expect(positions.data[0]!.ticket).toBe(1);

    const trade = parseEvent({
      type: 'trade',
      data: {
        deal: 9,
        order: 10,
        position: 10,
        symbol: 'EURUSD',
        type: 'Buy',
        entry: 'In',
        volume: 0.1,
        price: 1.0,
        profit: 0.0,
        commission: -0.04,
        swap: 0.0,
        magic: 1000999,
        comment: 'CN_9999_8888',
        time: 't',
        degraded: false,
      },
    });
    expect(trade.type).toBe('trade');
    if (trade.type === 'trade') {
      expect(trade.data.entry).toBe('In');
      expect(trade.data.commission).toBe(-0.04);
      expect(trade.data.magic).toBe(1000999);
      expect(trade.data.degraded).toBe(false);
      expect(trade.data.netProfit).toBeCloseTo(-0.04);
    }

    const terminal = parseEvent({
      type: 'terminal',
      data: { connected: true, tradeAllowed: true, serverTime: 't' },
    });
    expect(terminal.type).toBe('terminal');
    if (terminal.type === 'terminal') expect(terminal.data.tradeAllowed).toBe(true);

    expect(parseEvent({ type: 'warning', dropped: 7 })).toEqual({
      type: 'warning',
      dropped: 7,
    });
    expect(parseEvent({ type: 'subscribed', topic: 'prices', message: '' })).toEqual({
      type: 'subscribed',
      topic: 'prices',
      message: '',
    });
    expect(
      parseEvent({ type: 'unsubscribed', topic: 'prices', message: '' }).type,
    ).toBe('unsubscribed');
    expect(parseEvent({ type: 'error', topic: 'bars', message: 'bad tf' })).toEqual({
      type: 'error',
      topic: 'bars',
      message: 'bad tf',
    });
    expect(parseEvent({ type: 'subscriptions', data: [] }).type).toBe('subscriptions');
  });

  it('keeps an unknown frame instead of dropping it', () => {
    const event = parseEvent({ type: 'moon_phase', value: 3 });
    expect(event.type).toBe('unknown');
    if (event.type === 'unknown') {
      expect(event.eventType).toBe('moon_phase');
      expect(event.raw['value']).toBe(3);
    }
  });

  it('defaults the enrichment fields on a pre-0.12 bridge frame', () => {
    const event = parseEvent({
      type: 'trade',
      data: {
        deal: 9,
        order: 10,
        position: 10,
        symbol: 'EURUSD',
        type: 'Buy',
        entry: 'In',
        volume: 0.1,
        price: 1.0,
        profit: 0.0,
        comment: '',
        time: 't',
      },
    });
    expect(event.type).toBe('trade');
    if (event.type !== 'trade') return;
    expect(event.data.commission).toBe(0);
    expect(event.data.swap).toBe(0);
    expect(event.data.magic).toBe(0);
    expect(event.data.degraded).toBe(false);
  });

  it('surfaces a degraded trade frame', () => {
    const event = parseEvent({
      type: 'trade',
      data: {
        deal: 9,
        order: 10,
        position: 10,
        symbol: 'EURUSD',
        type: 'Buy',
        entry: 'Unknown',
        volume: 0.1,
        price: 1.0,
        profit: 0.0,
        commission: 0.0,
        swap: 0.0,
        magic: 0,
        comment: '',
        time: '2026-08-19T18:53:41.000Z',
        degraded: true,
      },
    });
    expect(event.type).toBe('trade');
    if (event.type !== 'trade') return;
    expect(event.data.degraded).toBe(true);
    expect(event.data.entry).toBe(DealEntry.UNKNOWN);
    expect(event.data.symbol).toBe('EURUSD');
    expect(event.data.position).toBe(10);
  });
});

// --------------------------------------------------------------------------- //
// Validation (no connection needed — raised before send)
// --------------------------------------------------------------------------- //

describe('subscription validation', () => {
  it('requires a timeframe for bars', async () => {
    const s = stream('ws://x/ws');
    await expect(s.subscribe('bars', { symbol: 'EURUSD' })).rejects.toThrow(
      ValidationError,
    );
  });

  it('rejects an MT5-only timeframe on MT4', async () => {
    const s = stream('ws://x/ws', { platform: 'mt4' });
    await expect(s.subscribeBars('EURUSD', 'H6')).rejects.toThrow(
      UnsupportedOnPlatformError,
    );
  });

  it('requires a symbol for prices', async () => {
    const s = stream('ws://x/ws');
    await expect(s.subscribe('prices')).rejects.toThrow(ValidationError);
  });

  it('rejects an unknown topic', async () => {
    const s = stream('ws://x/ws');
    await expect(s.subscribe('weather')).rejects.toThrow(/unknown topic/);
  });

  it('refuses to iterate before connecting', async () => {
    const s = stream('ws://x/ws');
    await expect(
      (async () => {
        for await (const _event of s) break;
      })(),
    ).rejects.toThrow(/not connected/);
  });

  it('refuses to subscribe before connecting', async () => {
    const s = stream('ws://x/ws');
    await expect(s.subscribePrices('EURUSD')).rejects.toThrow(StreamError);
  });
});

// --------------------------------------------------------------------------- //
// End-to-end against a local server
// --------------------------------------------------------------------------- //

describe('streaming', () => {
  it('sends the subscribe payload and yields the tick', async () => {
    const server = await startServer((socket) => {
      socket.once('message', () => {
        socket.send(
          JSON.stringify({ type: 'subscribed', topic: 'prices', message: '' }),
        );
        socket.send(JSON.stringify(TICK_FRAME));
      });
    });

    const s = stream(server.url, { autoReconnect: false });
    await s.connect();
    await s.subscribePrices('EURUSD');

    const events: StreamEvent[] = [];
    for await (const event of s) {
      events.push(event);
      if (event.type === 'tick') break;
    }
    await s.close();

    expect(server.received[0]).toEqual({
      action: 'subscribe',
      topic: 'prices',
      symbol: 'EURUSD',
    });
    const tick = events.find((e): e is TickEvent => e.type === 'tick');
    expect(tick?.data.ask).toBe(1.0851);
  });

  it('authenticates with the api_key query parameter on the handshake', async () => {
    const server = await startServer(() => {});
    const s = stream(server.url, { apiKey: 'fxs_live_secret', autoReconnect: false });
    await s.connect();
    await until(() => server.handshakes.length > 0);
    await s.close();

    const target = new URL(server.handshakes[0]!, 'http://localhost');
    expect(target.pathname).toBe('/ws');
    expect(target.searchParams.get('api_key')).toBe('fxs_live_secret');
  });

  it('stops iteration on close even with auto-reconnect on', async () => {
    const server = await startServer((socket) => {
      socket.once('message', () => socket.send(JSON.stringify(TICK_FRAME)));
    });

    const s = stream(server.url, { autoReconnect: true });
    await s.connect();
    await s.subscribePrices('EURUSD');

    const events: StreamEvent[] = [];
    const consumer = (async () => {
      for await (const event of s) events.push(event);
    })();

    await until(() => events.some((e) => e.type === 'tick'));
    await s.close();
    // If close() reconnected instead of stopping, this would hang.
    await consumer;
    expect(events.some((e) => e.type === 'tick')).toBe(true);
  });

  it('replays subscriptions after a reconnect', async () => {
    const server = await startServer((socket, index) => {
      socket.once('message', () => {
        socket.send(JSON.stringify(TICK_FRAME));
        if (index === 1) setTimeout(() => socket.close(), 20);
      });
    });

    const s = stream(server.url, { autoReconnect: true, maxReconnectAttempts: 3 });
    await s.connect();
    await s.subscribePrices('EURUSD');

    let ticks = 0;
    for await (const event of s) {
      if (event.type === 'tick') {
        ticks += 1;
        if (ticks === 2) break;
      }
    }
    await s.close();

    expect(server.connections).toBe(2);
    expect(server.received).toHaveLength(2);
    expect(
      server.received.every(
        (payload) =>
          JSON.stringify(payload) ===
          JSON.stringify({ action: 'subscribe', topic: 'prices', symbol: 'EURUSD' }),
      ),
    ).toBe(true);
  });

  it('survives a connection that drops mid-replay', async () => {
    // Critical: if the freshly reconnected socket drops *during* subscription
    // replay, the reconnect must retry rather than let the failure kill
    // iteration.
    const server = await startServer((socket, index) => {
      if (index === 2) {
        socket.close(); // drop immediately -> the replay send fails
        return;
      }
      socket.once('message', () => {
        socket.send(JSON.stringify(TICK_FRAME));
        if (index === 1) setTimeout(() => socket.close(), 20);
      });
    });

    const s = stream(server.url, { autoReconnect: true, maxReconnectAttempts: 5 });
    await s.connect();
    await s.subscribePrices('EURUSD');

    let ticks = 0;
    for await (const event of s) {
      if (event.type === 'tick') {
        ticks += 1;
        if (ticks === 2) break;
      }
    }
    await s.close();

    expect(ticks).toBe(2);
    expect(server.connections).toBeGreaterThanOrEqual(3);
  });

  it('throws once the reconnect budget is exhausted', async () => {
    const server = await startServer((socket, index) => {
      if (index === 1) {
        socket.once('message', () => setTimeout(() => socket.close(), 10));
        return;
      }
      socket.close();
    });

    const s = stream(server.url, { autoReconnect: true, maxReconnectAttempts: 1 });
    s.on('error', () => {});
    await s.connect();
    await s.subscribePrices('EURUSD');

    await expect(
      (async () => {
        for await (const _event of s) {
          // drain until the stream gives up
        }
      })(),
    ).rejects.toThrow(/could not be re-established/);
    await s.close();
  });

  it.each(['M5', '5min'])('sends the canonical timeframe for %s', async (tf) => {
    const server = await startServer(() => {});
    const s = stream(server.url);
    await s.connect();
    await s.subscribeBars('EURUSD', tf);
    await until(() => server.received.length > 0);
    await s.close();

    expect(server.received[0]).toEqual({
      action: 'subscribe',
      topic: 'bars',
      symbol: 'EURUSD',
      timeframe: 'M5',
    });
  });

  it('sends the unsubscribe payload', async () => {
    const server = await startServer(() => {});
    const s = stream(server.url);
    await s.connect();
    await s.subscribePrices('EURUSD');
    await s.unsubscribePrices('EURUSD');
    await until(() => server.received.length >= 2);
    await s.close();

    expect(server.received[1]).toEqual({
      action: 'unsubscribe',
      topic: 'prices',
      symbol: 'EURUSD',
    });
    expect(s.subscriptions).toEqual([]);
  });

  it('asks the server to list subscriptions', async () => {
    const server = await startServer(() => {});
    const s = stream(server.url);
    await s.connect();
    await s.listSubscriptions();
    await until(() => server.received.length > 0);
    await s.close();
    expect(server.received[0]).toEqual({ action: 'list' });
  });

  it('delivers control and data frames through the iterator', async () => {
    const frames = [
      { type: 'warning', dropped: 42 },
      {
        type: 'account',
        data: {
          balance: 1.0,
          credit: 0.0,
          profit: 0.0,
          equity: 1.0,
          margin: 0.0,
          freeMargin: 1.0,
          marginLevel: 0.0,
          leverage: 100,
          currency: 'USD',
          type: 'Demo',
        },
      },
      {
        type: 'terminal',
        data: { connected: true, tradeAllowed: true, serverTime: 't' },
      },
      { type: 'subscriptions', data: [{ topic: 'account' }] },
    ];

    const server = await startServer((socket) => {
      socket.once('message', () => {
        for (const frame of frames) socket.send(JSON.stringify(frame));
      });
    });

    const s = stream(server.url);
    await s.connect();
    await s.subscribeAccount();

    const seen: StreamEvent[] = [];
    for await (const event of s) {
      seen.push(event);
      if (seen.length >= frames.length) break;
    }
    await s.close();

    expect(new Set(seen.map((e) => e.type))).toEqual(
      new Set(['warning', 'account', 'terminal', 'subscriptions']),
    );
    const warning = seen.find((e) => e.type === 'warning');
    expect(warning).toEqual({ type: 'warning', dropped: 42 });
  });

  it('emits typed events to listeners as well', async () => {
    const server = await startServer((socket) => {
      socket.once('message', () => {
        socket.send(JSON.stringify(TICK_FRAME));
        socket.send(
          JSON.stringify({ type: 'error', topic: 'bars', message: 'bad tf' }),
        );
      });
    });

    const s = stream(server.url);
    const ticks: TickEvent[] = [];
    const errors: string[] = [];
    s.on('tick', (event) => ticks.push(event));
    // A server `error` frame must not land on EventEmitter's 'error' channel.
    s.on('streamError', (event) => errors.push(event.message));

    await s.connect();
    await s.subscribePrices('EURUSD');
    await until(() => ticks.length > 0 && errors.length > 0);
    await s.close();

    expect(ticks[0]!.data.bid).toBe(1.0849);
    expect(errors).toEqual(['bad tf']);
  });

  it('ignores a frame that is not valid JSON', async () => {
    const server = await startServer((socket) => {
      socket.once('message', () => {
        socket.send('not json at all');
        socket.send(JSON.stringify(TICK_FRAME));
      });
    });

    const s = stream(server.url);
    await s.connect();
    await s.subscribePrices('EURUSD');

    const first = await (async () => {
      for await (const event of s) return event;
      return undefined;
    })();
    await s.close();
    expect(first?.type).toBe('tick');
  });

  it('drops the oldest buffered events when the consumer falls behind', async () => {
    const server = await startServer((socket) => {
      socket.once('message', () => {
        for (let i = 0; i < 6; i += 1) socket.send(JSON.stringify(TICK_FRAME));
      });
    });

    const s = stream(server.url, { maxQueueSize: 2 });
    const lag: number[] = [];
    s.on('lag', (event) => lag.push(event.dropped));
    await s.connect();
    await s.subscribePrices('EURUSD');
    await until(() => lag.length > 0);
    await s.close();

    expect(s.lagDropped).toBeGreaterThan(0);
  });

  it('is safe to close twice', async () => {
    const server = await startServer(() => {});
    const s = stream(server.url);
    await s.connect();
    await s.close();
    await expect(s.close()).resolves.toBeUndefined();
  });

  it('reports a connection that never opens', async () => {
    const s = stream('ws://127.0.0.1:1/ws', { openTimeoutMs: 1_000 });
    await expect(s.connect()).rejects.toThrow(StreamError);
  });
});
