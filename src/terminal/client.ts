/**
 * Per-account terminal REST client (MT4 + MT5).
 *
 * One {@link TerminalClient} is bound to a single account's terminal endpoint
 * (`Account.restUrl`).
 *
 * Platform awareness is enforced **client-side** before the request goes out:
 * MT5-only timeframes (`M2`/`M3`/`H2`/`H6`/`H8`/`H12`) don't exist on MT4, so
 * the SDK raises {@link UnsupportedOnPlatformError} rather than letting the
 * terminal answer 400. (Order *operations*, including stop-limit, are accepted
 * by both platforms' terminal APIs, so they are not gated.)
 *
 * Order inputs are validated client-side to fail fast and, above all, safely —
 * see `validate.ts`. No request is auto-retried: order send/modify/close must
 * never replay, to avoid duplicate fills.
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
  decodeList,
  decodeMarginCalc,
  decodeOpenedOrder,
  decodeOrderResult,
  decodePositionTrade,
  decodeProfitCalc,
  decodeQuote,
  decodeServerTimezone,
  decodeSymbolInfo,
} from '../decode.js';
import type { OrderOperationInput, Platform, TimeframeInput } from '../enums.js';
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
  MarginCalc,
  OpenedOrder,
  OrderResult,
  PositionTrade,
  ProfitCalc,
  Quote,
  ServerTimezone,
  SymbolInfo,
  TimeInput,
} from '../types.js';
import {
  checkTimeframe,
  coerceOperation,
  coerceTimeframe,
  compact,
  formatTime,
  requirePositiveVolume,
  resolveModifyStops,
  validateOrderSend,
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
  /** Required for `*StopLimit` operations. */
  stopLimitPrice?: number;
  /** Omit for good-till-cancelled. */
  expiration?: TimeInput;
  comment?: string;
  /** Magic number written onto the order (`expertId` on the wire). */
  magic?: number;
}

export interface OrderModifyParams {
  /** New stop-loss price. Must be > 0 — use `clearStopLoss` to remove one. */
  stopLoss?: number;
  /** New take-profit price. Must be > 0 — use `clearTakeProfit` to remove one. */
  takeProfit?: number;
  /** New entry price, for a pending order. */
  price?: number;
  stopLimitPrice?: number;
  expiration?: TimeInput;
  /** Remove the stop-loss. Cannot be combined with `stopLoss`. */
  clearStopLoss?: boolean;
  /** Remove the take-profit. Cannot be combined with `takeProfit`. */
  clearTakeProfit?: boolean;
}

export interface OrderCloseParams {
  /** Partial-close volume; omit for a full close. */
  volume?: number;
  /** Points; the terminal defaults to 10 when omitted. */
  slippage?: number;
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
    checkTimeframe(tf, this.platform);
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
   */
  async orderSend(params: OrderSendParams): Promise<OrderResult> {
    const operation = coerceOperation(params.operation);
    validateOrderSend(operation, {
      volume: params.volume,
      price: params.price,
      stopLimitPrice: params.stopLimitPrice,
      stopLoss: params.stopLoss,
      takeProfit: params.takeProfit,
    });
    const body = compact({
      symbol: params.symbol,
      operation,
      volume: params.volume,
      price: params.price,
      slippage: params.slippage,
      stopLoss: params.stopLoss,
      takeProfit: params.takeProfit,
      stopLimitPrice: params.stopLimitPrice,
      expiration: formatTime(params.expiration),
      comment: params.comment,
      expertId: params.magic,
    });
    return decodeOrderResult(
      await this.http.request('POST', '/OrderSend', { json: body }),
    );
  }

  /**
   * Change the stops, entry price or expiry of an existing order.
   *
   * A literal `stopLoss: 0` would *remove* the stop-loss, so it is rejected —
   * pass `clearStopLoss: true` to remove one deliberately, while omitting the
   * field keeps the current value.
   */
  async orderModify(
    ticket: number,
    params: OrderModifyParams = {},
  ): Promise<OrderResult> {
    const { stopLoss, takeProfit } = resolveModifyStops(params);
    const body = compact({
      ticket,
      stopLoss,
      takeProfit,
      price: params.price,
      stopLimitPrice: params.stopLimitPrice,
      expiration: formatTime(params.expiration),
    });
    return decodeOrderResult(
      await this.http.request('POST', '/OrderModify', { json: body }),
    );
  }

  /** Close a position, or delete a pending order, by ticket. */
  async orderClose(
    ticket: number,
    params: OrderCloseParams = {},
  ): Promise<OrderResult> {
    if (params.volume !== undefined && params.volume < 0) {
      throw new ValidationError(`volume must be >= 0, got ${params.volume}`);
    }
    const body = compact({
      ticket,
      volume: params.volume,
      slippage: params.slippage,
    });
    return decodeOrderResult(
      await this.http.request('POST', '/OrderClose', { json: body }),
    );
  }

  /**
   * Close every open position in one trade-EA pass.
   *
   * Optionally filtered by `symbol` and/or `magic` (`magic: 0` matches
   * manually-opened orders; omitting it means no filter); `deletePending: true`
   * also deletes matching pending orders. The reply carries a per-ticket result
   * for every attempted close/delete.
   *
   * Positions opened while the pass is running are not covered, and on a 504
   * ({@link TerminalTimeoutError}) the pass *continues to completion inside the
   * terminal* — check {@link TerminalClient.openedOrders} before acting again
   * rather than re-sending.
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
