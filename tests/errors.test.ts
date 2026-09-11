/** Tests for HTTP-response → error mapping. */

import { describe, expect, it } from 'vitest';

import {
  AccountCapError,
  AuthError,
  ConnectFailedError,
  DuplicateAccountError,
  errorFromResponse,
  ForbiddenError,
  FxSocketError,
  IdempotencyError,
  InsufficientBalanceError,
  NoSubscriptionError,
  NotFoundError,
  PaymentRequiredError,
  RateLimitError,
  SeatLapsedError,
  SlotsFullError,
  TerminalNotReadyError,
  TerminalTimeoutError,
  ValidationError,
  type ErrorResponse,
} from '../src/index.js';

function response(
  status: number,
  body: unknown = null,
  headers: Record<string, string> = {},
): ErrorResponse {
  return { status, body, headers };
}

describe('errorFromResponse', () => {
  it('maps 404 to NotFoundError and uses the detail as the message', () => {
    const error = errorFromResponse(response(404, { detail: 'nope' }));
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.message).toBe('nope');
  });

  it('parses Retry-After on a 429', () => {
    const error = errorFromResponse(response(429, {}, { 'retry-after': '12' }));
    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).retryAfter).toBe(12);
  });

  it('ignores an unparseable Retry-After', () => {
    const error = errorFromResponse(response(429, {}, { 'retry-after': 'soon' }));
    expect((error as RateLimitError).retryAfter).toBeUndefined();
  });

  it('maps a 400 connect code to ConnectFailedError', () => {
    const error = errorFromResponse(
      response(400, { error: 'invalid_credentials', detail: 'bad' }),
    );
    expect(error).toBeInstanceOf(ConnectFailedError);
    expect(error.code).toBe('invalid_credentials');
  });

  it('defaults a 400 to ValidationError and reads `message`', () => {
    const error = errorFromResponse(
      response(400, { error: 'MRPC_VALIDATION', message: 'bad volume' }),
    );
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.message).toBe('bad volume');
  });

  it('maps 401 and 403', () => {
    expect(errorFromResponse(response(401, {}))).toBeInstanceOf(AuthError);
    expect(errorFromResponse(response(403, {}))).toBeInstanceOf(ForbiddenError);
  });

  it('maps terminal 503 and 504', () => {
    expect(errorFromResponse(response(503, {}))).toBeInstanceOf(TerminalNotReadyError);
    expect(errorFromResponse(response(504, { error: 'MRPC_TIMEOUT' }))).toBeInstanceOf(
      TerminalTimeoutError,
    );
  });

  it('falls back to the base error for an unknown status', () => {
    const error = errorFromResponse(response(418));
    expect(error.constructor).toBe(FxSocketError);
    expect(error.status).toBe(418);
    expect(error.message).toBe('HTTP 418');
  });

  it('maps 409 to duplicate, or slots_full with its counts', () => {
    expect(
      errorFromResponse(response(409, { error: 'duplicate', detail: 'linked' })),
    ).toBeInstanceOf(DuplicateAccountError);

    const full = errorFromResponse(
      response(409, {
        error: 'slots_full',
        detail: 'Server is full.',
        used: 2,
        cap: 2,
      }),
    );
    expect(full).toBeInstanceOf(SlotsFullError);
    expect((full as SlotsFullError).used).toBe(2);
    expect((full as SlotsFullError).cap).toBe(2);
  });

  it('maps every 402 code to a typed error', () => {
    const cap = errorFromResponse(
      response(402, { error: 'account_cap_reached', cap: 3, current: 3 }),
    );
    expect(cap).toBeInstanceOf(AccountCapError);
    expect(cap).toBeInstanceOf(PaymentRequiredError);
    expect((cap as AccountCapError).cap).toBe(3);
    expect((cap as AccountCapError).current).toBe(3);

    const low = errorFromResponse(
      response(402, {
        error: 'insufficient_balance',
        detail: 'Balance does not cover it.',
        shortfall_eur_cents: 1250,
        balance_eur_cents: 450,
      }),
    ) as InsufficientBalanceError;
    expect(low).toBeInstanceOf(InsufficientBalanceError);
    expect(low.shortfallEurCents).toBe(1250);
    expect(low.shortfallEur).toBe(12.5);
    expect(low.balanceEurCents).toBe(450);

    const bare = errorFromResponse(
      response(402, { error: 'insufficient_balance' }),
    ) as InsufficientBalanceError;
    expect(bare.shortfallEurCents).toBeUndefined();
    expect(bare.shortfallEur).toBeUndefined();

    expect(errorFromResponse(response(402, { error: 'seat_lapsed' }))).toBeInstanceOf(
      SeatLapsedError,
    );
    expect(
      errorFromResponse(response(402, { error: 'no_subscription' })),
    ).toBeInstanceOf(NoSubscriptionError);
    expect(errorFromResponse(response(402, {}))).toBeInstanceOf(NoSubscriptionError);

    const unknown = errorFromResponse(response(402, { error: 'new_code' }));
    expect(unknown.constructor).toBe(PaymentRequiredError);
    expect(unknown.code).toBe('new_code');
  });

  it('maps every idempotency code regardless of status', () => {
    for (const [status, code] of [
      [409, 'idempotency_in_flight'],
      [422, 'idempotency_key_reused'],
      [503, 'idempotency_unavailable'],
    ] as const) {
      const error = errorFromResponse(
        response(status, { error: code, detail: 'nope' }),
      );
      expect(error).toBeInstanceOf(IdempotencyError);
      expect(error.code).toBe(code);
      expect(error.status).toBe(status);
    }
  });

  it('tolerates a non-JSON body', () => {
    const error = errorFromResponse(response(500, '<html>oops</html>'));
    expect(error.constructor).toBe(FxSocketError);
    expect(error.message).toBe('HTTP 500');
  });

  it('keeps instanceof working through the hierarchy', () => {
    const error = errorFromResponse(response(402, { error: 'seat_lapsed' }));
    expect(error).toBeInstanceOf(SeatLapsedError);
    expect(error).toBeInstanceOf(PaymentRequiredError);
    expect(error).toBeInstanceOf(FxSocketError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('SeatLapsedError');
  });
});
