/** Tests for the terminal REST client. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  checkTimeframe,
  ClientOrderIdReusedError,
  coerceOperation,
  coerceTimeframe,
  decodeBridgeHealth,
  FxSocket,
  MT5_ONLY_TIMEFRAMES,
  OrderOperation,
  TerminalClient,
  TerminalNotReadyError,
  TerminalTimeoutError,
  Timeframe,
  TradeAbandonedError,
  TradeOutcomeUnknownError,
  UnsupportedOnPlatformError,
  ValidationError,
  type Account,
  type Platform,
} from './helpers/sdk.js';
import { ORDER_OK } from './helpers/fixtures.js';
import { HttpMock, TERM } from './helpers/mock-http.js';

let mock: HttpMock;

function terminal(platform: Platform = 'mt5'): TerminalClient {
  return new TerminalClient({
    baseUrl: TERM,
    apiKey: 'fxs_live_k',
    platform,
    dispatcher: mock.dispatcher,
  });
}

function account(restUrl = TERM, platform: Platform = 'mt5'): Account {
  return {
    id: 'acc-1',
    nickname: '',
    platform,
    server: 'Demo',
    login: 1,
    status: 'connected',
    error: '',
    restUrl,
    wsUrl: 'wss://term.test/ws',
    proxyAddress: '',
    proxyType: '',
    proxyLocalPort: null,
    tradeEaSymbol: '',
    createdAt: new Date('2026-06-22T16:53:56Z'),
    hasTerminal: restUrl !== '',
  };
}

beforeEach(() => {
  mock = new HttpMock(TERM);
});

afterEach(async () => {
  await mock.close();
});

// --------------------------------------------------------------------------- //
// Coercion helpers
// --------------------------------------------------------------------------- //

describe('coerceOperation', () => {
  it.each([
    ['buy', OrderOperation.BUY],
    ['Buy', OrderOperation.BUY],
    ['buy_limit', OrderOperation.BUY_LIMIT],
    ['BUY-STOP-LIMIT', OrderOperation.BUY_STOP_LIMIT],
    [OrderOperation.SELL, OrderOperation.SELL],
  ])('normalizes %s', (value, expected) => {
    expect(coerceOperation(value)).toBe(expected);
  });

  it('rejects an unknown operation', () => {
    expect(() => coerceOperation('teleport')).toThrow(ValidationError);
    expect(() => coerceOperation('teleport')).toThrow(/Unknown order operation/);
  });
});

describe('coerceTimeframe', () => {
  it.each([
    ['M5', Timeframe.M5],
    ['m5', Timeframe.M5],
    ['5min', Timeframe.M5],
    ['1h', Timeframe.H1],
    ['1d', Timeframe.D1],
    ['1month', Timeframe.MN1],
    [Timeframe.H4, Timeframe.H4],
  ])('normalizes %s', (value, expected) => {
    expect(coerceTimeframe(value)).toBe(expected);
  });

  it('rejects an unknown timeframe', () => {
    expect(() => coerceTimeframe('7s')).toThrow(/Unknown timeframe/);
  });

  it('lists exactly the timeframes the terminal API accepts', () => {
    // The nine labels the MT4 and MT5 terminal APIs parse (REST + `bars`).
    expect(Object.values(Timeframe)).toEqual([
      'M1',
      'M5',
      'M15',
      'M30',
      'H1',
      'H4',
      'D1',
      'W1',
      'MN1',
    ]);
  });

  it.each(['H6', 'M2', 'h12', '2h', '3min'])(
    'rejects %s, which the terminal API does not serve',
    (value) => {
      expect(() => coerceTimeframe(value)).toThrow(ValidationError);
      expect(() => coerceTimeframe(value)).toThrow(/M1, M5, M15/);
    },
  );

  it('keeps the deprecated platform shims harmless', () => {
    expect(MT5_ONLY_TIMEFRAMES.size).toBe(0);
    expect(() => checkTimeframe(Timeframe.M5, 'mt4')).not.toThrow();
    expect(() => checkTimeframe('H6' as Timeframe, 'mt5')).toThrow(ValidationError);
  });
});

// --------------------------------------------------------------------------- //
// Parsing — camelCase payloads, string timestamps
// --------------------------------------------------------------------------- //

describe('account state', () => {
  it('decodes the account summary', async () => {
    mock.get('/AccountSummary', {
      status: 200,
      json: {
        balance: 100000.0,
        credit: 0.0,
        profit: 12.5,
        equity: 100012.5,
        margin: 500.0,
        freeMargin: 99512.5,
        marginLevel: 2002.5,
        leverage: 200,
        currency: 'USD',
        type: 'Demo',
      },
    });
    const summary = await terminal().accountSummary();
    expect(summary.freeMargin).toBe(99512.5);
    expect(summary.marginLevel).toBe(2002.5);
    expect(summary.leverage).toBe(200);
  });

  it('decodes the account info', async () => {
    mock.get('/AccountInfo', {
      status: 200,
      json: {
        name: 'Jane',
        login: 1150125,
        server: 'VTMarkets-Demo',
        company: 'VT',
        currency: 'USD',
        currencyDigits: 2,
        leverage: 200,
        type: 'Demo',
        marginMode: 'Hedging',
        marginSoMode: 'Percent',
        marginCallLevel: 100.0,
        stopOutLevel: 50.0,
        tradeAllowed: true,
        tradeExpert: true,
        limitOrders: 0,
        fifoClose: false,
      },
    });
    const info = await terminal().accountInfo();
    expect(info.marginSoMode).toBe('Percent');
    expect(info.fifoClose).toBe(false);
    expect(info.currencyDigits).toBe(2);
  });

  it('marks pending rows and keeps timestamps as strings', async () => {
    mock.get('/OpenedOrders', {
      status: 200,
      json: [
        {
          ticket: 1,
          symbol: 'EURUSD',
          type: 'Buy',
          kind: 'Position',
          lots: 0.1,
          openPrice: 1.08,
          currentPrice: 1.085,
          stopLoss: 0.0,
          takeProfit: 0.0,
          swap: 0.0,
          profit: 5.0,
          magic: 0,
          comment: '',
          openTime: '2026-06-22T15:30:00Z',
        },
        {
          ticket: 2,
          symbol: 'EURUSD',
          type: 'BuyLimit',
          kind: 'Pending',
          lots: 0.1,
          openPrice: 1.07,
          currentPrice: 1.07,
          stopLoss: 0.0,
          takeProfit: 0.0,
          swap: 0.0,
          profit: 0.0,
          magic: 0,
          comment: '',
          openTime: '2026-06-22T15:30:00Z',
        },
      ],
    });
    const orders = await terminal().openedOrders();
    expect(orders.map((o) => o.isPending)).toEqual([false, true]);
    // Timestamps stay raw strings (broker server time), never Date.
    expect(typeof orders[0]!.openTime).toBe('string');
  });

  it('defaults a missing history `position` to 0', async () => {
    mock.get('/OrderHistory', {
      status: 200,
      json: [
        {
          ticket: 14541780,
          order: 13173527,
          position: 13173524,
          symbol: 'EURUSD',
          type: 'Sell',
          entry: 'Out',
          volume: 0.01,
          price: 1.16635,
          profit: -0.02,
          commission: -0.04,
          swap: 0.0,
          magic: 0,
          comment: '',
          time: '2026-08-19T18:53:47.000Z',
        },
        {
          ticket: 14541777,
          order: 13173524,
          symbol: 'EURUSD',
          type: 'Buy',
          entry: 'In',
          volume: 0.01,
          price: 1.16637,
          profit: 0.0,
          commission: -0.04,
          swap: 0.0,
          magic: 1000999,
          comment: 'CN_9999_8888',
          time: '2026-08-19T18:53:41.000Z',
        },
      ],
    });
    const rows = await terminal().orderHistory();
    expect(rows[0]!.position).toBe(13173524);
    expect(rows[1]!.position).toBe(0);
  });

  it('sends date bounds on position history', async () => {
    const route = mock.get('/PositionHistory', {
      status: 200,
      json: [
        {
          positionId: 5,
          symbol: 'EURUSD',
          type: 'Buy',
          volume: 0.1,
          openTime: '2026-06-22T15:00:00Z',
          openPrice: 1.08,
          closeTime: '2026-06-22T16:00:00Z',
          closePrice: 1.085,
          profit: 5.0,
          swap: 0.0,
          commission: -1.0,
          netProfit: 4.0,
          magic: 0,
          comment: '',
        },
      ],
    });
    const rows = await terminal().positionHistory({
      from: '2026-06-01',
      to: '2026-06-23',
    });
    expect(rows[0]!.netProfit).toBe(4.0);
    expect(route.last.query.get('from')).toBe('2026-06-01');
    expect(route.last.query.get('to')).toBe('2026-06-23');
  });

  it('decodes the server timezone', async () => {
    mock.get('/ServerTimezone', {
      status: 200,
      json: { serverTime: '2026-06-22T18:00:00Z', utcOffsetSeconds: 7200 },
    });
    const tz = await terminal().serverTimezone();
    expect(tz.utcOffsetSeconds).toBe(7200);
    expect(typeof tz.serverTime).toBe('string');
  });
});

describe('health', () => {
  it('decodes the nested /status payload', async () => {
    mock.get('/status', {
      status: 200,
      json: {
        status: 'ready',
        terminal: { alive: true, build: 5836, pingMs: 108 },
        broker: { connected: true, server: 'VTMarkets-Demo' },
        account: {
          loggedIn: true,
          login: 1150125,
          currency: 'USD',
          type: 'Demo',
          tradeAllowed: true,
        },
        bridge: { version: '0.5.0', tradeEaReady: true, symbolsSynced: true },
        serverTime: '2026-06-22T16:53:56.000Z',
      },
    });
    const health = await terminal().status();
    expect(health.isReady).toBe(true);
    expect(health.terminal.pingMs).toBe(108);
    expect(health.account.loggedIn).toBe(true);
    expect(health.bridge.tradeEaReady).toBe(true);
    // Pre-0.10 bridges omit the heartbeat — it defaults to -1 (never/unknown).
    expect(health.bridge.tradeEaHeartbeatAgeMs).toBe(-1);
  });

  it('decodes the bridge heartbeat when present', () => {
    const bridge = decodeBridgeHealth({
      version: '0.10.0',
      tradeEaReady: true,
      tradeEaHeartbeatAgeMs: 8,
      symbolsSynced: true,
    });
    expect(bridge.tradeEaHeartbeatAgeMs).toBe(8);
  });

  it('parses a 503 body from /healthz instead of raising', async () => {
    mock.get('/healthz', {
      status: 503,
      json: { status: 'starting', terminal: true, broker: true, account: false },
    });
    const checks = await terminal().healthz();
    expect(checks.status).toBe('starting');
    expect(checks.account).toBe(false);
  });

  it('parses a 503 body from /livez instead of raising', async () => {
    mock.get('/livez', {
      status: 503,
      json: { status: 'down', terminal: false, broker: false, account: false },
    });
    expect((await terminal().livez()).status).toBe('down');
  });

  it('still raises on a non-probe failure status', async () => {
    mock.get('/healthz', { status: 401, json: { detail: 'nope' } });
    await expect(terminal().healthz()).rejects.toThrow(/nope/);
  });
});

// --------------------------------------------------------------------------- //
// Market data
// --------------------------------------------------------------------------- //

describe('market data', () => {
  it('sends the canonical timeframe and omits absent bounds', async () => {
    const route = mock.get('/PriceHistory', { status: 200, json: [] });
    await terminal().priceHistory('EURUSD', '5min', { from: '2026-06-01' });

    const { query } = route.last;
    expect(query.get('timeframe')).toBe('M5');
    expect(query.get('symbol')).toBe('EURUSD');
    expect(query.get('from')).toBe('2026-06-01');
    expect(query.has('to')).toBe(false);
  });

  it.each<Platform>(['mt4', 'mt5'])(
    'rejects an unsupported timeframe on %s before any request',
    async (platform) => {
      const route = mock.get('/PriceHistory', { status: 200, json: [] });
      await expect(terminal(platform).priceHistory('EURUSD', 'H6')).rejects.toThrow(
        ValidationError,
      );
      expect(route.called).toBe(false);
    },
  );

  it('decodes a quote', async () => {
    mock.get('/getQuote', {
      status: 200,
      json: {
        symbol: 'EURUSD',
        bid: 1.0849,
        ask: 1.0851,
        time: '2026-06-22T16:53:56Z',
        last: 0.0,
        volume: 0,
      },
    });
    const quote = await terminal().quote('EURUSD');
    expect(quote.ask).toBe(1.0851);
    expect(typeof quote.time).toBe('string');
  });

  it('decodes symbol info and defaults commissions/sessions to empty', async () => {
    mock.get('/SymbolInfo', {
      status: 200,
      json: {
        symbol: 'EURUSD',
        description: 'Euro vs US Dollar',
        digits: 5,
        point: 0.00001,
        tickSize: 0.00001,
        tickValue: 1.0,
        contractSize: 100000.0,
        volumeMin: 0.01,
        volumeMax: 500.0,
        volumeStep: 0.01,
        stopsLevel: 0,
        freezeLevel: 0,
        spread: 15,
        tradeMode: 'Full',
        swapLong: -2.5,
        swapShort: -2.3,
        bid: 1.0849,
        ask: 1.0851,
        currencyBase: 'EUR',
        currencyProfit: 'USD',
        currencyMargin: 'USD',
      },
    });
    const info = await terminal().symbolInfo('EURUSD');
    expect(info.tickSize).toBe(0.00001);
    expect(info.volumeMin).toBe(0.01);
    expect(info.currencyBase).toBe('EUR');
    expect(info.commissions).toEqual([]);
    expect(info.sessions).toEqual([]);
  });

  it('decodes commission rules and trading sessions', async () => {
    mock.get('/SymbolInfo', {
      status: 200,
      json: {
        symbol: 'EURUSD',
        commissions: [
          {
            currency: 'USD',
            rangeMode: 'SYMBOL_COMMISSION_RANGE_VOLUME',
            chargeMode: 'SYMBOL_COMMISSION_CHARGE_INSTANT',
            entryMode: 'SYMBOL_COMMISSION_ENTRY_INOUT',
            directionMode: 'SYMBOL_COMMISSION_DIRECTION_BOTH',
            profitMode: 'SYMBOL_COMMISSION_PROFIT_ALL',
            tiers: [
              {
                mode: 'SYMBOL_COMMISSION_MONEY_DEPOSIT',
                volumeType: 'SYMBOL_COMMISSION_VOLUME_TYPE_VOLUME',
                value: 3.5,
                minValue: 0.0,
                maxValue: 0.0,
                rangeFrom: 0.0,
                rangeTo: 1000000.0,
                currency: 'USD',
              },
            ],
          },
        ],
        sessions: [{ day: 'FRIDAY', from: '00:01', to: '23:57' }],
      },
    });
    const info = await terminal().symbolInfo('EURUSD');
    const [rule] = info.commissions;
    expect(rule!.rangeMode).toBe('SYMBOL_COMMISSION_RANGE_VOLUME');
    expect(rule!.tiers[0]!.value).toBe(3.5);
    expect(rule!.tiers[0]!.rangeTo).toBe(1000000.0);

    const [session] = info.sessions;
    expect(session!.day).toBe('FRIDAY');
    expect(session!.from).toBe('00:01');
    expect(session!.to).toBe('23:57');
  });

  it('lists symbols', async () => {
    mock.get('/symbols', { status: 200, json: ['EURUSD', 'XAUUSD'] });
    expect(await terminal().symbols()).toEqual(['EURUSD', 'XAUUSD']);
  });
});

describe('calculators', () => {
  it('computes margin and profit', async () => {
    mock.get('/OrderCalcMargin', {
      status: 200,
      json: {
        symbol: 'EURUSD',
        operation: 'Buy',
        volume: 1.0,
        price: 1.08,
        margin: 540.0,
        currency: 'USD',
      },
    });
    mock.get('/OrderCalcProfit', {
      status: 200,
      json: {
        symbol: 'EURUSD',
        operation: 'Buy',
        volume: 1.0,
        priceOpen: 1.08,
        priceClose: 1.09,
        profit: 1000.0,
        currency: 'USD',
      },
    });
    const term = terminal();
    expect((await term.calcMargin('EURUSD', 'Buy', 1.0, 1.08)).margin).toBe(540.0);
    expect((await term.calcProfit('EURUSD', 'Buy', 1.0, 1.08, 1.09)).profit).toBe(
      1000.0,
    );
  });

  it('rejects a non-positive volume', async () => {
    await expect(terminal().calcMargin('EURUSD', 'Buy', 0, 1.08)).rejects.toThrow(
      ValidationError,
    );
  });
});

// --------------------------------------------------------------------------- //
// Trading
// --------------------------------------------------------------------------- //

describe('orderSend', () => {
  it('builds the body with canonical names and omits absent fields', async () => {
    const route = mock.post('/OrderSend', {
      status: 200,
      json: { ...ORDER_OK, deal: 99 },
    });
    const result = await terminal().orderSend({
      symbol: 'EURUSD',
      operation: 'buy_limit',
      volume: 0.1,
      price: 1.07,
      magic: 42,
    });

    expect(result.success).toBe(true);
    expect(result.order).toBe(100);
    expect(route.sent).toEqual({
      symbol: 'EURUSD',
      operation: 'BuyLimit',
      volume: 0.1,
      price: 1.07,
      expertId: 42,
    });
    expect(route.last.headers['content-type']).toBe('application/json');
  });

  it('refuses stop-limit orders on MT4 before sending', async () => {
    // MT4 has no stop-limit order type: its bridge answers 400
    // MRPC_UNSUPPORTED, so the SDK refuses it client-side.
    const route = mock.post('/OrderSend', { status: 200, json: ORDER_OK });
    for (const operation of ['BuyStopLimit', 'sell_stop_limit']) {
      await expect(
        terminal('mt4').orderSend({
          symbol: 'EURUSD',
          operation,
          volume: 0.1,
          price: 1.1,
          stopLimitPrice: 1.09,
        }),
      ).rejects.toThrow(UnsupportedOnPlatformError);
    }
    expect(route.called).toBe(false);
  });

  it('allows stop-limit orders on MT5', async () => {
    const route = mock.post('/OrderSend', { status: 200, json: ORDER_OK });
    await terminal('mt5').orderSend({
      symbol: 'EURUSD',
      operation: 'BuyStopLimit',
      volume: 0.1,
      price: 1.1,
      stopLimitPrice: 1.09,
    });
    expect(route.sent['operation']).toBe('BuyStopLimit');
    expect(route.sent['stopLimitPrice']).toBe(1.09);
  });

  it('validates the request before sending it', async () => {
    const route = mock.post('/OrderSend', { status: 200, json: ORDER_OK });
    const term = terminal();

    await expect(
      term.orderSend({ symbol: 'EURUSD', operation: 'Buy', volume: 0 }),
    ).rejects.toThrow(ValidationError);
    await expect(
      term.orderSend({ symbol: 'EURUSD', operation: 'BuyLimit', volume: 0.1 }),
    ).rejects.toThrow(/price is required/);
    await expect(
      term.orderSend({
        symbol: 'EURUSD',
        operation: 'BuyStopLimit',
        volume: 0.1,
        price: 1.1,
      }),
    ).rejects.toThrow(/stop_limit_price/);
    await expect(
      term.orderSend({
        symbol: 'EURUSD',
        operation: 'Buy',
        volume: 0.1,
        stopLoss: -1,
      }),
    ).rejects.toThrow(/stopLoss must be >= 0/);
    expect(route.called).toBe(false);
  });

  it('maps a 504 to TerminalTimeoutError', async () => {
    mock.post('/OrderSend', {
      status: 504,
      json: { error: 'MRPC_TIMEOUT', message: 'timed out', command_id: 7 },
    });
    await expect(
      terminal().orderSend({ symbol: 'EURUSD', operation: 'Buy', volume: 0.1 }),
    ).rejects.toThrow(TerminalTimeoutError);
  });
});

describe('orderModify', () => {
  it('treats retcode 10025 as effective without success', async () => {
    mock.post('/OrderModify', {
      status: 200,
      json: {
        success: false,
        outcome: 'no_change',
        retcode: 10025,
        retcodeDescription: 'No changes',
        deal: 0,
        order: 100,
        volume: 0.1,
        price: 0.0,
        bid: 1.0849,
        ask: 1.0851,
        comment: 'No changes',
      },
    });
    const result = await terminal().orderModify(100, { stopLoss: 1.07 });
    expect(result.success).toBe(false);
    expect(result.outcome).toBe('no_change');
    expect(result.isNoChange).toBe(true);
    expect(result.isEffective).toBe(true);
  });

  it('defaults a missing outcome to the empty string', async () => {
    mock.post('/OrderModify', { status: 200, json: ORDER_OK });
    const result = await terminal().orderModify(100, { takeProfit: 1.2 });
    expect(result.outcome).toBe('');
    expect(result.success).toBe(true);
    expect(result.isEffective).toBe(true);
  });

  it('rejects a bare zero stop-loss', async () => {
    // A literal 0 would silently REMOVE the stop-loss — it must be explicit.
    await expect(terminal().orderModify(100, { stopLoss: 0 })).rejects.toThrow(
      /clearStopLoss/,
    );
  });

  it('sends zero when clearing a stop', async () => {
    const route = mock.post('/OrderModify', { status: 200, json: ORDER_OK });
    await terminal().orderModify(100, { clearStopLoss: true });
    expect(route.sent).toEqual({ ticket: 100, stopLoss: 0 });
  });

  it('rejects a clear combined with a value', async () => {
    await expect(
      terminal().orderModify(100, { stopLoss: 1.0, clearStopLoss: true }),
    ).rejects.toThrow(ValidationError);
    await expect(
      terminal().orderModify(100, { takeProfit: 1.0, clearTakeProfit: true }),
    ).rejects.toThrow(ValidationError);
  });

  it('omits fields that were not set', async () => {
    const route = mock.post('/OrderModify', { status: 200, json: ORDER_OK });
    await terminal().orderModify(100, { takeProfit: 1.2 });
    expect(route.sent).toEqual({ ticket: 100, takeProfit: 1.2 });
  });
});

describe('orderClose', () => {
  it('omits fields that were not set', async () => {
    const route = mock.post('/OrderClose', { status: 200, json: ORDER_OK });
    await terminal().orderClose(100, { volume: 0.05 });
    expect(route.sent).toEqual({ ticket: 100, volume: 0.05 });
  });

  it('rejects a negative volume', async () => {
    await expect(terminal().orderClose(100, { volume: -1 })).rejects.toThrow(
      ValidationError,
    );
  });
});

describe('closeAll', () => {
  it('sends the filters and decodes the per-ticket results', async () => {
    const route = mock.post('/CloseAll', {
      status: 200,
      json: {
        requested: 2,
        closed: 1,
        failed: 1,
        results: [
          {
            ticket: 100,
            kind: 'position',
            success: true,
            retcode: 10009,
            retcodeDescription: 'Done',
          },
          {
            ticket: 101,
            kind: 'pending',
            success: false,
            retcode: 10006,
            retcodeDescription: 'Rejected',
          },
        ],
      },
    });
    const summary = await terminal().closeAll({
      symbol: 'EURUSD',
      magic: 0,
      deletePending: true,
    });

    // magic=0 is a real filter (manual orders) and must be sent, not dropped.
    expect(route.sent).toEqual({
      symbol: 'EURUSD',
      magic: 0,
      deletePending: true,
    });
    expect([summary.requested, summary.closed, summary.failed]).toEqual([2, 1, 1]);
    expect(summary.results.map((r) => r.isPending)).toEqual([false, true]);
    expect(summary.results[1]!.retcodeDescription).toBe('Rejected');
  });

  it('sends an empty JSON object when there are no filters', async () => {
    const route = mock.post('/CloseAll', {
      status: 200,
      json: { requested: 0, closed: 0, failed: 0, results: [] },
    });
    const summary = await terminal().closeAll();
    expect(route.sent).toEqual({});
    expect(route.last.headers['content-type']).toBe('application/json');
    expect(summary.requested).toBe(0);
    expect(summary.results).toEqual([]);
  });

  it('surfaces a 504 rather than retrying', async () => {
    // The pass continues inside the terminal after a 504 — the SDK must
    // surface the timeout so callers re-check /OpenedOrders.
    const route = mock.post('/CloseAll', {
      status: 504,
      json: { error: 'MRPC_TIMEOUT', message: 'timed out', command_id: 3 },
    });
    await expect(terminal().closeAll()).rejects.toThrow(TerminalTimeoutError);
    expect(route.callCount).toBe(1);
  });
});

// --------------------------------------------------------------------------- //
// client.terminal() wiring
// --------------------------------------------------------------------------- //

describe('FxSocket.terminal', () => {
  it('resolves the endpoint and caches per account', async () => {
    mock.get('/symbols', { status: 200, json: ['EURUSD', 'XAUUSD'] });
    const fx = new FxSocket({ apiKey: 'fxs_live_k', dispatcher: mock.dispatcher });
    const acct = account(TERM, 'mt4');
    const term = fx.terminal(acct);

    expect(term).toBeInstanceOf(TerminalClient);
    expect(term.platform).toBe('mt4');
    expect(fx.terminal(acct)).toBe(term);
    expect(await term.symbols()).toEqual(['EURUSD', 'XAUUSD']);
    await fx.close();
  });

  it('raises when the account has no terminal endpoint', async () => {
    const fx = new FxSocket({ apiKey: 'fxs_live_k', dispatcher: mock.dispatcher });
    expect(() => fx.terminal(account(''))).toThrow(TerminalNotReadyError);
    await fx.close();
  });

  it('raises when the account has no WebSocket endpoint', async () => {
    const fx = new FxSocket({ apiKey: 'fxs_live_k', dispatcher: mock.dispatcher });
    expect(() => fx.stream({ ...account(), wsUrl: '' })).toThrow(TerminalNotReadyError);
    await fx.close();
  });
});

// --------------------------------------------------------------------------- //
// Bridge MT5 0.17.0 / MT4 0.15.0
// --------------------------------------------------------------------------- //

const PENDING_ROW = {
  ticket: 501,
  symbol: 'EURUSD',
  type: 'BuyStopLimit',
  volumeInitial: 0.2,
  volume: 0.1,
  price: 1.09,
  stopLimitPrice: 1.088,
  sl: 1.08,
  tp: 1.1,
  expirationMode: 'specified',
  expiration: '2026-11-03T19:00:00.000Z',
  expirationUtc: '2026-11-03T17:00:00Z',
  magic: 77,
  comment: 'copy',
  time: '2026-10-29T18:00:00.123Z',
  timeUtc: '2026-10-29T16:00:00.123Z',
};

describe('pendingOrders', () => {
  it('decodes the active pending orders', async () => {
    mock.get('/PendingOrders', {
      status: 200,
      json: [PENDING_ROW, { ticket: 502, symbol: 'GBPUSD', type: 'SellLimit' }],
    });
    const [first, second] = await terminal().pendingOrders();
    expect(first).toEqual(PENDING_ROW);
    expect(second!.expirationMode).toBe('');
    expect(second!.timeUtc).toBeNull();
  });
});

describe('symbolSelect / symbolInfos', () => {
  it('selects symbols in one POST', async () => {
    const route = mock.post('/SymbolSelect', {
      status: 200,
      json: [
        { symbol: 'EURUSD', selected: true, quoting: true },
        { symbol: 'NOPE', selected: false, quoting: false },
      ],
    });
    const rows = await terminal().symbolSelect(['EURUSD', 'NOPE']);
    expect(route.sent).toEqual({ symbols: ['EURUSD', 'NOPE'] });
    expect(rows).toEqual([
      { symbol: 'EURUSD', selected: true, quoting: true },
      { symbol: 'NOPE', selected: false, quoting: false },
    ]);
  });

  it('looks up many symbols with a comma list and keeps the misses', async () => {
    const route = mock.get('/SymbolInfo', {
      status: 200,
      json: {
        symbols: [
          {
            symbol: 'EURUSD',
            digits: 5,
            orderModes: ['market', 'limit', 'stop', 'stopLimit', 'sl', 'tp'],
            expirationModes: ['gtc', 'day', 'specified', 'specifiedDay'],
            fillingModes: ['fok', 'ioc'],
          },
        ],
        errors: [
          { symbol: 'NOPE', error: 'MRPC_UNKNOWN_SYMBOL', message: 'unknown symbol' },
        ],
      },
    });
    const batch = await terminal().symbolInfos(['EURUSD', 'NOPE']);
    expect(route.last.query.get('symbols')).toBe('EURUSD,NOPE');
    expect(route.last.query.has('symbol')).toBe(false);
    expect(batch.symbols[0]!.fillingModes).toEqual(['fok', 'ioc']);
    expect(batch.symbols[0]!.expirationModes).toContain('specifiedDay');
    expect(batch.errors).toEqual([
      { symbol: 'NOPE', error: 'MRPC_UNKNOWN_SYMBOL', message: 'unknown symbol' },
    ]);
  });

  it('defaults the symbol modes to empty on older bridges', async () => {
    mock.get('/SymbolInfo', { status: 200, json: { symbol: 'EURUSD' } });
    const info = await terminal().symbolInfo('EURUSD');
    expect(info.orderModes).toEqual([]);
    expect(info.expirationModes).toEqual([]);
    expect(info.fillingModes).toEqual([]);
  });

  it('validates the symbol list before sending', async () => {
    const select = mock.post('/SymbolSelect', { status: 200, json: [] });
    const info = mock.get('/SymbolInfo', { status: 200, json: {} });
    const term = terminal();
    const bad: unknown[] = [
      'EURUSD', // a bare string is not a list
      [],
      Array.from({ length: 101 }, (_, i) => `S${i}`),
      [''],
      ['  '],
      ['EURUSD', 7],
      ['EURUSD,GBPUSD'],
    ];
    for (const symbols of bad) {
      await expect(term.symbolSelect(symbols as string[])).rejects.toThrow(
        ValidationError,
      );
      await expect(term.symbolInfos(symbols as string[])).rejects.toThrow(
        ValidationError,
      );
    }
    expect(select.called).toBe(false);
    expect(info.called).toBe(false);
    // Exactly 100 is fine.
    await term.symbolSelect(Array.from({ length: 100 }, (_, i) => `S${i}`));
    expect(select.callCount).toBe(1);
  });
});

describe('trade replies (0.17)', () => {
  it('decodes the new fields and the timing / replay headers', async () => {
    mock.post('/OrderSend', {
      status: 200,
      json: {
        ...ORDER_OK,
        deal: 99,
        position: 100,
        time: '2026-10-29T18:00:00.456Z',
        timeUtc: '2026-10-29T16:00:00.456Z',
        remainderTicket: 0,
        clientOrderId: 'copy-1',
      },
      headers: {
        'Server-Timing': 'queue;dur=0.8, exec;dur=212.5',
        'Idempotent-Replayed': 'true',
      },
    });
    const result = await terminal().orderSend({
      symbol: 'EURUSD',
      operation: 'Buy',
      volume: 0.1,
      clientOrderId: 'copy-1',
    });
    expect(result.position).toBe(100);
    expect(result.time).toBe('2026-10-29T18:00:00.456Z');
    expect(result.timeUtc).toBe('2026-10-29T16:00:00.456Z');
    expect(result.clientOrderId).toBe('copy-1');
    expect(result.idempotentReplayed).toBe(true);
    expect(result.serverTiming).toEqual({ queueMs: 0.8, execMs: 212.5 });
  });

  it('reads the headers on modify and close too, and defaults without them', async () => {
    mock.post('/OrderModify', {
      status: 200,
      json: ORDER_OK,
      headers: { 'server-timing': 'queue;dur=1, exec;dur=2' },
    });
    mock.post('/OrderClose', {
      status: 200,
      json: { ...ORDER_OK, remainderTicket: 123 },
    });
    const modified = await terminal().orderModify(100, { takeProfit: 1.2 });
    expect(modified.serverTiming).toEqual({ queueMs: 1, execMs: 2 });
    expect(modified.idempotentReplayed).toBe(false);
    const closed = await terminal('mt4').orderClose(100, { volume: 0.05 });
    expect(closed.remainderTicket).toBe(123);
    expect(closed.serverTiming).toBeNull();
    expect(closed.idempotentReplayed).toBe(false);
  });

  it('maps the trade 504s and a reused clientOrderId', async () => {
    mock.post(
      '/OrderSend',
      { status: 504, json: { error: 'MRPC_TRADE_OUTCOME_UNKNOWN', message: 'm' } },
      { status: 504, json: { error: 'MRPC_ABANDONED', message: 'm' } },
      { status: 409, json: { error: 'MRPC_CLIENT_ORDER_ID_REUSED', message: 'm' } },
    );
    const send = () =>
      terminal().orderSend({
        symbol: 'EURUSD',
        operation: 'Buy',
        volume: 0.1,
        clientOrderId: 'x',
      });
    await expect(send()).rejects.toThrow(TradeOutcomeUnknownError);
    await expect(send()).rejects.toThrow(TradeAbandonedError);
    await expect(send()).rejects.toThrow(ClientOrderIdReusedError);
  });
});

describe('clientOrderId', () => {
  it('is sent as given', async () => {
    const route = mock.post('/OrderSend', { status: 200, json: ORDER_OK });
    await terminal().orderSend({
      symbol: 'EURUSD',
      operation: 'Buy',
      volume: 0.1,
      clientOrderId: 'copy-7f3a-0001',
    });
    expect(route.sent['clientOrderId']).toBe('copy-7f3a-0001');
  });

  it('must be 1-64 characters, counted as the terminal counts them', async () => {
    const route = mock.post('/OrderSend', { status: 200, json: ORDER_OK });
    const send = (clientOrderId: unknown) =>
      terminal().orderSend({
        symbol: 'EURUSD',
        operation: 'Buy',
        volume: 0.1,
        clientOrderId: clientOrderId as string,
      });
    await expect(send('')).rejects.toThrow(ValidationError);
    await expect(send('x'.repeat(65))).rejects.toThrow(/1-64 characters/);
    await expect(send(12)).rejects.toThrow(/must be a string/);
    expect(route.called).toBe(false);

    await send('x'.repeat(64));
    // 64 emoji are 128 UTF-16 units but 64 characters: still accepted.
    await send('😀'.repeat(64));
    expect(route.callCount).toBe(2);
  });
});

describe('expirationUtc', () => {
  it('renders a Date in UTC with a Z and whole seconds', async () => {
    const route = mock.post('/OrderSend', { status: 200, json: ORDER_OK });
    await terminal().orderSend({
      symbol: 'EURUSD',
      operation: 'BuyLimit',
      volume: 0.1,
      price: 1.07,
      expirationUtc: new Date('2026-11-03T17:00:00.789Z'),
    });
    expect(route.sent['expirationUtc']).toBe('2026-11-03T17:00:00Z');
    expect(route.sent).not.toHaveProperty('expiration');
  });

  it('passes a string through unchanged', async () => {
    const route = mock.post('/OrderModify', { status: 200, json: ORDER_OK });
    await terminal().orderModify(501, { expirationUtc: '2026-11-03T17:00:00+00:00' });
    expect(route.sent).toEqual({
      ticket: 501,
      expirationUtc: '2026-11-03T17:00:00+00:00',
    });
  });

  it('cannot be combined with expiration, on send or modify', async () => {
    const send = mock.post('/OrderSend', { status: 200, json: ORDER_OK });
    const modify = mock.post('/OrderModify', { status: 200, json: ORDER_OK });
    await expect(
      terminal().orderSend({
        symbol: 'EURUSD',
        operation: 'BuyLimit',
        volume: 0.1,
        price: 1.07,
        expiration: '2026-11-03T19:00:00',
        expirationUtc: '2026-11-03T17:00:00Z',
      }),
    ).rejects.toThrow(/either expiration .* or expirationUtc/);
    await expect(
      terminal().orderModify(501, {
        expiration: '2026-11-03T19:00:00',
        expirationUtc: new Date(),
      }),
    ).rejects.toThrow(ValidationError);
    expect(send.called).toBe(false);
    expect(modify.called).toBe(false);
  });

  it('rejects an invalid Date', async () => {
    mock.post('/OrderSend', { status: 200, json: ORDER_OK });
    await expect(
      terminal().orderSend({
        symbol: 'EURUSD',
        operation: 'BuyLimit',
        volume: 0.1,
        price: 1.07,
        expirationUtc: new Date('not a date'),
      }),
    ).rejects.toThrow(/invalid Date/);
  });
});

describe('MT4 stop-limit guard on modify', () => {
  it('refuses stopLimitPrice on MT4 and sends it on MT5', async () => {
    const route = mock.post('/OrderModify', { status: 200, json: ORDER_OK });
    await expect(
      terminal('mt4').orderModify(501, { stopLimitPrice: 1.088 }),
    ).rejects.toThrow(UnsupportedOnPlatformError);
    expect(route.called).toBe(false);

    await terminal('mt5').orderModify(501, { stopLimitPrice: 1.088 });
    expect(route.sent).toEqual({ ticket: 501, stopLimitPrice: 1.088 });
    // A plain MT4 modify is untouched.
    await terminal('mt4').orderModify(501, { price: 1.09 });
    expect(route.sent).toEqual({ ticket: 501, price: 1.09 });
  });
});

describe('bridge pipeline health', () => {
  it('decodes the trade-pipeline fields of /status', () => {
    const bridge = decodeBridgeHealth({
      version: '0.17.0',
      tradeEaReady: true,
      tradeEaHeartbeatAgeMs: 4,
      symbolsSynced: true,
      asyncTrades: true,
      tradeInFlight: 2,
      oldestTradeInFlightAgeMs: 180,
      dealerRttMsEwma: 95,
      tradeRequestsSent: 1234,
      lateTradeVerdicts: 1,
      tradeQueueDepth: 3,
      nonTradeQueueDepth: 0,
      tradeDeferred: 1,
    });
    expect(bridge).toMatchObject({
      asyncTrades: true,
      tradeInFlight: 2,
      oldestTradeInFlightAgeMs: 180,
      dealerRttMsEwma: 95,
      tradeRequestsSent: 1234,
      lateTradeVerdicts: 1,
      tradeQueueDepth: 3,
      nonTradeQueueDepth: 0,
      tradeDeferred: 1,
    });
  });
});
