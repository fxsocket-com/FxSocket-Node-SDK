/**
 * Error hierarchy and HTTP-response → error mapping.
 *
 * A single {@link errorFromResponse} maps both error envelopes the platform
 * uses — the management API's `{error, detail}` and the terminal API's
 * `{error, message, command_id}` — onto typed errors.
 */

/** Everything the SDK knows about a failed HTTP response. */
export interface ErrorResponse {
  /** HTTP status code. */
  readonly status: number;
  /** Response headers, lower-cased keys. */
  readonly headers: Readonly<Record<string, string>>;
  /** Decoded JSON body, or the raw text when it was not JSON. */
  readonly body: unknown;
}

export interface FxSocketErrorOptions {
  /** HTTP status code, when the error came from a response. */
  status?: number;
  /** Machine-readable `error` code from the body, when present. */
  code?: string;
  /** The failed response, when the error came from one. */
  response?: ErrorResponse;
  /** Underlying error, when this one wraps another. */
  cause?: unknown;
}

/** Base class for every error raised by the SDK. */
export class FxSocketError extends Error {
  /** HTTP status code, or `undefined` for client-side failures. */
  readonly status?: number;
  /** Machine-readable `error` code from the body, when the API sent one. */
  readonly code?: string;
  /** The failed response, when the error came from one. */
  readonly response?: ErrorResponse;

  constructor(message: string, options: FxSocketErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.status = options.status;
    this.code = options.code;
    this.response = options.response;
    // Keeps `instanceof` working when the output is down-levelled.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Missing or invalid API key (HTTP 401), or no key configured. */
export class AuthError extends FxSocketError {}

/**
 * The key is valid but may not do this (HTTP 403) — typically a read-only
 * `fxs_ro_…` key on an endpoint that mutates state, such as multi-account
 * trading.
 */
export class ForbiddenError extends FxSocketError {}

/** Too many requests (HTTP 429). `retryAfter` is seconds, if given. */
export class RateLimitError extends FxSocketError {
  /** Seconds to wait before retrying, from the `Retry-After` header. */
  readonly retryAfter?: number;

  constructor(
    message: string,
    options: FxSocketErrorOptions & { retryAfter?: number } = {},
  ) {
    super(message, options);
    this.retryAfter = options.retryAfter;
  }
}

/** The request was rejected as malformed (HTTP 400 / `MRPC_VALIDATION`). */
export class ValidationError extends FxSocketError {}

/** The referenced account or resource does not exist (HTTP 404). */
export class NotFoundError extends FxSocketError {}

/**
 * Your plan or prepaid balance does not allow this (HTTP 402).
 *
 * Base class for {@link AccountCapError}, {@link NoSubscriptionError},
 * {@link InsufficientBalanceError} and {@link SeatLapsedError}; raised
 * directly only for a 402 whose `code` the SDK does not know yet.
 */
export class PaymentRequiredError extends FxSocketError {}

/** Plan account limit reached (HTTP 402 `account_cap_reached`). */
export class AccountCapError extends PaymentRequiredError {
  /** The plan's account limit, when reported. */
  readonly cap?: number;
  /** Accounts currently linked, when reported. */
  readonly current?: number;

  constructor(
    message: string,
    options: FxSocketErrorOptions & { cap?: number; current?: number } = {},
  ) {
    super(message, options);
    this.cap = options.cap;
    this.current = options.current;
  }
}

/** No plan permits linking accounts (HTTP 402 `no_subscription`). */
export class NoSubscriptionError extends PaymentRequiredError {}

/**
 * The prepaid balance is too low (HTTP 402 `insufficient_balance`).
 *
 * Raised when linking an account would buy a seat the balance can't cover, and
 * by balance-funded private-server purchases / resizes. `shortfallEurCents` is
 * how much is missing when the API says so (`undefined` otherwise);
 * `balanceEurCents` the current balance if reported. Top up in the dashboard,
 * or check `client.wallet.get()`.
 */
export class InsufficientBalanceError extends PaymentRequiredError {
  /** Missing amount in integer EUR cents, when the API reported one. */
  readonly shortfallEurCents?: number;
  /** Current balance in integer EUR cents, when the API reported one. */
  readonly balanceEurCents?: number;

  constructor(
    message: string,
    options: FxSocketErrorOptions & {
      shortfallEurCents?: number;
      balanceEurCents?: number;
    } = {},
  ) {
    super(message, options);
    this.shortfallEurCents = options.shortfallEurCents;
    this.balanceEurCents = options.balanceEurCents;
  }

  /** The missing amount in euros, or `undefined` when not known. */
  get shortfallEur(): number | undefined {
    return this.shortfallEurCents === undefined
      ? undefined
      : this.shortfallEurCents / 100;
  }
}

/**
 * Account seats have lapsed, so existing accounts are unseated (HTTP 402
 * `seat_lapsed`). Renew — top up the balance or fix the payment method in the
 * dashboard — before linking more accounts.
 */
export class SeatLapsedError extends PaymentRequiredError {}

/** This account is already linked (HTTP 409). */
export class DuplicateAccountError extends FxSocketError {}

/**
 * Every purchased slot on the private server is taken (HTTP 409 `slots_full`).
 * Raise the server's limit from the dashboard.
 */
export class SlotsFullError extends FxSocketError {
  /** Slots in use, when reported. */
  readonly used?: number;
  /** Slots purchased, when reported. */
  readonly cap?: number;

  constructor(
    message: string,
    options: FxSocketErrorOptions & { used?: number; cap?: number } = {},
  ) {
    super(message, options);
    this.used = options.used;
    this.cap = options.cap;
  }
}

/**
 * A multi-account batch was refused because of its `Idempotency-Key`.
 *
 * Nothing was sent. `code` says why: `idempotency_in_flight` (HTTP 409 — a
 * batch with this key is still running), `idempotency_key_reused` (HTTP 422 —
 * the key was already used for a *different* body) or
 * `idempotency_unavailable` (HTTP 503 — the guarantee can't currently be
 * honoured; retry, or drop the key to trade without it).
 */
export class IdempotencyError extends FxSocketError {}

/**
 * The account could not be linked (HTTP 400).
 *
 * `code` is one of `invalid_credentials`, `server_not_found`, `unknown` (the
 * broker rejected the login) or `proxy_unreachable` (the supplied outbound
 * proxy could not be reached — the proxy is verified before the account is
 * created).
 */
export class ConnectFailedError extends FxSocketError {}

/**
 * The account's terminal isn't reachable yet.
 *
 * Raised on HTTP 503 (trade EA not registered) and when an account has no
 * `restUrl` — it is still provisioning, or is bridge-only and exposes no
 * per-account terminal API.
 */
export class TerminalNotReadyError extends FxSocketError {}

/** The terminal didn't answer in time (HTTP 504 / `MRPC_TIMEOUT`). */
export class TerminalTimeoutError extends FxSocketError {}

/**
 * A requested feature doesn't exist on the account's platform.
 *
 * Enforced client-side — e.g. MT5-only timeframes on an MT4 account.
 */
export class UnsupportedOnPlatformError extends FxSocketError {}

/** A WebSocket-level error (server error frame, or dropped connection). */
export class StreamError extends FxSocketError {}

/** The request did not complete: DNS, TLS, connection reset or timeout. */
export class ConnectionError extends FxSocketError {}

/** The request exceeded the configured timeout. */
export class TimeoutError extends ConnectionError {}

const CONNECT_CODES: ReadonlySet<string> = new Set([
  'invalid_credentials',
  'server_not_found',
  'unknown',
  'proxy_unreachable',
]);

const IDEMPOTENCY_CODES: ReadonlySet<string> = new Set([
  'idempotency_in_flight',
  'idempotency_key_reused',
  'idempotency_unavailable',
]);

function intOrUndefined(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Build the most specific {@link FxSocketError} for a failed response. */
export function errorFromResponse(response: ErrorResponse): FxSocketError {
  const { status } = response;
  const body = asRecord(response.body);
  const code = stringOrUndefined(body['error']);
  const detail =
    stringOrUndefined(body['detail']) ?? stringOrUndefined(body['message']);
  const message = detail ?? code ?? `HTTP ${status}`;
  const common: FxSocketErrorOptions = { status, code, response };

  if (status === 401) return new AuthError(message, common);
  if (status === 403) return new ForbiddenError(message, common);
  if (code !== undefined && IDEMPOTENCY_CODES.has(code)) {
    return new IdempotencyError(message, common);
  }
  if (status === 429) {
    const raw = response.headers['retry-after'];
    const parsed = raw === undefined ? Number.NaN : Number(raw);
    return new RateLimitError(message, {
      ...common,
      retryAfter: Number.isFinite(parsed) ? parsed : undefined,
    });
  }
  if (status === 404) return new NotFoundError(message, common);
  if (status === 409) {
    if (code === 'slots_full') {
      return new SlotsFullError(message, {
        ...common,
        used: intOrUndefined(body['used']),
        cap: intOrUndefined(body['cap']),
      });
    }
    return new DuplicateAccountError(message, common);
  }
  if (status === 402) {
    if (code === 'account_cap_reached') {
      return new AccountCapError(message, {
        ...common,
        cap: intOrUndefined(body['cap']),
        current: intOrUndefined(body['current']),
      });
    }
    if (code === 'insufficient_balance') {
      return new InsufficientBalanceError(message, {
        ...common,
        shortfallEurCents: intOrUndefined(
          body['shortfall_eur_cents'] ?? body['shortfall'],
        ),
        balanceEurCents: intOrUndefined(body['balance_eur_cents']),
      });
    }
    if (code === 'seat_lapsed') return new SeatLapsedError(message, common);
    if (code === undefined || code === 'no_subscription') {
      return new NoSubscriptionError(message, common);
    }
    return new PaymentRequiredError(message, common);
  }
  if (status === 400) {
    if (code !== undefined && CONNECT_CODES.has(code)) {
      return new ConnectFailedError(message, common);
    }
    return new ValidationError(message, common);
  }
  if (status === 503) return new TerminalNotReadyError(message, common);
  if (status === 504) return new TerminalTimeoutError(message, common);
  return new FxSocketError(message, common);
}
