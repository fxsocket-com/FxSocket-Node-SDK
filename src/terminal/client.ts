/**
 * Per-account terminal REST client (MT4, MT5 and cTrader).
 *
 * One {@link TerminalClient} is bound to a single account's terminal endpoint
 * (`Account.restUrl`).
 *
 * MT4 and MT5 share one interface. Both terminal APIs accept the same nine
 * timeframes (see {@link Timeframe}); a timeframe outside that set raises
 * {@link ValidationError} before the request goes out. The one platform gap is
 * stop-limit orders, which MT4 does not have: on an MT4 account a `*StopLimit`
 * operation, or a `stopLimitPrice` on `orderModify`, throws
 * {@link UnsupportedOnPlatformError} before anything is sent.
 *
 * Order inputs are validated client-side to fail fast and, above all, safely —
 * see `validate.ts`. No request is auto-retried: order send/modify/close must
 * never replay, to avoid duplicate fills. Send orders with a `clientOrderId`
 * to make a deliberate retry safe.
 *
 * cTrader accounts (bridge 0.1.6) add a few things MT4 and MT5 do not have:
 * `trailingStop` and `guaranteedStopLoss` on `orderSend` and `orderModify`
 * (cTrader's own stop loss kinds, both need a stop loss), `clientOrderId` on
 * `orderModify` and `orderClose` too (one set of ids with `orderSend`), and
 * {@link TerminalClient.journal}. The client knows the account's platform, so
 * on MT4 and MT5 these throw {@link UnsupportedOnPlatformError} before anything
 * is sent. `trailingStop: false` and `guaranteedStopLoss: false` are not sent
 * there, since every MT stop loss is already a fixed, normal one.
 */

import type { Dispatcher } from 'undici';

import {
  decodeAccountInfo,
  decodeAccountSummary,
  decodeCandle,
  decodeCloseAllSummary,
  decodeHealth,
  decodeHealthChecks,
  decodeHistoryTrade,
  decodeJournal,
  decodeList,
  decodeMarginCalc,
  decodeOpenedOrder,
  decodeOrderResult,
  decodePendingOrder,
  decodePositionTrade,
  decodeProfitCalc,
  decodeQuote,
  decodeServerTimezone,
  decodeSymbolInfo,
  decodeSymbolInfoBatch,
  decodeSymbolSelectResult,
} from '../decode.js';
import type {
  ExecutionInput,
  JournalKind,
  OrderOperationInput,
  Platform,
  TimeframeInput,
} from '../enums.js';
import { errorFromResponse, ValidationError } from '../errors.js';
import type { ErrorResponse } from '../errors.js';
import { HttpTransport } from '../http.js';
import type {
  AccountInfo,
  AccountSummary,
  Candle,
  CloseAllSummary,
  Health,
  HealthChecks,
  HistoryTrade,
  JournalEntry,
  MarginCalc,
  OpenedOrder,
  OrderResult,
  PendingOrder,
  PositionTrade,
  ProfitCalc,
  Quote,
  ServerTimezone,
  SymbolInfo,
  SymbolInfoBatch,
  SymbolSelectResult,
  TimeInput,
} from '../types.js';
import {
  coerceExecution,
  coerceOperation,
  coerceTimeframe,
  compact,
  ctraderClientOrderId,
  formatTime,
  journalParams,
  rejectUnsupportedOnPlatform,
  requirePositiveVolume,
  requireStopLossForStopKinds,
  resolveExpiration,
  resolveModifyStops,
  resolveStopKinds,
  validateClientOrderId,
  validateManualOrder,
  validateOrderSend,
  validateSymbolList,
} from '../validate.js';

export interface TerminalClientOptions {
  /** Base URL of the account's terminal REST API (`Account.restUrl`). */
  baseUrl: string;
  apiKey: string;
  platform: Platform;
  /** Verify TLS. Pass `false` for a private droplet's self-signed certificate. */
  verify?: boolean;
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
  /** A dispatcher to use instead of the default one. */
  dispatcher?: Dispatcher;
}

/** A time range for the history endpoints. Both bounds are optional. */
export interface TimeRange {
  from?: TimeInput;
  to?: TimeInput;
}

export interface OrderSendParams {
  /** Exactly as the account's broker names it (`EURUSD`, `EURUSD.sd`…). */
  symbol: string;
  /** `Buy`, `SellLimit`, … — case-insensitive. */
  operation: OrderOperationInput;
  /** Lots; must be > 0. */
  volume: number;
  /** Entry price — required for pending orders, ignored for market orders. */
  price?: number;
  /** Points; the terminal defaults to 10 when omitted. */
  slippage?: number;
  stopLoss?: number;
  takeProfit?: number;
  /** Required for `*StopLimit` operations (MT5 only). */
  stopLimitPrice?: number;
  /**
   * When a pending order expires, in broker server time. Omit for
   * good-till-cancelled. Cannot be combined with `expirationUtc`.
   */
  expiration?: TimeInput;
  /**
   * When a pending order expires, in real UTC: a `Date`, or an ISO-8601 UTC
   * string (`2026-11-03T17:00:00Z`). The terminal converts it with the
   * broker's current offset. Cannot be combined with `expiration`. Brokers set
   * a minimum distance (often a few minutes ahead).
   */
  expirationUtc?: TimeInput;
  comment?: string;
  /** Magic number written onto the order (`expertId` on the wire). */
  magic?: number;
  /**
   * Your own id for this order (1-64 characters, remembered by the terminal
   * for 10 minutes). It makes a retry safe: a repeat with the same id trades
   * nothing and answers with the first request's result (`idempotentReplayed`
   * on the result). Reusing an id for a different order throws
   * {@link ClientOrderIdReusedError}.
   */
  clientOrderId?: string;
  /**
   * `EA` (default) or `Manual`: see {@link Execution}. A Manual order goes
   * through the account's own order dialog, for brokers that refuse expert
   * trading. Market orders (`Buy` / `Sell`) only, magic 0, not on cTrader;
   * anything else throws before sending. {@link ManualNotSentError} means
   * nothing was sent. Needs bridge MT5 0.18.0 / MT4 0.16.0; older bridges
   * ignore it and send the order the normal way.
   */
  execution?: ExecutionInput;
  /**
   * cTrader only: `true` makes the stop loss a trailing stop, which follows the
   * price at the distance it was placed at. Needs `stopLoss`.
   */
  trailingStop?: boolean;
  /**
   * cTrader only: `true` makes the stop loss guaranteed (filled at its level
   * even through a gap, for a fee) where the broker offers it
   * (`symbolInfo().guaranteedStopLoss`). Needs `stopLoss`. On a limited-risk
   * account (`accountInfo().limitedRisk`) every order gets one by default and
   * needs a `stopLoss`.
   */
  guaranteedStopLoss?: boolean;
}

export interface OrderModifyParams {
  /** New stop-loss price. Must be > 0 — use `clearStopLoss` to remove one. */
  stopLoss?: number;
  /** New take-profit price. Must be > 0 — use `clearTakeProfit` to remove one. */
  takeProfit?: number;
  /** New entry price, for a pending order. */
  price?: number;
  /** New stop-limit price, for a stop-limit pending order (MT5 only). */
  stopLimitPrice?: number;
  /** New expiry, in broker server time. Cannot be combined with `expirationUtc`. */
  expiration?: TimeInput;
  /** New expiry, in real UTC (see {@link OrderSendParams.expirationUtc}). */
  expirationUtc?: TimeInput;
  /** Remove the stop-loss. Cannot be combined with `stopLoss`. */
  clearStopLoss?: boolean;
  /** Remove the take-profit. Cannot be combined with `takeProfit`. */
  clearTakeProfit?: boolean;
  /**
   * cTrader only: `true` turns the stop loss into a trailing stop, `false` back
   * into a fixed one. Omit to keep it. Removing the stop loss drops it.
   */
  trailingStop?: boolean;
  /**
   * cTrader only: `true` makes the stop loss guaranteed, `false` a normal one.
   * Omit to keep it.
   */
  guaranteedStopLoss?: boolean;
  /**
   * cTrader only: your id for this change (1-64 characters). The ids of send,
   * modify and close are one set: a repeat within 10 minutes changes nothing
   * and answers with the first outcome (`idempotentReplayed`), and reusing an
   * id for a different request throws {@link ClientOrderIdReusedError}.
   */
  clientOrderId?: string;
}

export interface OrderCloseParams {
  /** Partial-close volume; omit for a full close. */
  volume?: number;
  /** Points; the terminal defaults to 10 when omitted. */
  slippage?: number;
  /**
   * Only delete a pending order, never close a position. If the order has
   * filled by now, the position stays open and {@link NotPendingError} is
   * thrown. On MT5 a partly filled order loses its unfilled rest and keeps
   * the position. Needs bridge MT5 0.18.0 / MT4 0.16.0: older bridges ignore
   * the flag and close the position, so check `status().bridge.version`.
   */
  pendingOnly?: boolean;
  /**
   * cTrader only: your id for this close (1-64 characters, one set with
   * `orderSend`'s). A repeat closes nothing more and answers with the first
   * outcome, so a partial close that timed out can be sent again safely.
   */
  clientOrderId?: string;
}

export interface JournalParams {
  /** Most entries to return, newest first: 1-1000 (the terminal's default is 100). */
  limit?: number;
  /**
   * Only entries at or after this moment, in UTC: a `Date`, or a string such
   * as `2026-11-22T21:00:00Z`.
   */
  since?: TimeInput;
  /** `connection` or `trade` (see {@link JournalKind}); omit for both. */
  kind?: JournalKind;
}

export interface CloseAllParams {
  /** Only close this symbol; omit for every symbol. */
  symbol?: string;
  /** Only close orders with this magic number. `0` matches manual orders. */
  magic?: number;
  /** Also delete matching pending orders. */
  deletePending?: boolean;
}

/** A terminal REST client bound to one account's endpoint. */
export class TerminalClient {
  /** Platform of the account this client is bound to. */
  readonly platform: Platform;
  /** Base URL of the terminal REST API. */
  readonly baseUrl: string;
  private readonly http: HttpTransport;

  constructor(options: TerminalClientOptions) {
    this.platform = options.platform;
    this.baseUrl = options.baseUrl;
    this.http = new HttpTransport({
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      timeoutMs: options.timeoutMs ?? 30_000,
      verifyTls: options.verify ?? true,
      dispatcher: options.dispatcher,
    });
  }

  // -- account state ------------------------------------------------------ //

  /** Live financial snapshot: balance, equity, margin, … */
  async accountSummary(): Promise<AccountSummary> {
    return decodeAccountSummary(await this.http.request('GET', '/AccountSummary'));
  }

  /** Static account identity + configuration. */
  async accountInfo(): Promise<AccountInfo> {
    return decodeAccountInfo(await this.http.request('GET', '/AccountInfo'));
  }

  /** Open positions and resting pending orders. */
  async openedOrders(): Promise<OpenedOrder[]> {
    return decodeList(
      await this.http.request('GET', '/OpenedOrders'),
      decodeOpenedOrder,
    );
  }

  /**
   * The active pending orders, with what a copy of one needs: stop-limit
   * price, initial volume, expiry mode and expiry (server time and UTC).
   * Bridges MT5 0.17.0+ / MT4 0.15.0+.
   */
  async pendingOrders(): Promise<PendingOrder[]> {
    return decodeList(
      await this.http.request('GET', '/PendingOrders'),
      decodePendingOrder,
    );
  }

  /** Historical deals / closed orders, optionally bounded by a time range. */
  async orderHistory(range: TimeRange = {}): Promise<HistoryTrade[]> {
    const params = compact({ from: formatTime(range.from), to: formatTime(range.to) });
    return decodeList(
      await this.http.request('GET', '/OrderHistory', { params }),
      decodeHistoryTrade,
    );
  }

  /** Closed round-trip positions, optionally bounded by a time range. */
  async positionHistory(range: TimeRange = {}): Promise<PositionTrade[]> {
    const params = compact({ from: formatTime(range.from), to: formatTime(range.to) });
    return decodeList(
      await this.http.request('GET', '/PositionHistory', { params }),
      decodePositionTrade,
    );
  }

  /** Broker server clock and its UTC offset. */
  async serverTimezone(): Promise<ServerTimezone> {
    return decodeServerTimezone(await this.http.request('GET', '/ServerTimezone'));
  }

  /**
   * The account's journal, newest first (`GET /Journal`). cTrader only (bridge
   * 0.1.6): on MT4 / MT5 this throws {@link UnsupportedOnPlatformError}.
   *
   * Connection entries say when the account signed in at cTrader, became ready,
   * lost and regained its connection, and when its token was refreshed or
   * refused. Trade entries hold every send, modify, close and close-all with
   * its request, outcome, duration, `clientOrderId`, `User-Agent` and client
   * address. The journal lives in the bridge's memory: the newest 1000 entries
   * of at most 7 days, emptied when the bridge restarts. Use
   * {@link TerminalClient.orderHistory} for the full record.
   */
  async journal(params: JournalParams = {}): Promise<JournalEntry[]> {
    const query = journalParams(this.platform, params);
    return decodeJournal(await this.http.request('GET', '/Journal', { params: query }));
  }

  // -- market data -------------------------------------------------------- //

  /** Every symbol this account can trade, as the broker names them. */
  async symbols(): Promise<string[]> {
    const rows = await this.http.request<unknown>('GET', '/symbols');
    return Array.isArray(rows) ? rows.map((row) => String(row)) : [];
  }

  /** Latest tick for a symbol. */
  async quote(symbol: string): Promise<Quote> {
    return decodeQuote(
      await this.http.request('GET', '/getQuote', { params: { symbol } }),
    );
  }

  /** Contract specification for a symbol. */
  async symbolInfo(symbol: string): Promise<SymbolInfo> {
    return decodeSymbolInfo(
      await this.http.request('GET', '/SymbolInfo', { params: { symbol } }),
    );
  }

  /**
   * Contract specifications for up to 100 symbols in one call. Symbols that
   * do not resolve come back in `errors` instead of failing the call. The
   * terminal also selects them all into Market Watch on the way, so this warms
   * them up like {@link TerminalClient.symbolSelect}. Bridges MT5 0.17.0+ /
   * MT4 0.15.0+.
   */
  async symbolInfos(symbols: readonly string[]): Promise<SymbolInfoBatch> {
    const names = validateSymbolList(symbols, 'symbolInfos');
    return decodeSymbolInfoBatch(
      await this.http.request('GET', '/SymbolInfo', {
        params: { symbols: names.join(',') },
      }),
    );
  }

  /**
   * Put up to 100 symbols into Market Watch in one pass, and wait (up to 1 s,
   * once) until the new ones quote. A symbol outside Market Watch has no quote,
   * so the first order on it waits for its first tick; selecting a copier's
   * symbols at start moves that wait out of the first trade. Needs a trading
   * key (a read-only key gets 403). Bridges MT5 0.17.0+ / MT4 0.15.0+.
   */
  async symbolSelect(symbols: readonly string[]): Promise<SymbolSelectResult[]> {
    const names = validateSymbolList(symbols, 'symbolSelect');
    return decodeList(
      await this.http.request('POST', '/SymbolSelect', { json: { symbols: names } }),
      decodeSymbolSelectResult,
    );
  }

  /**
   * OHLC bars for a symbol.
   *
   * **Bound the range.** Without `from` / `to` the terminal asks the broker for
   * its entire history for that timeframe — a million M1 bars on a typical demo
   * account — which usually exceeds the terminal's own deadline and comes back
   * as {@link TerminalTimeoutError}. A bounded request answers in well under a
   * second.
   *
   * On MT4 the opposite failure also exists: a bounded request (or the `D1`
   * timeframe) can fail server-side with `CopyRates failed` when the terminal
   * hasn't loaded that history yet.
   */
  async priceHistory(
    symbol: string,
    timeframe: TimeframeInput,
    range: TimeRange = {},
  ): Promise<Candle[]> {
    const tf = coerceTimeframe(timeframe);
    const params = compact({
      symbol,
      timeframe: tf,
      from: formatTime(range.from),
      to: formatTime(range.to),
    });
    return decodeList(
      await this.http.request('GET', '/PriceHistory', { params }),
      decodeCandle,
    );
  }

  // -- calculators -------------------------------------------------------- //

  /** Required margin for a hypothetical order. */
  async calcMargin(
    symbol: string,
    operation: OrderOperationInput,
    volume: number,
    price: number,
  ): Promise<MarginCalc> {
    const op = coerceOperation(operation);
    requirePositiveVolume(volume);
    return decodeMarginCalc(
      await this.http.request('GET', '/OrderCalcMargin', {
        params: { symbol, operation: op, volume, price },
      }),
    );
  }

  /** Projected P/L for a hypothetical trade. */
  async calcProfit(
    symbol: string,
    operation: OrderOperationInput,
    volume: number,
    priceOpen: number,
    priceClose: number,
  ): Promise<ProfitCalc> {
    const op = coerceOperation(operation);
    requirePositiveVolume(volume);
    return decodeProfitCalc(
      await this.http.request('GET', '/OrderCalcProfit', {
        params: { symbol, operation: op, volume, priceOpen, priceClose },
      }),
    );
  }

  // -- trading (never retried) -------------------------------------------- //

  /**
   * Place a market or pending order.
   *
   * A `200` only means the terminal answered — check the body: `success` is
   * true for retcode `10009` (done) or `10008` (placed).
   *
   * A 504 comes in two kinds. {@link TradeOutcomeUnknownError}: the terminal
   * took the order and it may have executed, so reconcile or re-send with the
   * same `clientOrderId`. {@link TradeAbandonedError}: it never reached the
   * terminal, so re-sending is safe.
   */
  async orderSend(params: OrderSendParams): Promise<OrderResult> {
    const operation = coerceOperation(params.operation);
    rejectUnsupportedOnPlatform(this.platform, { operation });
    validateOrderSend(operation, {
      volume: params.volume,
      price: params.price,
      stopLimitPrice: params.stopLimitPrice,
      stopLoss: params.stopLoss,
      takeProfit: params.takeProfit,
    });
    const execution = coerceExecution(params.execution);
    if (execution === 'Manual') {
      validateManualOrder(this.platform, operation, params);
    }
    const stopKinds = resolveStopKinds(this.platform, params);
    requireStopLossForStopKinds({ ...stopKinds, stopLoss: params.stopLoss });
    const clientOrderId = validateClientOrderId(params.clientOrderId);
    const { expiration, expirationUtc } = resolveExpiration(params);
    const body = compact({
      symbol: params.symbol,
      operation,
      volume: params.volume,
      price: params.price,
      slippage: params.slippage,
      stopLoss: params.stopLoss,
      takeProfit: params.takeProfit,
      stopLimitPrice: params.stopLimitPrice,
      expiration,
      expirationUtc,
      comment: params.comment,
      expertId: params.magic,
      clientOrderId,
      execution,
      trailingStop: stopKinds.trailingStop,
      guaranteedStopLoss: stopKinds.guaranteedStopLoss,
    });
    return this.trade('/OrderSend', body);
  }

  /**
   * Change the stops, entry price or expiry of an existing order.
   *
   * A literal `stopLoss: 0` would *remove* the stop-loss, so it is rejected —
   * pass `clearStopLoss: true` to remove one deliberately, while omitting the
   * field keeps the current value.
   *
   * On cTrader `trailingStop`, `guaranteedStopLoss` and `clientOrderId` apply
   * too (see {@link OrderModifyParams}).
   */
  async orderModify(
    ticket: number,
    params: OrderModifyParams = {},
  ): Promise<OrderResult> {
    rejectUnsupportedOnPlatform(this.platform, {
      stopLimitPrice: params.stopLimitPrice,
    });
    const stopKinds = resolveStopKinds(this.platform, params);
    const clientOrderId = ctraderClientOrderId(
      this.platform,
      params.clientOrderId,
      'orderModify',
    );
    const { stopLoss, takeProfit } = resolveModifyStops(params);
    if (
      params.clearStopLoss === true &&
      (stopKinds.trailingStop === true || stopKinds.guaranteedStopLoss === true)
    ) {
      throw new ValidationError(
        'trailingStop and guaranteedStopLoss need a stop loss; clearStopLoss removes it',
      );
    }
    const { expiration, expirationUtc } = resolveExpiration(params);
    const body = compact({
      ticket,
      stopLoss,
      takeProfit,
      price: params.price,
      stopLimitPrice: params.stopLimitPrice,
      expiration,
      expirationUtc,
      trailingStop: stopKinds.trailingStop,
      guaranteedStopLoss: stopKinds.guaranteedStopLoss,
      clientOrderId,
    });
    return this.trade('/OrderModify', body);
  }

  /**
   * Close a position, or delete a pending order, by ticket. On cTrader a
   * `clientOrderId` makes the close safe to repeat.
   */
  async orderClose(
    ticket: number,
    params: OrderCloseParams = {},
  ): Promise<OrderResult> {
    if (params.volume !== undefined && params.volume < 0) {
      throw new ValidationError(`volume must be >= 0, got ${params.volume}`);
    }
    const clientOrderId = ctraderClientOrderId(
      this.platform,
      params.clientOrderId,
      'orderClose',
    );
    const body = compact({
      ticket,
      volume: params.volume,
      slippage: params.slippage,
      pendingOnly: params.pendingOnly === true ? true : undefined,
      clientOrderId,
    });
    return this.trade('/OrderClose', body);
  }

  /**
   * Close every open position in one trade-EA pass.
   *
   * Optionally filtered by `symbol` and/or `magic` (`magic: 0` matches
   * manually-opened orders; omitting it means no filter); `deletePending: true`
   * also deletes matching pending orders. The reply carries a per-ticket result
   * for every attempted close/delete.
   *
   * Positions opened while the pass is running are not covered. On a 504
   * ({@link TradeOutcomeUnknownError}, or {@link TerminalTimeoutError} on older
   * bridges) the pass *continues to completion inside the terminal*, so check
   * {@link TerminalClient.openedOrders} before acting again rather than
   * re-sending. Only a {@link TradeAbandonedError} means the pass never
   * started.
   */
  async closeAll(params: CloseAllParams = {}): Promise<CloseAllSummary> {
    // magic=0 is a real filter (manually-opened orders) — only undefined is
    // omitted. An empty body is valid: it means "close everything".
    const body = compact({
      symbol: params.symbol,
      magic: params.magic,
      deletePending: params.deletePending ? true : undefined,
    });
    return decodeCloseAllSummary(
      await this.http.request('POST', '/CloseAll', { json: body }),
    );
  }

  /** POST a trade command and decode its reply, headers included. */
  private async trade(
    path: string,
    body: Record<string, unknown>,
  ): Promise<OrderResult> {
    const response = await this.http.send('POST', path, { json: body });
    return decodeOrderResult(response.body, response.headers);
  }

  // -- health ------------------------------------------------------------- //

  /** Full health snapshot. Always answers HTTP 200. */
  async status(): Promise<Health> {
    return decodeHealth(await this.http.request('GET', '/status'));
  }

  /** Readiness probe. Answers 503 with a body when not ready. */
  async healthz(): Promise<HealthChecks> {
    return this.probe('/healthz');
  }

  /** Liveness probe. Answers 503 with a body when down. */
  async livez(): Promise<HealthChecks> {
    return this.probe('/livez');
  }

  private async probe(path: string): Promise<HealthChecks> {
    // /healthz and /livez answer 503 when not-ready, with a useful body —
    // parse it instead of raising; only other codes are real errors.
    const response = await this.http.raw('GET', path);
    if (response.status !== 200 && response.status !== 503) {
      throw errorFromResponse(response as ErrorResponse);
    }
    return decodeHealthChecks(response.body);
  }

  // -- lifecycle ---------------------------------------------------------- //

  /** Release the underlying connection pool. */
  async close(): Promise<void> {
    await this.http.close();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
