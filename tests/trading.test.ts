/** Tests for multi-account trading (`client.orders`). */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CloseKind,
  CloseLegStatus,
  ClosedTicketStatus,
  ForbiddenError,
  FxSocket,
  IdempotencyError,
  OrderLegStatus,
  OrderOperation,
  ValidationError,
  type Account,
  type CloseLeg,
  type OrderLeg,
} from '../src/index.js';
import { A1, A2, POD_ACCOUNT } from './helpers/fixtures.js';
import { HttpMock, ORIGIN } from './helpers/mock-http.js';

function legResult(
  accountId: string,
  status = 'filled',
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    account_id: accountId,
    platform: 'mt5',
    symbol: 'EURUSD',
    operation: 'Buy',
    volume: 0.1,
    status,
    order: 123,
    deal: 456,
    price: 1.1,
    bid: 1.0999,
    ask: 1.1001,
    retcode: 10009,
    retcode_description: 'Request completed',
    message: '',
    latency_ms: 120,
    ...overrides,
  };
}

const ORDER_RESPONSE = {
  batch_id: 'batch-1',
  idempotent_replay: false,
  summary: { requested: 2, filled: 1, failed: 0, unknown: 1 },
  results: [
    legResult(A1),
    legResult(A2, 'timeout', {
      order: 0,
      deal: 0,
      retcode: 0,
      retcode_description: '',
      message: 'terminal did not answer',
    }),
  ],
};

const CLOSE_RESPONSE = {
  batch_id: 'batch-2',
  idempotent_replay: false,
  summary: {
    accounts: 2,
    matched: 2,
    closed: 1,
    failed: 0,
    unknown: 1,
    accounts_unknown: 0,
  },
  results: [
    {
      account_id: A1,
      platform: 'mt5',
      status: 'partial',
      matched: 2,
      closed: 1,
      message: '',
      latency_ms: 300,
      results: [
        {
          ticket: 1,
          symbol: 'EURUSD',
          type: 'Buy',
          kind: 'position',
          volume: 0.1,
          status: 'closed',
          retcode: 10009,
          retcode_description: 'Request completed',
          price: 1.1,
          message: '',
          latency_ms: 100,
        },
        {
          ticket: 2,
          symbol: 'EURUSD',
          type: 'BuyLimit',
          kind: 'pending',
          volume: 0.1,
          status: 'timeout',
          retcode: 0,
          retcode_description: '',
          price: 0.0,
          message: 'no reply',
          latency_ms: 200,
        },
      ],
    },
    {
      account_id: A2,
      platform: 'mt4',
      status: 'nothing_matched',
      matched: 0,
      closed: 0,
      message: '',
      latency_ms: 50,
      results: [],
    },
  ],
};

let mock: HttpMock;

function client(): FxSocket {
  return new FxSocket({ apiKey: 'fxs_live_test', dispatcher: mock.dispatcher });
}

async function account(fx: FxSocket): Promise<Account> {
  mock.get(`/v1/accounts/${A1}`, { status: 200, json: POD_ACCOUNT });
  return fx.accounts.get(A1);
}

beforeEach(() => {
  mock = new HttpMock(ORIGIN);
});

afterEach(async () => {
  await mock.close();
});

// --------------------------------------------------------------------------- //
// send
// --------------------------------------------------------------------------- //

describe('orders.send', () => {
  it('merges defaults and legs onto the wire', async () => {
    const route = mock.post('/v1/orders', { status: 200, json: ORDER_RESPONSE });
    const fx = client();
    await fx.orders.send(
      [
        { accountId: A1, volume: 0.1 },
        { accountId: A2, volume: 0.2, magic: 7, slippage: 0 },
      ],
      { defaults: { symbol: 'EURUSD', operation: 'buy', stopLoss: 1.07 } },
    );

    expect(route.sent).toEqual({
      orders: [
        { account_id: A1, volume: 0.1 },
        { account_id: A2, volume: 0.2, slippage: 0, expert_id: 7 },
      ],
      defaults: { symbol: 'EURUSD', operation: 'Buy', stop_loss: 1.07 },
    });
    expect(route.last.headers['idempotency-key']).toBeUndefined();
    await fx.close();
  });

  it('accepts bare accounts and a canonical operation constant', async () => {
    const route = mock.post('/v1/orders', { status: 200, json: ORDER_RESPONSE });
    const fx = client();
    const acct = await account(fx);
    await fx.orders.send([acct, A2], {
      defaults: {
        symbol: 'EURUSD',
        operation: OrderOperation.SELL_LIMIT,
        volume: 0.5,
        price: 1.2,
      },
      requireReachable: true,
    });

    expect(route.sent).toEqual({
      orders: [{ account_id: A1 }, { account_id: A2 }],
      defaults: {
        symbol: 'EURUSD',
        operation: 'SellLimit',
        volume: 0.5,
        price: 1.2,
      },
      require_reachable: true,
    });
    await fx.close();
  });

  it('lets a leg override defaults and accepts the expertId spelling', async () => {
    const route = mock.post('/v1/orders', { status: 200, json: ORDER_RESPONSE });
    const fx = client();
    const acct = await account(fx);
    await fx.orders.send(
      [
        {
          accountId: acct,
          symbol: 'EURUSD.sd',
          operation: 'SELL',
          volume: 0.3,
          expertId: 42,
          comment: 'hedge',
        },
        { accountId: A2, expiration: '2026-12-31T00:00:00' },
      ],
      { defaults: { symbol: 'EURUSD', operation: 'buy', volume: 0.1 } },
    );

    const sent = route.sent as { orders: Record<string, unknown>[] };
    expect(sent.orders[0]).toEqual({
      account_id: A1,
      symbol: 'EURUSD.sd',
      operation: 'Sell',
      volume: 0.3,
      comment: 'hedge',
      expert_id: 42,
    });
    expect(sent.orders[1]).toEqual({
      account_id: A2,
      expiration: '2026-12-31T00:00:00',
    });
    await fx.close();
  });

  it('serializes a Date expiration as ISO 8601', async () => {
    const route = mock.post('/v1/orders', { status: 200, json: ORDER_RESPONSE });
    const fx = client();
    await fx.orders.send(
      [{ accountId: A1, expiration: new Date(Date.UTC(2026, 11, 31)) }],
      {
        defaults: { symbol: 'EURUSD', operation: 'buyLimit', volume: 0.1, price: 1.2 },
      },
    );
    const sent = route.sent as { orders: Record<string, unknown>[] };
    expect(sent.orders[0]!['expiration']).toBe('2026-12-31T00:00:00.000Z');
    await fx.close();
  });

  it('sends the Idempotency-Key header and surfaces the replay flag', async () => {
    const route = mock.post('/v1/orders', {
      status: 200,
      json: { ...ORDER_RESPONSE, idempotent_replay: true },
    });
    const fx = client();
    const result = await fx.orders.send([A1], {
      defaults: { symbol: 'EURUSD', operation: 'buy', volume: 0.1 },
      idempotencyKey: 'signal-2026-09-09-1',
    });

    expect(route.last.headers['idempotency-key']).toBe('signal-2026-09-09-1');
    expect(result.idempotentReplay).toBe(true);
    await fx.close();
  });

  it('returns positional results with roll-up helpers', async () => {
    mock.post('/v1/orders', { status: 200, json: ORDER_RESPONSE });
    const legs: OrderLeg[] = [
      { accountId: A1, volume: 0.1 },
      { accountId: A2, volume: 0.2 },
    ];
    const fx = client();
    const result = await fx.orders.send(legs, {
      defaults: { symbol: 'EURUSD', operation: 'buy' },
    });

    expect(result.batchId).toBe('batch-1');
    expect(result.summary.requested).toBe(2);
    expect(result.allFilled).toBe(false);

    const [first, second] = result.results;
    expect(result.results).toHaveLength(legs.length);
    expect(first!.status).toBe(OrderLegStatus.FILLED);
    expect(first!.isFilled).toBe(true);
    expect(first!.isUnknown).toBe(false);
    expect(first!.order).toBe(123);
    expect(first!.deal).toBe(456);
    expect(second!.status).toBe('timeout');
    expect(second!.isUnknown).toBe(true);
    expect(second!.isFilled).toBe(false);
    expect(result.filledLegs).toEqual([first]);
    expect(result.unknownLegs).toEqual([second]);
    expect(result.failedLegs).toEqual([]);
    await fx.close();
  });

  it('validates every leg before sending anything', async () => {
    const defaults = { symbol: 'EURUSD', operation: 'buy' } as const;
    const route = mock.post('/v1/orders', { status: 200, json: ORDER_RESPONSE });
    const fx = client();

    await expect(fx.orders.send([{ accountId: A1 }], { defaults })).rejects.toThrow(
      /orders\[0\]: volume is required/,
    );
    await expect(
      fx.orders.send(
        [
          { accountId: A1, volume: 0.1 },
          { accountId: A2, volume: 0.1, operation: 'buyLimit' },
        ],
        { defaults },
      ),
    ).rejects.toThrow(/orders\[1\]: price is required/);
    await expect(
      fx.orders.send([{ accountId: A1, volume: 0 }], { defaults }),
    ).rejects.toThrow(/orders\[0\]: volume must be > 0/);
    await expect(
      fx.orders.send([{ accountId: A1, volume: 0.1, operation: 'bogus' }], {
        defaults,
      }),
    ).rejects.toThrow(/Unknown order operation/);
    await expect(
      fx.orders.send([{ accountId: A1, volume: 0.1, operation: 'buy' }]),
    ).rejects.toThrow(/orders\[0\]: symbol is required/);
    await expect(fx.orders.send([], { defaults })).rejects.toThrow(/at least one leg/);
    await expect(
      fx.orders.send([{ accountId: A1, volume: 0.1, lots: 1 } as unknown as OrderLeg], {
        defaults,
      }),
    ).rejects.toThrow(/orders\[0\]: unknown field 'lots'/);
    await expect(
      fx.orders.send([{ accountId: A1, volume: 0.1 }], {
        defaults,
        idempotencyKey: 'x'.repeat(129),
      }),
    ).rejects.toThrow(/idempotencyKey/);
    await expect(
      fx.orders.send([{ accountId: A1, volume: 0.1 }], {
        defaults: { ...defaults, foo: 1 } as never,
      }),
    ).rejects.toThrow(/defaults: unknown field 'foo'/);
    await expect(
      fx.orders.send([{ accountId: A1, volume: 0.1, stopLimitPrice: 0 }], {
        defaults: { symbol: 'EURUSD', operation: 'buyStopLimit', price: 1.2 },
      }),
    ).rejects.toThrow(/stop_limit_price is required/);
    await expect(
      fx.orders.send([{ accountId: '', volume: 0.1 }], { defaults }),
    ).rejects.toThrow(/accountId is required/);

    // Validation is all-or-nothing: not one of those reached the network.
    expect(route.called).toBe(false);
    await fx.close();
  });

  it('maps every idempotency failure to a typed error', async () => {
    for (const [status, code] of [
      [409, 'idempotency_in_flight'],
      [422, 'idempotency_key_reused'],
      [503, 'idempotency_unavailable'],
    ] as const) {
      const local = new HttpMock(ORIGIN);
      local.post('/v1/orders', { status, json: { error: code, detail: 'nope' } });
      const fx = new FxSocket({ apiKey: 'k', dispatcher: local.dispatcher });
      await expect(
        fx.orders.send([A1], {
          defaults: { symbol: 'EURUSD', operation: 'buy', volume: 0.1 },
          idempotencyKey: 'k',
        }),
      ).rejects.toMatchObject({ constructor: IdempotencyError, code, status });
      await fx.close();
      await local.close();
    }
  });

  it('maps invalid_batch and read-only key rejections', async () => {
    mock.post(
      '/v1/orders',
      { status: 400, json: { error: 'unknown_account', detail: 'not yours' } },
      { status: 403, json: { error: 'read_only', detail: 'read-only key' } },
    );
    const defaults = { symbol: 'EURUSD', operation: 'buy', volume: 0.1 } as const;
    const fx = client();

    await expect(fx.orders.send([A1], { defaults })).rejects.toMatchObject({
      constructor: ValidationError,
      code: 'unknown_account',
    });
    await expect(fx.orders.send([A1], { defaults })).rejects.toThrow(ForbiddenError);
    await fx.close();
  });
});

// --------------------------------------------------------------------------- //
// close
// --------------------------------------------------------------------------- //

describe('orders.close', () => {
  it('sends selector legs and explicit ticket legs', async () => {
    const route = mock.post('/v1/orders/close', { status: 200, json: CLOSE_RESPONSE });
    const fx = client();
    const acct = await account(fx);

    await fx.orders.close(
      [
        { accountId: acct, side: 'short', volume: 0.05 },
        { accountId: A2, tickets: [11, 12], slippage: 20 },
      ],
      {
        defaults: {
          symbol: 'EURUSD',
          symbolMatch: 'BASE',
          kind: CloseKind.ANY,
          magic: 0,
        },
        idempotencyKey: 'close-1',
      },
    );

    expect(route.sent).toEqual({
      accounts: [
        { account_id: A1, side: 'short', volume: 0.05 },
        { account_id: A2, slippage: 20, tickets: [11, 12] },
      ],
      defaults: {
        symbol: 'EURUSD',
        symbol_match: 'base',
        kind: 'any',
        magic: 0,
      },
    });
    expect(route.last.headers['idempotency-key']).toBe('close-1');
    await fx.close();
  });

  it('requires a literal star to close everything', async () => {
    const route = mock.post('/v1/orders/close', { status: 200, json: CLOSE_RESPONSE });
    const fx = client();
    await fx.orders.close([A1, A2], { defaults: { symbol: '*' } });
    expect(route.sent).toEqual({
      accounts: [{ account_id: A1 }, { account_id: A2 }],
      defaults: { symbol: '*' },
    });
    await fx.close();
  });

  it('validates every entry before sending anything', async () => {
    const route = mock.post('/v1/orders/close', { status: 200, json: CLOSE_RESPONSE });
    const fx = client();

    await expect(fx.orders.close([A1])).rejects.toThrow(
      /accounts\[0\]: symbol is required/,
    );
    await expect(
      fx.orders.close([{ accountId: A1, symbol: 'EURUSD', tickets: [1] }]),
    ).rejects.toThrow(/tickets can't be combined/);
    await expect(fx.orders.close([{ accountId: A1, tickets: [] }])).rejects.toThrow(
      /tickets must not be empty/,
    );
    await expect(fx.orders.close([{ accountId: A1, tickets: [0] }])).rejects.toThrow(
      /tickets must be >= 1/,
    );
    await expect(
      fx.orders.close([{ accountId: A1, symbol: 'EURUSD', volume: 0 }]),
    ).rejects.toThrow(/volume must be > 0/);
    await expect(
      fx.orders.close([{ accountId: A1, symbol: 'EURUSD', side: 'up' }]),
    ).rejects.toThrow(/side must be one of long, short, any/);
    await expect(
      fx.orders.close([{ accountId: A1, symbol: 'EURUSD', kind: 'both' }]),
    ).rejects.toThrow(/kind must be one of position, pending, any/);
    await expect(
      fx.orders.close([{ accountId: A1, symbol: 'EURUSD', symbolMatch: 'fuzzy' }]),
    ).rejects.toThrow(/symbolMatch must be one of exact, base/);
    await expect(fx.orders.close([], { defaults: { symbol: '*' } })).rejects.toThrow(
      /at least one entry/,
    );
    await expect(
      fx.orders.close([{ accountId: A1, tickets: [1], foo: 2 } as unknown as CloseLeg]),
    ).rejects.toThrow(/accounts\[0\]: unknown field 'foo'/);

    expect(route.called).toBe(false);
    await fx.close();
  });

  it('decodes per-account and per-ticket outcomes', async () => {
    mock.post('/v1/orders/close', { status: 200, json: CLOSE_RESPONSE });
    const fx = client();
    const result = await fx.orders.close([A1, A2], { defaults: { symbol: 'EURUSD' } });

    expect(result.batchId).toBe('batch-2');
    expect(result.summary.unknown).toBe(1);
    expect(result.allClosed).toBe(false);

    const [first, second] = result.results;
    expect(first!.status).toBe(CloseLegStatus.PARTIAL);
    expect(first!.matched).toBe(2);
    expect(first!.closed).toBe(1);

    const [closed, timedOut] = first!.results;
    expect(closed!.status).toBe(ClosedTicketStatus.CLOSED);
    expect(closed!.isClosed).toBe(true);
    expect(timedOut!.isUnknown).toBe(true);
    expect(timedOut!.isPending).toBe(true);

    expect(second!.nothingMatched).toBe(true);
    expect(second!.isUnknown).toBe(false);
    expect(result.unknownAccounts).toEqual([]);
    await fx.close();
  });

  it('reports allClosed when nothing is left pending', async () => {
    mock.post('/v1/orders/close', {
      status: 200,
      json: {
        ...CLOSE_RESPONSE,
        summary: {
          accounts: 1,
          matched: 0,
          closed: 0,
          failed: 0,
          unknown: 0,
          accounts_unknown: 0,
        },
        results: [CLOSE_RESPONSE.results[1]],
      },
    });
    const fx = client();
    const result = await fx.orders.close([A2], { defaults: { symbol: '*' } });
    expect(result.allClosed).toBe(true);
    await fx.close();
  });
});
