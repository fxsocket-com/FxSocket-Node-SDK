/** Tests for the terminal REST client. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  coerceOperation,
  coerceTimeframe,
  decodeBridgeHealth,
  FxSocket,
  OrderOperation,
  TerminalClient,
  TerminalNotReadyError,
  TerminalTimeoutError,
  Timeframe,
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

  it('rejects an MT5-only timeframe on MT4 before any request', async () => {
    const route = mock.get('/PriceHistory', { status: 200, json: [] });
    await expect(terminal('mt4').priceHistory('EURUSD', 'H6')).rejects.toThrow(
      UnsupportedOnPlatformError,
    );
    expect(route.called).toBe(false);
  });

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

  it('allows stop-limit orders on MT4', async () => {
    // MT4's terminal API accepts BuyStopLimit/SellStopLimit, so the SDK must
    // not block them client-side.
    const route = mock.post('/OrderSend', { status: 200, json: ORDER_OK });
    await terminal('mt4').orderSend({
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
