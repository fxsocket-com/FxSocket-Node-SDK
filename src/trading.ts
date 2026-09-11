/**
 * Multi-account trading — `client.orders` (`/v1/orders`).
 *
 * One request fans out to several of your accounts' terminals concurrently;
 * each leg (order, or account to close on) may carry its own parameters and
 * inherits the batch `defaults` for the rest.
 *
 * **Validation is all-or-nothing, execution is not.** The SDK mirrors the API's
 * own leg validation client-side so a malformed batch fails before anything is
 * sent, and the API does the same again server-side (`400`). Once a batch is
 * dispatched the legs are independent: the reply is a `200` with a per-leg
 * result even if every one of them failed. There is no atomicity across brokers
 * and there cannot be.
 *
 * Send an `idempotencyKey` (an `Idempotency-Key` header) whenever a retry is
 * possible: a batch that times out is exactly when a client retries, and a
 * blind retry double-fills every leg that already landed. Replaying the
 * identical body with the same key returns the original reply and sends
 * nothing. Keys are remembered for 15 minutes.
 */

import { decodeBatchCloseResult, decodeBatchOrderResult } from './decode.js';
import { CloseKind, CloseSide, SymbolMatch } from './enums.js';
import { ValidationError } from './errors.js';
import type { HttpTransport } from './http.js';
import type {
  AccountRef,
  BatchCloseResult,
  BatchOrderResult,
  CloseDefaults,
  CloseLeg,
  CloseLegInput,
  OrderDefaults,
  OrderLeg,
  OrderLegInput,
} from './types.js';
import {
  coerceChoice,
  coerceOperation,
  compact,
  formatTime,
  rejectUnknownKeys,
  validateOrderSend,
} from './validate.js';

export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

const ORDER_FIELDS = [
  'symbol',
  'operation',
  'volume',
  'price',
  'slippage',
  'stopLoss',
  'takeProfit',
  'stopLimitPrice',
  'expiration',
  'comment',
  'magic',
  'expertId',
] as const;

const ORDER_DEFAULT_KEYS: ReadonlySet<string> = new Set(ORDER_FIELDS);
const ORDER_LEG_KEYS: ReadonlySet<string> = new Set([...ORDER_FIELDS, 'accountId']);

const CLOSE_FIELDS = [
  'symbol',
  'symbolMatch',
  'side',
  'kind',
  'magic',
  'volume',
  'slippage',
] as const;

const CLOSE_DEFAULT_KEYS: ReadonlySet<string> = new Set(CLOSE_FIELDS);
const CLOSE_LEG_KEYS: ReadonlySet<string> = new Set([
  ...CLOSE_FIELDS,
  'accountId',
  'tickets',
]);

/** Selector fields that cannot be combined with an explicit ticket list. */
const CLOSE_SELECTOR_FIELDS = [
  'symbol',
  'symbolMatch',
  'side',
  'kind',
  'magic',
] as const;

/**
 * Is this entry a bare account rather than a leg?
 *
 * An id string, or a decoded account — which is recognised by `id` *and*
 * `platform` together. Matching on `id` alone would swallow a hand-written
 * `{id, volume}`: it would be read as an account and the other fields silently
 * dropped, instead of failing with "accountId is required".
 */
function isAccountRef(value: unknown): value is AccountRef {
  if (typeof value === 'string') return true;
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { id?: unknown; platform?: unknown };
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.platform === 'string' &&
    !('accountId' in value)
  );
}

function accountIdOf(value: AccountRef, where: string): string {
  const id = typeof value === 'string' ? value : value?.id;
  if (typeof id !== 'string' || id === '') {
    throw new ValidationError(`${where}: accountId is required`);
  }
  return id;
}

function asRecord(
  value: unknown,
  where: string,
  what: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError(
      `${where}: expected ${what} or an account, got ${typeof value}`,
    );
  }
  return value as Record<string, unknown>;
}

function requireNumber(value: unknown, where: string, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError(
      `${where}: ${field} must be a number, got ${String(value)}`,
    );
  }
  return value;
}

/** Wire form of the order fields shared by defaults and legs. */
function orderFieldsPayload(
  raw: Record<string, unknown>,
  where: string,
): Record<string, unknown> {
  const fields = raw as OrderDefaults;
  const operation =
    fields.operation === undefined ? undefined : coerceOperation(fields.operation);
  const magic = fields.magic ?? fields.expertId;

  for (const field of [
    'volume',
    'price',
    'stopLoss',
    'takeProfit',
    'stopLimitPrice',
  ] as const) {
    if (fields[field] !== undefined) requireNumber(fields[field], where, field);
  }
  for (const field of ['slippage', 'magic', 'expertId'] as const) {
    if (fields[field] !== undefined) requireNumber(fields[field], where, field);
  }

  return compact({
    symbol: fields.symbol,
    operation,
    volume: fields.volume,
    price: fields.price,
    slippage: fields.slippage,
    stop_loss: fields.stopLoss,
    take_profit: fields.takeProfit,
    stop_limit_price: fields.stopLimitPrice,
    expiration: formatTime(fields.expiration),
    comment: fields.comment,
    expert_id: magic,
  });
}

/** Check a leg merged with its defaults the way the terminal would. */
function validateEffectiveOrder(
  effective: Record<string, unknown>,
  where: string,
): void {
  for (const field of ['symbol', 'operation', 'volume'] as const) {
    const value = effective[field];
    if (value === undefined || value === null || value === '') {
      throw new ValidationError(
        `${where}: ${field} is required (set it on the leg or in defaults)`,
      );
    }
  }
  try {
    validateOrderSend(coerceOperation(effective['operation'] as string), {
      volume: effective['volume'] as number,
      price: effective['price'] as number | undefined,
      stopLimitPrice: effective['stop_limit_price'] as number | undefined,
      stopLoss: effective['stop_loss'] as number | undefined,
      takeProfit: effective['take_profit'] as number | undefined,
    });
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new ValidationError(`${where}: ${error.message}`);
    }
    throw error;
  }
  const slippage = effective['slippage'];
  if (typeof slippage === 'number' && slippage < 0) {
    throw new ValidationError(`${where}: slippage must be >= 0, got ${slippage}`);
  }
}

/**
 * Build and validate the `POST /orders` body.
 *
 * Raises {@link ValidationError} before anything is sent.
 */
export function buildOrderBatch(
  orders: Iterable<OrderLegInput>,
  options: { defaults?: OrderDefaults; requireReachable?: boolean } = {},
): Record<string, unknown> {
  const rawDefaults = options.defaults ?? {};
  rejectUnknownKeys(
    asRecord(rawDefaults, 'defaults', 'order defaults'),
    ORDER_DEFAULT_KEYS,
    'defaults',
  );
  const defaultBody = orderFieldsPayload(
    rawDefaults as Record<string, unknown>,
    'defaults',
  );

  const legs: Record<string, unknown>[] = [];
  let index = 0;
  for (const entry of orders) {
    const where = `orders[${index}]`;
    index += 1;
    const leg: OrderLeg = isAccountRef(entry)
      ? { accountId: entry }
      : (asRecord(entry, where, 'an OrderLeg') as unknown as OrderLeg);
    rejectUnknownKeys(leg as unknown as Record<string, unknown>, ORDER_LEG_KEYS, where);
    const legBody = {
      account_id: accountIdOf(leg.accountId, where),
      ...orderFieldsPayload(leg as unknown as Record<string, unknown>, where),
    };
    validateEffectiveOrder({ ...defaultBody, ...legBody }, where);
    legs.push(legBody);
  }
  if (legs.length === 0) {
    throw new ValidationError('orders must contain at least one leg');
  }

  const body: Record<string, unknown> = { orders: legs };
  if (Object.keys(defaultBody).length > 0) body['defaults'] = defaultBody;
  if (options.requireReachable) body['require_reachable'] = true;
  return body;
}

/** Wire form of the close-selector fields shared by defaults and legs. */
function closeFieldsPayload(
  raw: Record<string, unknown>,
  where: string,
): Record<string, unknown> {
  const fields = raw as CloseDefaults;
  const symbolMatch =
    fields.symbolMatch === undefined
      ? undefined
      : coerceChoice(
          fields.symbolMatch,
          Object.values(SymbolMatch),
          where,
          'symbolMatch',
        );
  const side =
    fields.side === undefined
      ? undefined
      : coerceChoice(fields.side, Object.values(CloseSide), where, 'side');
  const kind =
    fields.kind === undefined
      ? undefined
      : coerceChoice(fields.kind, Object.values(CloseKind), where, 'kind');

  if (fields.volume !== undefined) {
    requireNumber(fields.volume, where, 'volume');
    if (fields.volume <= 0) {
      throw new ValidationError(`${where}: volume must be > 0, got ${fields.volume}`);
    }
  }
  if (fields.slippage !== undefined) {
    requireNumber(fields.slippage, where, 'slippage');
    if (fields.slippage < 0) {
      throw new ValidationError(
        `${where}: slippage must be >= 0, got ${fields.slippage}`,
      );
    }
  }
  if (fields.magic !== undefined) requireNumber(fields.magic, where, 'magic');

  return compact({
    symbol: fields.symbol,
    symbol_match: symbolMatch,
    side,
    kind,
    magic: fields.magic,
    volume: fields.volume,
    slippage: fields.slippage,
  });
}

function validateCloseLeg(
  leg: CloseLeg,
  legBody: Record<string, unknown>,
  defaultBody: Record<string, unknown>,
  where: string,
): void {
  if (leg.tickets !== undefined) {
    if (!Array.isArray(leg.tickets)) {
      throw new ValidationError(`${where}: tickets must be an array of ticket numbers`);
    }
    if (leg.tickets.length === 0) {
      throw new ValidationError(`${where}: tickets must not be empty`);
    }
    if (leg.tickets.some((t) => !Number.isFinite(t) || t < 1)) {
      throw new ValidationError(`${where}: tickets must be >= 1`);
    }
    const mixed = CLOSE_SELECTOR_FIELDS.filter(
      (field) => (leg as unknown as Record<string, unknown>)[field] !== undefined,
    );
    if (mixed.length > 0) {
      throw new ValidationError(
        `${where}: tickets can't be combined with selector fields ` +
          `(${mixed.join(', ')}) — use one or the other`,
      );
    }
    return;
  }
  const symbol = { ...defaultBody, ...legBody }['symbol'];
  if (symbol === undefined || symbol === '') {
    throw new ValidationError(
      `${where}: symbol is required (set it on the leg or in defaults; ` +
        'pass "*" to close every symbol)',
    );
  }
}

/**
 * Build and validate the `POST /orders/close` body.
 *
 * Raises {@link ValidationError} before anything is sent.
 */
export function buildCloseBatch(
  accounts: Iterable<CloseLegInput>,
  options: { defaults?: CloseDefaults; requireReachable?: boolean } = {},
): Record<string, unknown> {
  const rawDefaults = options.defaults ?? {};
  rejectUnknownKeys(
    asRecord(rawDefaults, 'defaults', 'close defaults'),
    CLOSE_DEFAULT_KEYS,
    'defaults',
  );
  const defaultBody = closeFieldsPayload(
    rawDefaults as Record<string, unknown>,
    'defaults',
  );

  const legs: Record<string, unknown>[] = [];
  let index = 0;
  for (const entry of accounts) {
    const where = `accounts[${index}]`;
    index += 1;
    const leg: CloseLeg = isAccountRef(entry)
      ? { accountId: entry }
      : (asRecord(entry, where, 'a CloseLeg') as unknown as CloseLeg);
    rejectUnknownKeys(leg as unknown as Record<string, unknown>, CLOSE_LEG_KEYS, where);
    const fieldsBody = closeFieldsPayload(
      leg as unknown as Record<string, unknown>,
      where,
    );

    const legBody: Record<string, unknown> = {
      account_id: accountIdOf(leg.accountId, where),
      ...fieldsBody,
    };
    if (leg.tickets !== undefined) legBody['tickets'] = leg.tickets;
    validateCloseLeg(leg, fieldsBody, defaultBody, where);
    legs.push(legBody);
  }
  if (legs.length === 0) {
    throw new ValidationError('accounts must contain at least one entry');
  }

  const body: Record<string, unknown> = { accounts: legs };
  if (Object.keys(defaultBody).length > 0) body['defaults'] = defaultBody;
  if (options.requireReachable) body['require_reachable'] = true;
  return body;
}

export function idempotencyHeaders(
  key: string | undefined,
): Record<string, string> | undefined {
  if (key === undefined) return undefined;
  if (key === '' || key.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw new ValidationError(
      `idempotencyKey must be 1–${IDEMPOTENCY_KEY_MAX_LENGTH} characters, ` +
        `got ${key.length}`,
    );
  }
  return { 'Idempotency-Key': key };
}

export interface SendOrdersOptions {
  /** Values every leg inherits unless it overrides them. */
  defaults?: OrderDefaults;
  /**
   * Makes a retry safe: replaying the identical batch with the same key returns
   * the stored reply (`idempotentReplay: true`) and sends nothing. At most 128
   * characters; remembered for 15 minutes.
   */
  idempotencyKey?: string;
  /**
   * Reject the whole batch up front ({@link ValidationError},
   * `unreachable_account`) if any account has no terminal, instead of reporting
   * that leg as `'unreachable'`. A pre-dispatch check only.
   */
  requireReachable?: boolean;
}

export interface CloseOrdersOptions {
  /** Selector values every account inherits unless it overrides them. */
  defaults?: CloseDefaults;
  /** See {@link SendOrdersOptions.idempotencyKey}. */
  idempotencyKey?: string;
  /** See {@link SendOrdersOptions.requireReachable}. */
  requireReachable?: boolean;
}

/**
 * Multi-account trading.
 *
 * Requires the full `fxs_live_…` key — a read-only `fxs_ro_…` key raises
 * {@link ForbiddenError}.
 */
export class Orders {
  constructor(private readonly http: HttpTransport) {}

  /**
   * Send one order to several accounts at once (`POST /v1/orders`).
   *
   * `orders` is one entry per leg: an {@link OrderLeg}, or just an account
   * (object or id) when `defaults` already say everything else. Each leg
   * inherits `defaults` and may override any of it — including with a falsy
   * value, so `slippage: 0` really means zero.
   *
   * The reply's `results` are positional; a leg's `status` is only trustworthy
   * as `'filled'` — a `'timeout'` leg *may* have executed. Symbols are per
   * broker (`EURUSD` / `EURUSD.sd` / `EURUSDm`), so one `defaults` symbol
   * across mixed brokers will partly fail by design — that is what a leg-level
   * `symbol` is for.
   */
  async send(
    orders: Iterable<OrderLegInput>,
    options: SendOrdersOptions = {},
  ): Promise<BatchOrderResult> {
    const body = buildOrderBatch(orders, options);
    const headers = idempotencyHeaders(options.idempotencyKey);
    return decodeBatchOrderResult(
      await this.http.request('POST', '/orders', { json: body, headers }),
    );
  }

  /**
   * Close orders across several accounts at once (`POST /v1/orders/close`).
   *
   * Closes by **selector**, not by ticket: each account is matched against
   * `symbol` (plus optional `side`, `kind`, `magic`), the backend resolves the
   * tickets from that account's open orders and closes them. Pass `tickets` on
   * a leg instead when you already have them — never both.
   *
   * `symbol` is required and `'*'` must be typed to mean every symbol.
   * `symbolMatch: 'base'` lets one selector reach `EURUSD`, `EURUSD.sd` and
   * `EURUSDm` across brokers. `kind` defaults to `'position'`, so a routine
   * close does not also delete resting pending orders — pass `'pending'` or
   * `'any'` deliberately. `volume` makes it a partial close.
   *
   * The reply carries per-account and per-ticket outcomes; `'nothing_matched'`
   * is a normal answer, not an error.
   */
  async close(
    accounts: Iterable<CloseLegInput>,
    options: CloseOrdersOptions = {},
  ): Promise<BatchCloseResult> {
    const body = buildCloseBatch(accounts, options);
    const headers = idempotencyHeaders(options.idempotencyKey);
    return decodeBatchCloseResult(
      await this.http.request('POST', '/orders/close', { json: body, headers }),
    );
  }
}
