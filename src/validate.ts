/**
 * Input coercion and client-side validation.
 *
 * Everything here runs *before* a request goes out, so a malformed order fails
 * fast and, above all, safely: the same constraints the terminal enforces
 * (volume > 0, an entry price for pending orders, a stop-limit price for
 * `*StopLimit`) plus a guard against the silent `orderModify` footgun where a
 * literal `0` stop-loss / take-profit *removes* the protection.
 */

import {
  OrderOperation,
  PENDING_OPERATIONS,
  STOP_LIMIT_OPERATIONS,
  Timeframe,
  type OrderOperationInput,
  type Platform,
  type TimeframeInput,
} from './enums.js';
import { UnsupportedOnPlatformError, ValidationError } from './errors.js';
import type { TimeInput } from './types.js';

const OPERATION_BY_NORMALIZED = new Map<string, OrderOperation>(
  Object.values(OrderOperation).map((op) => [op.toLowerCase(), op]),
);

const TIMEFRAME_ALIASES = new Map<string, Timeframe>([
  ['1min', Timeframe.M1],
  ['5min', Timeframe.M5],
  ['15min', Timeframe.M15],
  ['30min', Timeframe.M30],
  ['1h', Timeframe.H1],
  ['4h', Timeframe.H4],
  ['1d', Timeframe.D1],
  ['1w', Timeframe.W1],
  ['1month', Timeframe.MN1],
  ['1mn', Timeframe.MN1],
]);

const TIMEFRAME_BY_LABEL = new Map<string, Timeframe>(
  Object.values(Timeframe).map((tf) => [tf.toUpperCase(), tf]),
);

function inspect(value: unknown): string {
  return typeof value === 'string' ? `'${value}'` : String(value);
}

/** Normalize an order operation (case/separator-insensitive). */
export function coerceOperation(value: OrderOperationInput): OrderOperation {
  const key = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  const operation = OPERATION_BY_NORMALIZED.get(key);
  if (operation === undefined) {
    throw new ValidationError(`Unknown order operation: ${inspect(value)}`);
  }
  return operation;
}

/** Normalize a timeframe label (`M5`, `5min`, `1h`, …). */
export function coerceTimeframe(value: TimeframeInput): Timeframe {
  const raw = String(value).trim();
  const canonical = TIMEFRAME_BY_LABEL.get(raw.toUpperCase());
  if (canonical !== undefined) return canonical;
  const alias = TIMEFRAME_ALIASES.get(raw.toLowerCase());
  if (alias === undefined) {
    const supported = Object.values(Timeframe).join(', ');
    throw new ValidationError(
      `Unknown timeframe: ${inspect(value)}; the terminal API accepts ${supported}`,
    );
  }
  return alias;
}

/**
 * Validate the platform of a password link, the way the API's enum does.
 * cTrader has no password link: its accounts are linked from the dashboard
 * with a cTrader ID sign-in, and the API refuses them (HTTP 400).
 */
export function coercePlatform(value: unknown): Platform {
  if (value === 'mt4' || value === 'mt5') return value;
  if (value === 'ctrader') {
    throw new ValidationError(
      'cTrader accounts are linked from the FxSocket dashboard (sign in with cTrader), not through the API',
    );
  }
  throw new ValidationError(`platform must be one of mt4, mt5, got ${inspect(value)}`);
}

/**
 * Throw `ValidationError` unless `timeframe` is one the terminal API accepts.
 *
 * @deprecated MT4 and MT5 accept the same timeframes, so there is nothing
 * platform-specific left to check; use {@link coerceTimeframe}. Kept so
 * existing imports compile; will be removed in 1.0.
 */
export function checkTimeframe(timeframe: Timeframe, _platform?: Platform): void {
  coerceTimeframe(timeframe);
}

export function requirePositiveVolume(volume: number): void {
  if (!(volume > 0)) {
    throw new ValidationError(`volume must be > 0, got ${volume}`);
  }
}

export interface OrderSendConstraints {
  volume: number;
  price?: number;
  stopLimitPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
}

/** Mirror the terminal's own `/OrderSend` validation, fail-fast. */
export function validateOrderSend(
  operation: OrderOperation,
  fields: OrderSendConstraints,
): void {
  requirePositiveVolume(fields.volume);
  if (PENDING_OPERATIONS.has(operation) && !(Number(fields.price) > 0)) {
    throw new ValidationError(`price is required for pending orders (${operation})`);
  }
  if (STOP_LIMIT_OPERATIONS.has(operation) && !(Number(fields.stopLimitPrice) > 0)) {
    throw new ValidationError(`stop_limit_price is required for ${operation} orders`);
  }
  // On send, 0 / absent legitimately means "no SL/TP"; only negatives are wrong.
  if (fields.stopLoss !== undefined && fields.stopLoss < 0) {
    throw new ValidationError(`stopLoss must be >= 0, got ${fields.stopLoss}`);
  }
  if (fields.takeProfit !== undefined && fields.takeProfit < 0) {
    throw new ValidationError(`takeProfit must be >= 0, got ${fields.takeProfit}`);
  }
}

/** Why a platform has no MT5-style stop-limit order. */
const NO_STOP_LIMIT: Partial<Record<Platform, { label: string; reason: string }>> = {
  mt4: { label: 'MT4', reason: 'it has no stop-limit order type' },
  ctrader: {
    label: 'cTrader',
    reason: 'its stop-limit fills within a range beyond the stop instead of resting as a limit',
  },
};

/**
 * Refuse what a platform cannot do, before anything is sent: stop-limit orders
 * on MT4 (no such order type) and cTrader (a different order). Their terminal
 * APIs reject `*StopLimit` operations (400 `MRPC_UNSUPPORTED`), and MT4 would
 * silently ignore a `stopLimitPrice` on modify.
 */
export function rejectUnsupportedOnPlatform(
  platform: Platform,
  fields: { operation?: OrderOperation; stopLimitPrice?: number },
): void {
  const gate = NO_STOP_LIMIT[platform];
  if (gate === undefined) return;
  if (fields.operation !== undefined && STOP_LIMIT_OPERATIONS.has(fields.operation)) {
    throw new UnsupportedOnPlatformError(
      `${fields.operation} orders are not supported on ${gate.label} (${gate.reason})`,
    );
  }
  if (fields.stopLimitPrice !== undefined) {
    throw new UnsupportedOnPlatformError(
      `stopLimitPrice is not supported on ${gate.label} (${gate.reason})`,
    );
  }
}

/** Longest `clientOrderId` the terminal accepts, in characters. */
export const CLIENT_ORDER_ID_MAX_LENGTH = 64;

/** Throw `ValidationError` unless `value` is a usable `clientOrderId`. */
export function validateClientOrderId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new ValidationError(`clientOrderId must be a string, got ${inspect(value)}`);
  }
  // The terminal counts characters (code points), not UTF-16 units.
  const length = [...value].length;
  if (length < 1 || length > CLIENT_ORDER_ID_MAX_LENGTH) {
    throw new ValidationError(
      `clientOrderId must be 1-${CLIENT_ORDER_ID_MAX_LENGTH} characters, got ${length}`,
    );
  }
  return value;
}

/** Most symbols one `symbolSelect()` / `symbolInfos()` call takes. */
export const MAX_BULK_SYMBOLS = 100;

/** Validate the symbol list of a bulk call, before anything is sent. */
export function validateSymbolList(symbols: unknown, where: string): string[] {
  if (!Array.isArray(symbols)) {
    throw new ValidationError(`${where}: symbols must be an array of symbol names`);
  }
  if (symbols.length === 0) {
    throw new ValidationError(`${where}: symbols must not be empty`);
  }
  if (symbols.length > MAX_BULK_SYMBOLS) {
    throw new ValidationError(
      `${where}: at most ${MAX_BULK_SYMBOLS} symbols per call, got ${symbols.length}`,
    );
  }
  for (const symbol of symbols) {
    if (typeof symbol !== 'string' || symbol.trim() === '') {
      throw new ValidationError(
        `${where}: every symbol must be a non-empty string, got ${inspect(symbol)}`,
      );
    }
    if (symbol.includes(',')) {
      throw new ValidationError(
        `${where}: a symbol name cannot contain a comma, got ${inspect(symbol)}`,
      );
    }
  }
  return symbols as string[];
}

/**
 * Resolve an order's expiry to wire fields: `expiration` (broker server time)
 * or `expirationUtc` (real UTC), never both.
 */
export function resolveExpiration(input: {
  expiration?: TimeInput;
  expirationUtc?: TimeInput;
}): { expiration?: string; expirationUtc?: string } {
  if (input.expiration !== undefined && input.expirationUtc !== undefined) {
    throw new ValidationError(
      'pass either expiration (broker server time) or expirationUtc, not both',
    );
  }
  return {
    expiration: formatTime(input.expiration),
    expirationUtc: formatUtcTime(input.expirationUtc),
  };
}

export interface ModifyInput {
  stopLoss?: number;
  takeProfit?: number;
  price?: number;
  stopLimitPrice?: number;
  clearStopLoss?: boolean;
  clearTakeProfit?: boolean;
}

/**
 * Validate an `orderModify` and resolve SL/TP to wire values.
 *
 * Returns `{stopLoss, takeProfit}` where `undefined` means "omit → keep
 * current" and `0` means "clear". A bare `stopLoss: 0` is rejected because,
 * sent verbatim, the terminal would silently *remove* the protection — removal
 * must be explicit via `clearStopLoss`.
 */
export function resolveModifyStops(input: ModifyInput): {
  stopLoss?: number;
  takeProfit?: number;
} {
  const {
    stopLoss,
    takeProfit,
    price,
    stopLimitPrice,
    clearStopLoss = false,
    clearTakeProfit = false,
  } = input;

  if (clearStopLoss && stopLoss !== undefined) {
    throw new ValidationError(
      'pass either stopLoss=<price> or clearStopLoss=true, not both',
    );
  }
  if (clearTakeProfit && takeProfit !== undefined) {
    throw new ValidationError(
      'pass either takeProfit=<price> or clearTakeProfit=true, not both',
    );
  }
  if (stopLoss !== undefined && stopLoss <= 0) {
    throw new ValidationError(
      'stopLoss must be > 0 in orderModify; pass clearStopLoss=true to remove it, ' +
        'or leave it undefined to keep the current value',
    );
  }
  if (takeProfit !== undefined && takeProfit <= 0) {
    throw new ValidationError(
      'takeProfit must be > 0 in orderModify; pass clearTakeProfit=true to remove ' +
        'it, or leave it undefined to keep the current value',
    );
  }
  if (price !== undefined && price <= 0) {
    throw new ValidationError(`price must be > 0, got ${price}`);
  }
  if (stopLimitPrice !== undefined && stopLimitPrice <= 0) {
    throw new ValidationError(`stopLimitPrice must be > 0, got ${stopLimitPrice}`);
  }
  return {
    stopLoss: clearStopLoss ? 0 : stopLoss,
    takeProfit: clearTakeProfit ? 0 : takeProfit,
  };
}

/**
 * Serialize a time input.
 *
 * A string passes through verbatim, which is the unambiguous way to express
 * these fields: the terminal reads them as *broker server time*, and no zone
 * conversion the SDK could perform would be right for every broker.
 *
 * A `Date` is rendered as its UTC wall clock without a zone suffix
 * (`2030-01-01T00:00:00`). Using UTC rather than the host's local time keeps
 * the value identical whatever `TZ` the process runs under — an order's expiry
 * must not depend on which machine sent it.
 */
export function formatTime(value: TimeInput | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (!(value instanceof Date)) return String(value);
  if (Number.isNaN(value.getTime())) {
    throw new ValidationError('an invalid Date cannot be sent as a timestamp');
  }
  return value.toISOString().slice(0, 19);
}

/**
 * Serialize a real-UTC time input (`expirationUtc`).
 *
 * A `Date` is an instant, so it is rendered in UTC with a `Z`
 * (`2030-01-01T21:30:00Z`, whole seconds). A string passes through verbatim;
 * the terminal accepts ISO-8601 in UTC (`Z` or `+00:00`, or no zone).
 */
export function formatUtcTime(value: TimeInput | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (!(value instanceof Date)) return String(value);
  if (Number.isNaN(value.getTime())) {
    throw new ValidationError('an invalid Date cannot be sent as a timestamp');
  }
  return `${value.toISOString().slice(0, 19)}Z`;
}

/** Require a whole number, the way the API's integer fields do. */
export function requireInteger(value: unknown, where: string, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ValidationError(
      `${where}: ${field} must be a whole number, got ${inspect(value)}`,
    );
  }
  return value;
}

/** Drop keys whose value is `undefined`, so omitted fields aren't sent. */
export function compact<T extends Record<string, unknown>>(input: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}

/** Reject unknown keys on a caller-supplied object, mirroring the API. */
export function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  where: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new ValidationError(
      `${where}: unknown field${unknown.length > 1 ? 's' : ''} ${unknown
        .map((k) => `'${k}'`)
        .join(', ')}`,
    );
  }
}

/** Coerce a string value against a known set, or raise listing the choices. */
export function coerceChoice<T extends string>(
  value: unknown,
  choices: readonly T[],
  where: string,
  field: string,
): T {
  const normalized = String(value).toLowerCase();
  const match = choices.find((choice) => choice.toLowerCase() === normalized);
  if (match === undefined) {
    throw new ValidationError(
      `${where}: ${field} must be one of ${choices.join(', ')}, got ${inspect(value)}`,
    );
  }
  return match;
}
