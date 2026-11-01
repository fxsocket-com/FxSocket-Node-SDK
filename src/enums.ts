/**
 * Enumerations mirroring the FxSocket / terminal API vocabulary.
 *
 * Each one is a frozen object of string constants plus a matching union type,
 * so `Platform.MT5` is usable as a value and `Platform` as a type. The values
 * are the raw wire strings — comparing a decoded field against them needs no
 * conversion.
 *
 * Decoders pass unknown server values through unchanged rather than failing,
 * so a `switch` over one of these unions should still carry a `default` arm.
 */

/** Trading platform of a linked account. */
export const Platform = {
  MT4: 'mt4',
  MT5: 'mt5',
} as const;
export type Platform = (typeof Platform)[keyof typeof Platform];

/** Unified, public connection status of an account (v1 `status`). */
export const TradingStatus = {
  CONNECTED: 'connected',
  CONNECTING: 'connecting',
  DISCONNECTED: 'disconnected',
  ERROR: 'error',
} as const;
export type TradingStatus = (typeof TradingStatus)[keyof typeof TradingStatus];

/**
 * Order operation accepted by the terminal `/OrderSend`.
 *
 * MT5 accepts all eight. MT4 has no stop-limit order type: its terminal API
 * refuses `BuyStopLimit` / `SellStopLimit` (HTTP 400 `MRPC_UNSUPPORTED`), so on
 * an MT4 account the SDK throws {@link UnsupportedOnPlatformError} for them
 * before anything is sent.
 */
export const OrderOperation = {
  BUY: 'Buy',
  SELL: 'Sell',
  BUY_LIMIT: 'BuyLimit',
  SELL_LIMIT: 'SellLimit',
  BUY_STOP: 'BuyStop',
  SELL_STOP: 'SellStop',
  BUY_STOP_LIMIT: 'BuyStopLimit',
  SELL_STOP_LIMIT: 'SellStopLimit',
} as const;
export type OrderOperation = (typeof OrderOperation)[keyof typeof OrderOperation];

/**
 * Anything accepted where an order operation is expected: the canonical
 * spelling, or any case/separator variant of it (`buy`, `BUY-STOP-LIMIT`,
 * `sell_limit`). Unknown values raise a {@link ValidationError} at call time.
 */
export type OrderOperationInput = OrderOperation | (string & {});

/** Operations that require a `stopLimitPrice`. */
export const STOP_LIMIT_OPERATIONS: ReadonlySet<OrderOperation> = new Set([
  OrderOperation.BUY_STOP_LIMIT,
  OrderOperation.SELL_STOP_LIMIT,
]);

/** Operations that are pending orders (require an entry `price`). */
export const PENDING_OPERATIONS: ReadonlySet<OrderOperation> = new Set([
  OrderOperation.BUY_LIMIT,
  OrderOperation.SELL_LIMIT,
  OrderOperation.BUY_STOP,
  OrderOperation.SELL_STOP,
  OrderOperation.BUY_STOP_LIMIT,
  OrderOperation.SELL_STOP_LIMIT,
]);

/**
 * Semantic classification of a trade result (`OrderResult.outcome`).
 *
 * `success` only tells you applied-or-not; `outcome` additionally separates a
 * benign no-op and a partial fill from a genuine rejection, so clients don't
 * have to hardcode retcode tables. Empty on bridges older than MT5 0.6.1 /
 * MT4 0.5.1.
 */
export const OrderOutcome = {
  /** retcode 10009 (done) / 10008 (placed) */
  APPLIED: 'applied',
  /** retcode 10025 — requested state already in effect */
  NO_CHANGE: 'no_change',
  /** retcode 10010 (done partially) */
  PARTIAL: 'partial',
  /** anything else — inspect `retcode` / `comment` */
  REJECTED: 'rejected',
} as const;
export type OrderOutcome = (typeof OrderOutcome)[keyof typeof OrderOutcome];

/** Lifecycle of a private hosting server (v1 `status`). */
export const PrivateServerStatus = {
  PENDING_PAYMENT: 'pending_payment',
  PROVISIONING: 'provisioning',
  READY: 'ready',
  RESIZING: 'resizing',
  EXPIRED: 'expired',
} as const;
export type PrivateServerStatus =
  (typeof PrivateServerStatus)[keyof typeof PrivateServerStatus];

/** Lifecycle of an account living on a private server (v1 `status`). */
export const PrivateAccountStatus = {
  PROVISIONING: 'provisioning',
  READY: 'ready',
  ERROR: 'error',
  EXPIRED: 'expired',
} as const;
export type PrivateAccountStatus =
  (typeof PrivateAccountStatus)[keyof typeof PrivateAccountStatus];

/**
 * What a named read-only key may see (v1 `scope`).
 *
 * `ALL` covers every account; `SELECTED` only the accounts attached to the key
 * — everything else is invisible to it (absent from lists, 404 by id, 401 at
 * the terminal).
 */
export const KeyScope = {
  ALL: 'all',
  SELECTED: 'selected',
} as const;
export type KeyScope = (typeof KeyScope)[keyof typeof KeyScope];

/**
 * How a multi-account close selector matches symbols.
 *
 * `EXACT` (the default) matches the symbol exactly as typed. `BASE` also
 * accepts a broker suffix, so `EURUSD` reaches `EURUSD.sd` and `EURUSDm` —
 * useful when one selector spans brokers that spell an instrument differently.
 * A suffix is separator-led (`.sd`) or at most two alphanumerics (`m`), so
 * `EUR` never matches `EURUSD`.
 */
export const SymbolMatch = {
  EXACT: 'exact',
  BASE: 'base',
} as const;
export type SymbolMatch = (typeof SymbolMatch)[keyof typeof SymbolMatch];

/** Which direction a multi-account close selector touches. */
export const CloseSide = {
  LONG: 'long',
  SHORT: 'short',
  ANY: 'any',
} as const;
export type CloseSide = (typeof CloseSide)[keyof typeof CloseSide];

/**
 * What a multi-account close selector touches.
 *
 * `POSITION` (the default) closes open positions only, `PENDING` deletes
 * pending orders only, `ANY` does both.
 */
export const CloseKind = {
  POSITION: 'position',
  PENDING: 'pending',
  ANY: 'any',
} as const;
export type CloseKind = (typeof CloseKind)[keyof typeof CloseKind];

/**
 * Outcome of one leg of a multi-account order batch (`OrderLegResult.status`).
 * Only `FILLED` means the broker took it.
 *
 * `TIMEOUT` is *unknown*: the order may well have reached the broker. Never
 * blind-retry one — replay with the same `idempotencyKey` or reconcile against
 * the account's `openedOrders()`.
 */
export const OrderLegStatus = {
  /** the terminal replied and the broker accepted */
  FILLED: 'filled',
  /** the broker refused — `retcode` says why */
  REJECTED: 'rejected',
  /** the terminal refused the request itself */
  INVALID: 'invalid',
  /** terminal up but not trading yet */
  UNAVAILABLE: 'unavailable',
  /** no terminal to talk to */
  UNREACHABLE: 'unreachable',
  /** unknown — may or may not have executed */
  TIMEOUT: 'timeout',
} as const;
export type OrderLegStatus = (typeof OrderLegStatus)[keyof typeof OrderLegStatus];

/**
 * Outcome for one account of a multi-account close batch
 * (`CloseLegResult.status`).
 *
 * `NOTHING_MATCHED` is a normal answer, not an error. `UNAVAILABLE` /
 * `UNREACHABLE` / `INVALID` mean the lookup itself failed, so nothing is known
 * about what is open there. `TIMEOUT` means orders *may* have closed.
 */
export const CloseLegStatus = {
  /** every matched order closed */
  CLOSED: 'closed',
  /** some closed, some did not */
  PARTIAL: 'partial',
  /** orders matched, none closed */
  FAILED: 'failed',
  /** the selector found nothing */
  NOTHING_MATCHED: 'nothing_matched',
  UNAVAILABLE: 'unavailable',
  UNREACHABLE: 'unreachable',
  TIMEOUT: 'timeout',
  INVALID: 'invalid',
} as const;
export type CloseLegStatus = (typeof CloseLegStatus)[keyof typeof CloseLegStatus];

/**
 * Outcome for one ticket of a multi-account close batch (`ClosedTicket.status`).
 *
 * `SKIPPED` means it was never sent (per-account cap or batch deadline), so it
 * definitely did not close. `TIMEOUT` means it was sent and never answered, so
 * it may well have.
 */
export const ClosedTicketStatus = {
  CLOSED: 'closed',
  REJECTED: 'rejected',
  INVALID: 'invalid',
  UNAVAILABLE: 'unavailable',
  UNREACHABLE: 'unreachable',
  TIMEOUT: 'timeout',
  SKIPPED: 'skipped',
} as const;
export type ClosedTicketStatus =
  (typeof ClosedTicketStatus)[keyof typeof ClosedTicketStatus];

/** Whether an opened row is a live position or a resting pending order. */
export const OrderKind = {
  POSITION: 'Position',
  PENDING: 'Pending',
} as const;
export type OrderKind = (typeof OrderKind)[keyof typeof OrderKind];

/**
 * Direction of a deal in trade history / the `trades` stream.
 *
 * `UNKNOWN` appears only on degraded `trades`-stream frames, where the bridge
 * could not resolve the deal direction in time — see `TradeEvent.degraded`.
 */
export const DealEntry = {
  IN: 'In',
  OUT: 'Out',
  IN_OUT: 'InOut',
  /** a close by an opposite position (MT5) */
  OUT_BY: 'OutBy',
  UNKNOWN: 'Unknown',
} as const;
export type DealEntry = (typeof DealEntry)[keyof typeof DealEntry];

/**
 * One step in the life of a pending order (`OrderEventData.event`, on the
 * `orders` stream).
 *
 * `TRIGGERED` means the order filled: the event's `position` is the position
 * the fill opened or added to (on MT4, the order's own ticket).
 */
export const OrderEventKind = {
  PLACED: 'placed',
  /** price, stops, expiry, volume or type changed */
  MODIFIED: 'modified',
  /** cancelled */
  DELETED: 'deleted',
  EXPIRED: 'expired',
  TRIGGERED: 'triggered',
} as const;
export type OrderEventKind = (typeof OrderEventKind)[keyof typeof OrderEventKind];

/**
 * How a pending order expires (`PendingOrder.expirationMode`), and the values
 * of `SymbolInfo.expirationModes` (what the broker accepts for a symbol). MT4
 * knows only `GTC` and `SPECIFIED`.
 */
export const ExpirationMode = {
  /** good till cancelled */
  GTC: 'gtc',
  /** until the end of the trading day */
  DAY: 'day',
  /** until a given date and time */
  SPECIFIED: 'specified',
  /** until the end of a given day */
  SPECIFIED_DAY: 'specifiedDay',
} as const;
export type ExpirationMode = (typeof ExpirationMode)[keyof typeof ExpirationMode];

/** Roll-up status reported by the terminal `/status` endpoint. */
export const HealthStatus = {
  READY: 'ready',
  STARTING: 'starting',
  DEGRADED: 'degraded',
  DOWN: 'down',
} as const;
export type HealthStatus = (typeof HealthStatus)[keyof typeof HealthStatus];

/**
 * Candle timeframes.
 *
 * Exactly the nine the terminal API accepts, on MT4 and MT5 alike (REST
 * `priceHistory` and the `bars` stream). MT5's other native periods (`M2`,
 * `H2`, `H12`, …) are not exposed by the terminal API, so they are not members.
 */
export const Timeframe = {
  M1: 'M1',
  M5: 'M5',
  M15: 'M15',
  M30: 'M30',
  H1: 'H1',
  H4: 'H4',
  D1: 'D1',
  W1: 'W1',
  MN1: 'MN1',
} as const;
export type Timeframe = (typeof Timeframe)[keyof typeof Timeframe];

/** Human timeframe aliases accepted wherever a {@link Timeframe} is. */
export type TimeframeAlias =
  '1min' | '5min' | '15min' | '30min' | '1h' | '4h' | '1d' | '1w' | '1month' | '1mn';

/**
 * Anything accepted where a timeframe is expected: the canonical label, a
 * human alias (`5min`, `1h`), or either in any case.
 */
export type TimeframeInput = Timeframe | TimeframeAlias | (string & {});

/**
 * @deprecated Always empty: both platforms accept every {@link Timeframe}.
 * Kept so existing imports compile; will be removed in 1.0.
 */
export const MT5_ONLY_TIMEFRAMES: ReadonlySet<Timeframe> = new Set<Timeframe>();

/** Streaming topics the terminal WebSocket understands. */
export const StreamTopic = {
  PRICES: 'prices',
  BARS: 'bars',
  ACCOUNT: 'account',
  POSITIONS: 'positions',
  TRADES: 'trades',
  ORDERS: 'orders',
  TERMINAL: 'terminal',
} as const;
export type StreamTopic = (typeof StreamTopic)[keyof typeof StreamTopic];

export const STREAM_TOPICS: ReadonlySet<string> = new Set(Object.values(StreamTopic));

/**
 * The fixed `error` codes of the terminal API (`FxSocketError.code` on an error
 * from a {@link TerminalClient}). Branch on these, never on the message.
 *
 * Bridges before MT5 0.17.0 / MT4 0.15.0 answered most failures with the
 * generic `MRPC` code; it is kept here for them.
 */
export const TerminalErrorCode = {
  /** 401: missing or wrong API key */
  UNAUTHORIZED: 'UNAUTHORIZED',
  /** 403: a read-only key on a trading route */
  READ_ONLY_KEY: 'READ_ONLY_KEY',
  /** 400: bad request parameters */
  MRPC_VALIDATION: 'MRPC_VALIDATION',
  /** 400: no such order or position */
  MRPC_UNKNOWN_TICKET: 'MRPC_UNKNOWN_TICKET',
  /** 400: no such symbol */
  MRPC_UNKNOWN_SYMBOL: 'MRPC_UNKNOWN_SYMBOL',
  /** 400: timeframe label not recognized */
  MRPC_BAD_TIMEFRAME: 'MRPC_BAD_TIMEFRAME',
  /** 400: the platform cannot do this (MT4: stop-limit orders) */
  MRPC_UNSUPPORTED: 'MRPC_UNSUPPORTED',
  /** 500: the symbol has no quote yet (select it first) */
  MRPC_SYMBOL_NOT_QUOTING: 'MRPC_SYMBOL_NOT_QUOTING',
  /** 500: another request for this ticket is still at the dealer */
  MRPC_TICKET_BUSY: 'MRPC_TICKET_BUSY',
  /** 409: `clientOrderId` already used for a different order */
  MRPC_CLIENT_ORDER_ID_REUSED: 'MRPC_CLIENT_ORDER_ID_REUSED',
  /** 503: no trade EA has registered yet */
  MRPC_TRADE_EA_NOT_READY: 'MRPC_TRADE_EA_NOT_READY',
  /** 500: the trade EA stopped before sending the request (nothing executed) */
  MRPC_TRADE_EA_STOPPED: 'MRPC_TRADE_EA_STOPPED',
  /** 504: gave up before the terminal took the command (not executed) */
  MRPC_ABANDONED: 'MRPC_ABANDONED',
  /** 504: a read timed out */
  MRPC_TIMEOUT: 'MRPC_TIMEOUT',
  /** 504: a trade timed out after the terminal took it (it may have executed) */
  MRPC_TRADE_OUTCOME_UNKNOWN: 'MRPC_TRADE_OUTCOME_UNKNOWN',
  /** 500: the terminal could not produce the history */
  MRPC_HISTORY_UNAVAILABLE: 'MRPC_HISTORY_UNAVAILABLE',
  /** 500: the terminal could not produce the price history */
  MRPC_PRICE_HISTORY_UNAVAILABLE: 'MRPC_PRICE_HISTORY_UNAVAILABLE',
  /** 500: a margin/profit calculation failed */
  MRPC_CALC_FAILED: 'MRPC_CALC_FAILED',
  /** 500: bridge fault */
  MRPC_INTERNAL: 'MRPC_INTERNAL',
  /** 500: bridge fault */
  MRPC_UNKNOWN_COMMAND: 'MRPC_UNKNOWN_COMMAND',
  /** the generic code of bridges before MT5 0.17.0 / MT4 0.15.0 */
  MRPC: 'MRPC',
} as const;
export type TerminalErrorCode =
  (typeof TerminalErrorCode)[keyof typeof TerminalErrorCode];
