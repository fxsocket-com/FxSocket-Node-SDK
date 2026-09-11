/**
 * Integration tests against the real FxSocket API.
 *
 * These are opt-in and never run in `npm test`:
 *
 * ```bash
 * FXSOCKET_API_KEY=fxs_live_… npm run test:live
 * ```
 *
 * They use accounts that are already linked to the key. To have the suite link
 * one itself, set `FXSOCKET_TEST_SERVER`, `FXSOCKET_TEST_LOGIN` and
 * `FXSOCKET_TEST_PASSWORD` (and `FXSOCKET_TEST_PLATFORM`, default `mt5`).
 *
 * **They place real orders** on whatever accounts the key can see, so point the
 * key at demo accounts. Trading steps are skipped unless
 * `FXSOCKET_TEST_TRADING=1`; the volume defaults to the symbol's minimum.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  FxSocket,
  ForbiddenError,
  TerminalNotReadyError,
  TerminalTimeoutError,
  ValidationError,
  type Account,
  type StreamEvent,
  type SymbolInfo,
  type TerminalClient,
} from '../../src/index.js';

const API_KEY = process.env['FXSOCKET_API_KEY'];
const TRADING = process.env['FXSOCKET_TEST_TRADING'] === '1';
const KEY_TESTS = process.env['FXSOCKET_TEST_READONLY_KEYS'] === '1';
const UNLINK = process.env['FXSOCKET_TEST_UNLINK'] === '1';
const SYMBOL = process.env['FXSOCKET_TEST_SYMBOL'] ?? 'EURUSD';
const MAGIC = 990011;

const live = API_KEY ? describe : describe.skip;
const trading = API_KEY && TRADING ? describe : describe.skip;

let fx: FxSocket;
let accounts: Account[] = [];
let account: Account;
let terminal: TerminalClient;
let symbol = SYMBOL;
let spec: SymbolInfo;
let linkedByUs: Account | undefined;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Poll an account until it is connected with a terminal, or time out. */
async function waitForTerminal(id: string, timeoutMs = 600_000): Promise<Account> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = await fx.accounts.get(id);
    if (current.status === 'connected' && current.hasTerminal) return current;
    if (current.status === 'error') {
      throw new Error(`account ${id} failed to connect: ${current.error}`);
    }
    if (Date.now() > deadline) throw new Error(`account ${id} never became ready`);
    await sleep(5_000);
  }
}

/** Wait for the terminal's own health probe to report it can trade. */
async function waitForTradeReady(
  term: TerminalClient,
  timeoutMs = 180_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const health = await term.status();
    if (health.isReady && health.bridge.tradeEaReady && health.account.tradeAllowed)
      return;
    if (Date.now() > deadline) {
      throw new Error(`terminal never became trade-ready (status=${health.status})`);
    }
    await sleep(5_000);
  }
}

beforeAll(async () => {
  if (!API_KEY) return;
  fx = new FxSocket({ apiKey: API_KEY });

  const server = process.env['FXSOCKET_TEST_SERVER'];
  const login = process.env['FXSOCKET_TEST_LOGIN'];
  const password = process.env['FXSOCKET_TEST_PASSWORD'];
  if (server && login && password) {
    const existing = (await fx.accounts.list()).find(
      (a) => a.login === Number(login) && a.server === server,
    );
    if (existing === undefined) {
      linkedByUs = await fx.accounts.create({
        server,
        login: Number(login),
        password,
        platform: (process.env['FXSOCKET_TEST_PLATFORM'] as 'mt4' | 'mt5') ?? 'mt5',
        nickname: 'node-sdk-live',
      });
      await waitForTerminal(linkedByUs.id);
    }
  }

  accounts = (await fx.accounts.list()).filter((a) => a.hasTerminal);
  if (accounts.length === 0) {
    throw new Error('no connected accounts available for the live suite');
  }
  account = accounts[0]!;
  terminal = fx.terminal(account);

  const symbols = await terminal.symbols();
  symbol = symbols.includes(SYMBOL) ? SYMBOL : symbols[0]!;
  spec = await terminal.symbolInfo(symbol);
}, 900_000);

afterAll(async () => {
  if (!API_KEY) return;
  if (UNLINK && linkedByUs !== undefined) {
    await fx.accounts.delete(linkedByUs.id);
  }
  await fx.close();
}, 120_000);

// --------------------------------------------------------------------------- //
// Management
// --------------------------------------------------------------------------- //

live('management', () => {
  it('lists accounts with terminal endpoints', async () => {
    expect(accounts.length).toBeGreaterThan(0);
    for (const a of accounts) {
      expect(a.id).not.toBe('');
      expect(['mt4', 'mt5']).toContain(a.platform);
      expect(a.restUrl.startsWith('http')).toBe(true);
      expect(a.wsUrl.startsWith('ws')).toBe(true);
      expect(a.createdAt.getTime()).not.toBeNaN();
    }
  });

  it('fetches one account by id', async () => {
    const fetched = await fx.accounts.get(account.id);
    expect(fetched.id).toBe(account.id);
    expect(fetched.login).toBe(account.login);
  });

  it('reads the wallet', async () => {
    const wallet = await fx.wallet.get();
    expect(Number.isInteger(wallet.balanceEurCents)).toBe(true);
    expect(wallet.balanceEur).toBeCloseTo(wallet.balanceEurCents / 100, 6);
    expect(Array.isArray(wallet.upcoming)).toBe(true);
  });

  it('lists private servers', async () => {
    const servers = await fx.privateServers.list();
    expect(Array.isArray(servers)).toBe(true);
    for (const server of servers) {
      expect(server.freeSlots).toBe(
        Math.max(server.purchasedSlots - server.usedSlots, 0),
      );
    }
  });

  it('rejects an unknown account id with 404', async () => {
    await expect(
      fx.accounts.get('00000000-0000-0000-0000-000000000000'),
    ).rejects.toMatchObject({ status: 404 });
  });
});

// --------------------------------------------------------------------------- //
// Terminal — read-only
// --------------------------------------------------------------------------- //

live('terminal reads', () => {
  it('reports health', async () => {
    const health = await terminal.status();
    expect(['ready', 'starting', 'degraded', 'down']).toContain(health.status);
    expect(health.broker.connected).toBe(true);
    expect(health.account.login).toBe(account.login);
  });

  it('answers the health probes', async () => {
    const checks = await terminal.healthz();
    expect(['ready', 'starting', 'degraded', 'down']).toContain(checks.status);
    expect(typeof (await terminal.livez()).terminal).toBe('boolean');
  });

  it('reads the account summary and info', async () => {
    const summary = await terminal.accountSummary();
    expect(typeof summary.balance).toBe('number');
    expect(typeof summary.equity).toBe('number');
    expect(summary.currency).not.toBe('');

    const info = await terminal.accountInfo();
    expect(info.login).toBe(account.login);
    expect(info.currency).toBe(summary.currency);
  });

  it('lists symbols and quotes one', async () => {
    const symbols = await terminal.symbols();
    expect(symbols.length).toBeGreaterThan(0);

    const quote = await terminal.quote(symbol);
    expect(quote.symbol).toBe(symbol);
    expect(quote.ask).toBeGreaterThan(0);
    expect(quote.bid).toBeGreaterThan(0);
    // Terminal timestamps stay strings (broker server time).
    expect(typeof quote.time).toBe('string');
  });

  it('reads the symbol specification', async () => {
    expect(spec.symbol).toBe(symbol);
    expect(spec.digits).toBeGreaterThan(0);
    expect(spec.volumeMin).toBeGreaterThan(0);
    expect(spec.volumeStep).toBeGreaterThan(0);
    expect(Array.isArray(spec.sessions)).toBe(true);
    expect(Array.isArray(spec.commissions)).toBe(true);
  });

  it('reads OHLC history for a bounded range', async () => {
    // Always bound the range: an unbounded request asks the broker for its
    // entire history for that timeframe, which usually exceeds the terminal's
    // own deadline and comes back as a 504.
    const from = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const bars = await terminal.priceHistory(symbol, 'M5', { from });
    expect(bars.length).toBeGreaterThan(0);

    const bar = bars.at(-1)!;
    expect(bar.high).toBeGreaterThanOrEqual(bar.low);
    expect(bar.high).toBeGreaterThanOrEqual(bar.open);
    expect(bar.low).toBeLessThanOrEqual(bar.close);
    expect(typeof bar.time).toBe('string');
  }, 120_000);

  it('surfaces an over-large history request as a terminal timeout', async () => {
    // Documented behaviour rather than an SDK failure: the unbounded form can
    // exceed the terminal's deadline, and the SDK must surface that as a typed
    // error instead of retrying or hanging.
    try {
      const bars = await terminal.priceHistory(symbol, 'M5');
      expect(Array.isArray(bars)).toBe(true);
    } catch (error) {
      expect(error).toBeInstanceOf(TerminalTimeoutError);
      expect((error as TerminalTimeoutError).status).toBe(504);
    }
  }, 120_000);

  it('reads the server timezone', async () => {
    const tz = await terminal.serverTimezone();
    expect(typeof tz.serverTime).toBe('string');
    expect(Number.isInteger(tz.utcOffsetSeconds)).toBe(true);
  });

  it('reads open orders and history', async () => {
    expect(Array.isArray(await terminal.openedOrders())).toBe(true);
    expect(Array.isArray(await terminal.orderHistory())).toBe(true);
    expect(Array.isArray(await terminal.positionHistory())).toBe(true);
  });

  it('calculates margin and profit', async () => {
    const quote = await terminal.quote(symbol);
    const margin = await terminal.calcMargin(symbol, 'Buy', spec.volumeMin, quote.ask);
    expect(margin.margin).toBeGreaterThan(0);
    expect(margin.currency).not.toBe('');

    const profit = await terminal.calcProfit(
      symbol,
      'Buy',
      spec.volumeMin,
      quote.ask,
      quote.ask * 1.01,
    );
    expect(profit.profit).toBeGreaterThan(0);
  });

  it('raises TerminalNotReadyError for an account without an endpoint', () => {
    expect(() => fx.terminal({ ...account, restUrl: '' })).toThrow(
      TerminalNotReadyError,
    );
  });
});

// --------------------------------------------------------------------------- //
// Streaming
// --------------------------------------------------------------------------- //

live('streaming', () => {
  it('receives ticks and account updates', async () => {
    const stream = fx.stream(account);
    await stream.connect();
    await stream.subscribePrices(symbol);
    await stream.subscribeAccount();
    await stream.subscribeTerminal();

    const seen = new Set<string>();
    const deadline = Date.now() + 60_000;
    try {
      for await (const event of stream) {
        seen.add(event.type);
        if (event.type === 'tick') {
          expect(event.data.ask).toBeGreaterThan(0);
        }
        if (seen.has('tick') || seen.has('account') || seen.has('terminal')) {
          if (seen.has('terminal') && (seen.has('tick') || seen.has('account'))) break;
        }
        if (Date.now() > deadline) break;
      }
    } finally {
      await stream.close();
    }

    // `terminal` is pushed about once a second, so it always arrives; ticks only
    // arrive while the market is open.
    expect(seen.has('terminal') || seen.has('account')).toBe(true);
  }, 90_000);

  it('acknowledges a subscription and echoes the list', async () => {
    const stream = fx.stream(account);
    await stream.connect();
    await stream.subscribePrices(symbol);
    await stream.listSubscriptions();

    const events: StreamEvent[] = [];
    const deadline = Date.now() + 30_000;
    try {
      for await (const event of stream) {
        events.push(event);
        if (events.some((e) => e.type === 'subscriptions')) break;
        if (Date.now() > deadline) break;
      }
    } finally {
      await stream.close();
    }

    expect(
      events.some((e) => e.type === 'subscribed' || e.type === 'subscriptions'),
    ).toBe(true);
  }, 60_000);

  it('reports a bad subscription as an error frame, not a throw', async () => {
    const stream = fx.stream(account);
    await stream.connect();
    await stream.subscribePrices('NOT_A_REAL_SYMBOL_XYZ');

    const events: StreamEvent[] = [];
    const deadline = Date.now() + 20_000;
    try {
      for await (const event of stream) {
        events.push(event);
        if (event.type === 'error' || event.type === 'subscribed') break;
        if (Date.now() > deadline) break;
      }
    } finally {
      await stream.close();
    }
    expect(events.length).toBeGreaterThan(0);
  }, 45_000);
});

// --------------------------------------------------------------------------- //
// Trading (opt-in — places real orders)
// --------------------------------------------------------------------------- //

trading('terminal trading', () => {
  beforeAll(async () => {
    await waitForTradeReady(terminal);
  }, 200_000);

  it('opens, modifies and closes a market position', async () => {
    const quote = await terminal.quote(symbol);
    const opened = await terminal.orderSend({
      symbol,
      operation: 'Buy',
      volume: spec.volumeMin,
      slippage: 50,
      comment: 'node-sdk-live',
      magic: MAGIC,
    });

    expect(opened.retcode).toBeGreaterThan(0);
    if (!opened.success) {
      throw new Error(`order rejected: ${opened.retcode} ${opened.retcodeDescription}`);
    }
    expect(opened.order).toBeGreaterThan(0);

    const open = await terminal.openedOrders();
    const row = open.find((o) => o.ticket === opened.order);
    expect(row).toBeDefined();
    expect(row!.isPending).toBe(false);
    expect(row!.magic).toBe(MAGIC);

    // A stop-loss well below the market, then the same one again: the repeat
    // must come back as a benign no-op that still counts as effective.
    const stop = Number((quote.bid * 0.97).toFixed(spec.digits));
    const modified = await terminal.orderModify(opened.order, { stopLoss: stop });
    expect(modified.isEffective).toBe(true);

    const repeat = await terminal.orderModify(opened.order, { stopLoss: stop });
    expect(repeat.isEffective).toBe(true);

    const cleared = await terminal.orderModify(opened.order, { clearStopLoss: true });
    expect(cleared.isEffective).toBe(true);

    const closed = await terminal.orderClose(opened.order, { slippage: 50 });
    expect(closed.isEffective).toBe(true);

    const remaining = await terminal.openedOrders();
    expect(remaining.some((o) => o.ticket === opened.order)).toBe(false);
  }, 180_000);

  it('places and deletes a pending order', async () => {
    const quote = await terminal.quote(symbol);
    const price = Number((quote.bid * 0.9).toFixed(spec.digits));
    const placed = await terminal.orderSend({
      symbol,
      operation: 'BuyLimit',
      volume: spec.volumeMin,
      price,
      comment: 'node-sdk-pending',
      magic: MAGIC,
    });
    if (!placed.success) {
      throw new Error(
        `pending rejected: ${placed.retcode} ${placed.retcodeDescription}`,
      );
    }

    const open = await terminal.openedOrders();
    const row = open.find((o) => o.ticket === placed.order);
    expect(row?.isPending).toBe(true);

    const summary = await terminal.closeAll({
      symbol,
      magic: MAGIC,
      deletePending: true,
    });
    expect(summary.requested).toBeGreaterThan(0);

    const remaining = await terminal.openedOrders();
    expect(remaining.some((o) => o.ticket === placed.order)).toBe(false);
  }, 180_000);

  it('records the round-trip in history', async () => {
    const history = await terminal.orderHistory();
    const mine = history.filter((row) => row.magic === MAGIC);
    // The entry deal carries our magic; MT5 exits usually carry 0.
    expect(mine.length).toBeGreaterThan(0);
    expect(mine[0]!.position).toBeGreaterThan(0);
  }, 60_000);
});

trading('multi-account trading', () => {
  it('fans one order out and flattens it again', async () => {
    const targets = accounts.slice(0, Math.min(accounts.length, 3));
    const key = `node-sdk-live-${Date.now()}`;

    const sent = await fx.orders.send(
      targets.map((a) => ({ accountId: a })),
      {
        defaults: {
          symbol,
          operation: 'buy',
          volume: spec.volumeMin,
          slippage: 50,
          magic: MAGIC,
          comment: 'node-sdk-batch',
        },
        idempotencyKey: key,
      },
    );

    expect(sent.batchId).not.toBe('');
    expect(sent.results).toHaveLength(targets.length);
    expect(sent.summary.requested).toBe(targets.length);
    expect(sent.idempotentReplay).toBe(false);
    for (const leg of sent.results) {
      expect(targets.some((a) => a.id === leg.accountId)).toBe(true);
    }

    // Replaying the identical batch must return the stored reply, not trade.
    const replay = await fx.orders.send(
      targets.map((a) => ({ accountId: a })),
      {
        defaults: {
          symbol,
          operation: 'buy',
          volume: spec.volumeMin,
          slippage: 50,
          magic: MAGIC,
          comment: 'node-sdk-batch',
        },
        idempotencyKey: key,
      },
    );
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.batchId).toBe(sent.batchId);

    const closed = await fx.orders.close(targets, {
      defaults: { symbol, symbolMatch: 'base', kind: 'any', magic: MAGIC },
      idempotencyKey: `${key}-close`,
    });
    expect(closed.results).toHaveLength(targets.length);
    for (const leg of closed.results) {
      expect([
        'closed',
        'partial',
        'failed',
        'nothing_matched',
        'unavailable',
        'unreachable',
        'timeout',
        'invalid',
      ]).toContain(leg.status);
    }

    // Nothing of ours should be left open anywhere.
    for (const target of targets) {
      const open = await fx.terminal(target).openedOrders();
      expect(open.filter((o) => o.magic === MAGIC)).toEqual([]);
    }
  }, 300_000);

  it('rejects a malformed batch before sending it', async () => {
    await expect(
      fx.orders.send([{ accountId: account.id }], {
        defaults: { symbol, operation: 'buy' },
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('rejects an unknown account id', async () => {
    await expect(
      fx.orders.send(['00000000-0000-0000-0000-000000000000'], {
        defaults: { symbol, operation: 'buy', volume: spec.volumeMin },
      }),
    ).rejects.toMatchObject({ code: 'unknown_account' });
  }, 60_000);
});

// --------------------------------------------------------------------------- //
// Read-only keys (opt-in — creating one restarts the terminals in its scope)
// --------------------------------------------------------------------------- //

live('read-only keys', () => {
  it('lists existing keys', async () => {
    const keys = await fx.readonlyKeys.list();
    expect(Array.isArray(keys)).toBe(true);
    for (const key of keys) {
      expect(key.key.startsWith('fxs_ro_')).toBe(true);
      expect(key.accountIds).toEqual(key.accounts.map((a) => a.id));
    }
  });

  it.runIf(KEY_TESTS)(
    'creates, scopes, rotates and revokes a key',
    async () => {
      const created = await fx.readonlyKeys.create({
        name: `node-sdk-live-${Date.now()}`,
        accounts: [account],
      });
      expect(created.isScoped).toBe(true);
      expect(created.accountIds).toEqual([account.id]);

      const renamed = await fx.readonlyKeys.update(created, {
        name: 'node-sdk-renamed',
      });
      expect(renamed.name).toBe('node-sdk-renamed');

      const rotated = await fx.readonlyKeys.rotate(created);
      expect(rotated.key).not.toBe(created.key);

      // A read-only key may read, but not trade.
      const ro = new FxSocket({ apiKey: rotated.key });
      try {
        expect(Array.isArray(await ro.accounts.list())).toBe(true);
        await expect(
          ro.orders.send([account.id], {
            defaults: { symbol, operation: 'buy', volume: spec.volumeMin },
          }),
        ).rejects.toThrow(ForbiddenError);
      } finally {
        await ro.close();
      }

      await fx.readonlyKeys.delete(created);
      await expect(fx.readonlyKeys.get(created.id)).rejects.toMatchObject({
        status: 404,
      });
    },
    300_000,
  );
});
