/** Tests for WebSocket streaming, against a real local server. */

import type { AddressInfo } from 'node:net';

import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DealEntry,
  FxSocket,
  OrderEventKind,
  parseEvent,
  Stream,
  StreamError,
  StreamTopic,
  ValidationError,
  withApiKey,
  type StreamEvent,
  type TickEvent,
  type TradeEventMessage,
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

async function startServer(handler: Handler, onPort = 0): Promise<TestServer> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: onPort });
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

async function startServerOnPort(port: number, handler: Handler): Promise<TestServer> {
  return startServer(handler, port);
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

    // A pre-0.17 warning names no topic; the fields default to empty.
    expect(parseEvent({ type: 'warning', dropped: 7 })).toEqual({
      type: 'warning',
      dropped: 7,
      topic: '',
      symbol: '',
      timeframe: '',
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

  it.each(['mt4', 'mt5'] as const)(
    'rejects an unsupported timeframe on %s',
    async (platform) => {
      const s = stream('ws://x/ws', { platform });
      await expect(s.subscribeBars('EURUSD', 'H6')).rejects.toThrow(ValidationError);
    },
  );

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

  it('refuses to list subscriptions before connecting', async () => {
    // Unlike a subscribe, nothing would replay a `list` after a reconnect, so
    // it must fail loudly rather than answer nothing.
    const s = stream('ws://x/ws');
    await expect(s.listSubscriptions()).rejects.toThrow(StreamError);
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
    expect(warning).toEqual({
      type: 'warning',
      dropped: 42,
      topic: '',
      symbol: '',
      timeframe: '',
    });
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

  it('refuses a second concurrent iterator instead of starving it', async () => {
    const server = await startServer((socket) => {
      socket.once('message', () => socket.send(JSON.stringify(TICK_FRAME)));
    });

    const s = stream(server.url, { autoReconnect: false });
    await s.connect();
    await s.subscribePrices('EURUSD');

    const first = (async () => {
      for await (const event of s) {
        if (event.type === 'tick') return event;
      }
      return undefined;
    })();

    await expect(
      (async () => {
        for await (const _event of s) break;
      })(),
    ).rejects.toThrow(/already being iterated/);

    expect((await first)?.type).toBe('tick');
    await s.close();
  });

  it('frees the stream for a later iterator when a loop is abandoned', async () => {
    const server = await startServer((socket) => {
      socket.on('message', () => socket.send(JSON.stringify(TICK_FRAME)));
    });

    const s = stream(server.url, { autoReconnect: false });
    await s.connect();
    await s.subscribePrices('EURUSD');

    for await (const event of s) {
      if (event.type === 'tick') break; // abandons the generator
    }
    // The finally block must have released the iterator lock.
    await s.subscribePrices('EURUSD');
    for await (const event of s) {
      if (event.type === 'tick') break;
    }
    await s.close();
  });

  it('revives after a failed reconnect when connect() is called again', async () => {
    // The standard recovery path: catch the StreamError, reconnect, keep
    // iterating. Before the fix the second iterator returned nothing forever
    // while the stream reported itself connected.
    const first = await startServer((socket) => {
      socket.on('message', () => socket.send(JSON.stringify(TICK_FRAME)));
    });
    const port = Number(new URL(first.url).port);

    const s = stream(first.url, { autoReconnect: true, maxReconnectAttempts: 1 });
    s.on('error', () => {});
    await s.connect();
    await s.subscribePrices('EURUSD');

    let thrown: unknown;
    // Started, not awaited: the loop only ends once the server is gone.
    const draining = (async () => {
      try {
        for await (const _event of s) {
          // drain until the server dies
        }
      } catch (error) {
        thrown = error;
      }
    })();

    // Kill the server so the reconnect budget runs out.
    await first.close();
    await draining;
    expect(thrown).toBeInstanceOf(StreamError);

    // Bring it back on the same port and recover.
    const second = await startServerOnPort(port, (socket) => {
      socket.on('message', () => socket.send(JSON.stringify(TICK_FRAME)));
    });
    await s.connect();
    await s.subscribePrices('EURUSD');

    let ticks = 0;
    const resumed = (async () => {
      for await (const event of s) {
        if (event.type === 'tick') {
          ticks += 1;
          break;
        }
      }
    })();
    await until(() => ticks > 0, 15_000);
    await s.close();
    await resumed;
    await second.close();

    expect(ticks).toBeGreaterThan(0);
  }, 60_000);

  it('does not leave a live socket when close() races the handshake', async () => {
    let live = 0;
    const server = await startServer((socket) => {
      live += 1;
      socket.on('close', () => {
        live -= 1;
      });
    });

    const s = stream(server.url, { autoReconnect: false });
    const connecting = s.connect().catch(() => undefined);
    await s.close(); // lands while the handshake is still in flight
    await connecting;
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(s.isConnected).toBe(false);
    expect(live).toBe(0);
  });

  it('does not duplicate sockets when a reconnected listener throws', async () => {
    let live = 0;
    const server = await startServer((socket, index) => {
      live += 1;
      socket.on('close', () => {
        live -= 1;
      });
      socket.on('message', () => socket.send(JSON.stringify(TICK_FRAME)));
      if (index === 1) setTimeout(() => socket.close(), 50);
    });

    const s = stream(server.url, { autoReconnect: true, maxReconnectAttempts: 3 });
    s.on('error', () => {});
    s.on('reconnected', () => {
      throw new Error('listener blew up');
    });
    await s.connect();
    await s.subscribePrices('EURUSD');

    await until(() => server.connections >= 2, 15_000);
    await new Promise((resolve) => setTimeout(resolve, 600));
    // A throwing listener must not be read as a failed attempt and open more.
    expect(live).toBeLessThanOrEqual(1);
    await s.close();
  }, 30_000);

  it('stops delivering to listeners once closed', async () => {
    const server = await startServer((socket) => {
      socket.on('message', () => {
        const send = (): void => {
          if (socket.readyState === socket.OPEN)
            socket.send(JSON.stringify(TICK_FRAME));
        };
        send();
        setInterval(send, 20).unref?.();
      });
    });

    const s = stream(server.url, { autoReconnect: false });
    const ticks: unknown[] = [];
    s.on('tick', (event) => ticks.push(event));
    await s.connect();
    await s.subscribePrices('EURUSD');
    await until(() => ticks.length > 0);
    await s.close();

    const afterClose = ticks.length;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(ticks.length).toBe(afterClose);
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

// --------------------------------------------------------------------------- //
// Bridge MT5 0.17.0 / MT4 0.15.0
// --------------------------------------------------------------------------- //

function tradeFrame(
  data: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'trade',
    data: {
      deal: 0,
      order: 0,
      position: 0,
      symbol: 'EURUSD',
      type: 'Buy',
      entry: 'In',
      volume: 0.1,
      price: 1.0,
      profit: 0,
      commission: 0,
      swap: 0,
      magic: 0,
      comment: '',
      time: '2026-10-29T18:00:00.000Z',
      degraded: false,
      ...data,
    },
    ...extra,
  };
}

const PENDING = {
  ticket: 501,
  symbol: 'EURUSD',
  type: 'BuyLimit',
  volumeInitial: 0.1,
  volume: 0.1,
  price: 1.07,
  stopLimitPrice: 0,
  sl: 0,
  tp: 0,
  expirationMode: 'gtc',
  expiration: '',
  expirationUtc: '',
  magic: 7,
  comment: '',
  time: '2026-10-29T18:00:00.000Z',
  timeUtc: '2026-10-29T16:00:00.000Z',
};

describe('parseEvent (0.17 frames)', () => {
  it('reads the envelope off data frames', () => {
    const tick = parseEvent({ ...TICK_FRAME, seq: 41, ts: 1761760800123 });
    expect(tick).toMatchObject({
      type: 'tick',
      seq: 41,
      ts: 1761760800123,
      snapshot: false,
    });

    const snapshot = parseEvent({
      type: 'account',
      snapshot: true,
      ts: 1761760800000,
      data: { balance: 1 },
    });
    expect(snapshot).toMatchObject({ seq: null, ts: 1761760800000, snapshot: true });

    // Pre-0.17 frames carry no envelope.
    expect(parseEvent(TICK_FRAME)).toMatchObject({
      seq: null,
      ts: null,
      snapshot: false,
    });
  });

  it('decodes the new trade fields and the replay flag', () => {
    const event = parseEvent(
      tradeFrame(
        {
          deal: 9,
          order: 10,
          position: 10,
          entry: 'Out',
          sl: 1.05,
          tp: 1.2,
          positionVolume: 0.05,
          timeUtc: '2026-10-29T16:00:00.000Z',
          remainderTicket: 11,
          remainderOf: 0,
        },
        { replay: true, ts: 5 },
      ),
    );
    expect(event.type).toBe('trade');
    if (event.type !== 'trade') return;
    expect(event.replay).toBe(true);
    expect(event.seq).toBeNull();
    expect(event.data).toMatchObject({
      sl: 1.05,
      tp: 1.2,
      positionVolume: 0.05,
      timeUtc: '2026-10-29T16:00:00.000Z',
      remainderTicket: 11,
      remainderOf: 0,
    });
    expect(parseEvent(tradeFrame({ deal: 1 }))).toMatchObject({ replay: false });
  });

  it('decodes modify, order, orders and replayed frames', () => {
    const modify = parseEvent({
      type: 'modify',
      seq: 3,
      data: {
        position: 10,
        symbol: 'EURUSD',
        type: 'Sell',
        volume: 0.1,
        price: 1.1,
        sl: 1.12,
        tp: 1.05,
        magic: 7,
        comment: 'c',
        time: '2026-10-29T18:00:01Z',
      },
    });
    expect(modify.type).toBe('modify');
    if (modify.type === 'modify') {
      expect(modify.data.sl).toBe(1.12);
      expect(modify.data.timeUtc).toBeNull();
      expect(modify.seq).toBe(3);
    }

    const order = parseEvent({
      type: 'order',
      seq: 1,
      data: { ...PENDING, event: 'triggered', position: 9001 },
    });
    expect(order.type).toBe('order');
    if (order.type === 'order') {
      expect(order.data.event).toBe(OrderEventKind.TRIGGERED);
      expect(order.data.position).toBe(9001);
      expect(order.data.ticket).toBe(501);
      expect(order.data.expirationMode).toBe('gtc');
    }

    const orders = parseEvent({ type: 'orders', snapshot: true, data: [PENDING] });
    expect(orders.type).toBe('orders');
    if (orders.type === 'orders') {
      expect(orders.snapshot).toBe(true);
      expect(orders.data[0]).toEqual(PENDING);
    }

    expect(
      parseEvent({ type: 'replayed', topic: 'trades', count: 12, truncated: true }),
    ).toEqual({ type: 'replayed', topic: 'trades', count: 12, truncated: true });

    expect(
      parseEvent({
        type: 'warning',
        topic: 'bars',
        symbol: 'EURUSD',
        timeframe: 'M5',
        dropped: 3,
        ts: 9,
      }),
    ).toEqual({
      type: 'warning',
      dropped: 3,
      topic: 'bars',
      symbol: 'EURUSD',
      timeframe: 'M5',
    });
  });
});

describe('since / orders subscriptions', () => {
  it('validates since before sending', async () => {
    const s = stream('ws://127.0.0.1:1/ws');
    await expect(
      s.subscribe('prices', { symbol: 'EURUSD', since: '2026-10-29T18:00:00Z' }),
    ).rejects.toThrow(/only applies to topic 'trades'/);
    await expect(s.subscribeTrades({ since: '' })).rejects.toThrow(ValidationError);
    await expect(s.subscribeTrades({ since: 5 as unknown as string })).rejects.toThrow(
      ValidationError,
    );
  });

  it('sends since on trades and subscribes to orders', async () => {
    const server = await startServer(() => {});
    const s = stream(server.url, { autoReconnect: false });
    await s.connect();
    await s.subscribeTrades({ since: '2026-10-29T18:00:00.123Z' });
    await s.subscribeOrders();
    await s.unsubscribeOrders();
    await until(() => server.received.length === 3);
    await s.close();

    expect(server.received).toEqual([
      { action: 'subscribe', topic: 'trades', since: '2026-10-29T18:00:00.123Z' },
      { action: 'subscribe', topic: 'orders' },
      { action: 'unsubscribe', topic: 'orders' },
    ]);
    expect(StreamTopic.ORDERS).toBe('orders');
  });

  it('emits the new event types to listeners', async () => {
    const server = await startServer((socket) => {
      socket.once('message', () => {
        socket.send(
          JSON.stringify({ type: 'orders', snapshot: true, data: [PENDING] }),
        );
        socket.send(
          JSON.stringify({
            type: 'order',
            seq: 1,
            data: { ...PENDING, event: 'placed' },
          }),
        );
        socket.send(JSON.stringify({ type: 'modify', seq: 2, data: { position: 1 } }));
        socket.send(
          JSON.stringify({
            type: 'replayed',
            topic: 'trades',
            count: 0,
            truncated: false,
          }),
        );
      });
    });
    const s = stream(server.url, { autoReconnect: false });
    const seen: string[] = [];
    s.on('orders', () => seen.push('orders'));
    s.on('order', () => seen.push('order'));
    s.on('modify', () => seen.push('modify'));
    s.on('replayed', () => seen.push('replayed'));
    await s.connect();
    await s.subscribeOrders();
    await until(() => seen.length === 4);
    await s.close();
    expect(seen).toEqual(['orders', 'order', 'modify', 'replayed']);
  });
});

describe('trades resume across a reconnect', () => {
  async function collectTrades(s: Stream, count: number): Promise<TradeEventMessage[]> {
    const trades: TradeEventMessage[] = [];
    for await (const event of s) {
      if (event.type === 'trade') {
        trades.push(event);
        if (trades.length === count) break;
      }
    }
    return trades;
  }

  it('resubscribes from the last delivered deal and drops the overlap', async () => {
    const server = await startServer((socket, index) => {
      socket.once('message', () => {
        if (index === 1) {
          socket.send(
            JSON.stringify(tradeFrame({ deal: 1, time: '2026-10-29T18:00:01.000Z' })),
          );
          socket.send(
            JSON.stringify(tradeFrame({ deal: 2, time: '2026-10-29T18:00:02.500Z' })),
          );
          setTimeout(() => socket.close(), 20);
          return;
        }
        // The replay re-sends deal 2 (at the since moment), then a deal missed
        // while disconnected; deal 3 then also arrives live at the switch-over.
        socket.send(
          JSON.stringify(
            tradeFrame({ deal: 2, time: '2026-10-29T18:00:02.500Z' }, { replay: true }),
          ),
        );
        socket.send(
          JSON.stringify(
            tradeFrame({ deal: 3, time: '2026-10-29T18:00:05.000Z' }, { replay: true }),
          ),
        );
        socket.send(
          JSON.stringify({
            type: 'replayed',
            topic: 'trades',
            count: 2,
            truncated: false,
          }),
        );
        socket.send(
          JSON.stringify(tradeFrame({ deal: 3, time: '2026-10-29T18:00:05.000Z' })),
        );
        socket.send(
          JSON.stringify(tradeFrame({ deal: 4, time: '2026-10-29T18:00:06.000Z' })),
        );
      });
    });

    const s = stream(server.url, { maxReconnectAttempts: 3 });
    await s.connect();
    await s.subscribeTrades();
    const trades = await collectTrades(s, 4);
    await s.close();

    expect(trades.map((t) => t.data.deal)).toEqual([1, 2, 3, 4]);
    expect(trades[2]!.replay).toBe(true);
    expect(server.received).toEqual([
      { action: 'subscribe', topic: 'trades' },
      { action: 'subscribe', topic: 'trades', since: '2026-10-29T18:00:02.500Z' },
    ]);
  });

  it('dedupes MT4 frames by order and entry, keeping the newest time', async () => {
    const server = await startServer((socket, index) => {
      socket.once('message', () => {
        if (index === 1) {
          socket.send(
            JSON.stringify(
              tradeFrame({ order: 70, entry: 'Out', time: '2026-10-29T18:00:09.000Z' }),
            ),
          );
          // The remainder's In carries the original (older) open time.
          socket.send(
            JSON.stringify(
              tradeFrame({
                order: 71,
                entry: 'In',
                remainderOf: 70,
                time: '2026-10-29T10:00:00.000Z',
              }),
            ),
          );
          setTimeout(() => socket.close(), 20);
          return;
        }
        socket.send(
          JSON.stringify(
            tradeFrame(
              { order: 70, entry: 'Out', time: '2026-10-29T18:00:09.000Z' },
              { replay: true },
            ),
          ),
        );
        socket.send(
          JSON.stringify(
            tradeFrame({ order: 71, entry: 'Out', time: '2026-10-29T18:00:12.000Z' }),
          ),
        );
      });
    });

    const s = new Stream({
      wsUrl: server.url,
      apiKey: 'k',
      platform: 'mt4',
      maxReconnectAttempts: 3,
    });
    await s.connect();
    await s.subscribeTrades();
    const trades = await collectTrades(s, 3);
    await s.close();

    expect(trades.map((t) => `${t.data.order}:${t.data.entry}`)).toEqual([
      '70:Out',
      '71:In',
      '71:Out',
    ]);
    expect(server.received[1]).toEqual({
      action: 'subscribe',
      topic: 'trades',
      since: '2026-10-29T18:00:09.000Z',
    });
  });

  it("falls back to the caller's since when no deal arrived yet", async () => {
    const server = await startServer((socket, index) => {
      socket.once('message', () => {
        if (index === 1) {
          setTimeout(() => socket.close(), 20);
          return;
        }
        socket.send(JSON.stringify(tradeFrame({ deal: 1 })));
      });
    });

    const s = stream(server.url, { maxReconnectAttempts: 3 });
    await s.connect();
    await s.subscribeTrades({ since: '2026-10-29T17:00:00.000Z' });
    await collectTrades(s, 1);
    await s.close();

    expect(server.received).toEqual([
      { action: 'subscribe', topic: 'trades', since: '2026-10-29T17:00:00.000Z' },
      { action: 'subscribe', topic: 'trades', since: '2026-10-29T17:00:00.000Z' },
    ]);
  });

  it('starts afresh after an unsubscribe', async () => {
    const server = await startServer((socket, index) => {
      socket.on('message', (raw) => {
        const payload = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (index !== 1 || payload['action'] !== 'subscribe') return;
        if (server.received.length === 1) {
          socket.send(
            JSON.stringify(tradeFrame({ deal: 1, time: '2026-10-29T18:00:01Z' })),
          );
        } else {
          setTimeout(() => socket.close(), 20);
        }
      });
    });

    const s = stream(server.url, { maxReconnectAttempts: 3 });
    await s.connect();
    await s.subscribeTrades();
    await collectTrades(s, 1);
    await s.unsubscribeTrades();
    await s.subscribeTrades();
    await until(() => server.connections === 2 && server.received.length === 4);
    await s.close();

    expect(server.received.at(-1)).toEqual({ action: 'subscribe', topic: 'trades' });
  });

  it('delivers a deliberate replay after an unsubscribe', async () => {
    const server = await startServer((socket) => {
      socket.on('message', (raw) => {
        const payload = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (payload['action'] !== 'subscribe') return;
        const replay = payload['since'] !== undefined;
        socket.send(
          JSON.stringify(
            tradeFrame(
              { deal: 1, time: '2026-10-29T18:00:01Z' },
              replay ? { replay } : {},
            ),
          ),
        );
      });
    });

    const s = stream(server.url, { maxReconnectAttempts: 3 });
    await s.connect();
    await s.subscribeTrades();
    await collectTrades(s, 1);
    await s.unsubscribeTrades();
    await s.subscribeTrades({ since: '2026-10-29T18:00:00Z' });
    const [again] = await collectTrades(s, 1);
    await s.close();

    expect(again?.data.deal).toBe(1);
    expect(again?.replay).toBe(true);
  });

  it('with resumeTrades: false, resubscribes plainly and keeps duplicates', async () => {
    const server = await startServer((socket, index) => {
      socket.once('message', () => {
        socket.send(
          JSON.stringify(tradeFrame({ deal: 1, time: '2026-10-29T18:00:01Z' })),
        );
        if (index === 1) setTimeout(() => socket.close(), 20);
      });
    });

    const s = stream(server.url, { maxReconnectAttempts: 3, resumeTrades: false });
    await s.connect();
    await s.subscribeTrades({ since: '2026-10-29T17:00:00Z' });
    const trades = await collectTrades(s, 2);
    await s.close();

    expect(trades.map((t) => t.data.deal)).toEqual([1, 1]);
    expect(server.received).toEqual([
      { action: 'subscribe', topic: 'trades', since: '2026-10-29T17:00:00Z' },
      { action: 'subscribe', topic: 'trades' },
    ]);
  });

  it('passes resumeTrades through the client factory', () => {
    const fx = new FxSocket({ apiKey: 'k' });
    const s = fx.stream(
      {
        id: 'a',
        nickname: '',
        platform: 'mt5',
        server: 'Demo',
        login: 1,
        status: 'connected',
        error: '',
        restUrl: 'https://term.test',
        wsUrl: 'wss://term.test/ws',
        proxyAddress: '',
        proxyType: '',
        proxyLocalPort: null,
        tradeEaSymbol: '',
        createdAt: new Date(),
        hasTerminal: true,
      },
      { resumeTrades: false },
    );
    expect((s as unknown as { resumeTrades: boolean }).resumeTrades).toBe(false);
  });
});
