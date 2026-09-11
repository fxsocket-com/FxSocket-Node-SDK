/**
 * Tests for decoder tolerance.
 *
 * Decoding must survive a payload that is older, newer or thinner than this SDK
 * version expects: unknown fields dropped, missing optional fields defaulted,
 * unrecognised enum values passed through rather than raising.
 */

import { describe, expect, it } from 'vitest';

import {
  decodeAccount,
  decodeBatchCloseResult,
  decodeBatchOrderResult,
  decodeHealth,
  decodeOrderResult,
  decodePrivateServer,
  decodeReadOnlyKey,
  decodeTradeEvent,
  decodeWallet,
} from '../src/decode.js';

describe('decodeAccount', () => {
  it('defaults every optional field', () => {
    const account = decodeAccount({
      id: 'a',
      platform: 'mt4',
      server: 'Demo',
      login: 7,
      status: 'connecting',
      created_at: '2026-01-02T03:04:05Z',
    });
    expect(account.nickname).toBe('');
    expect(account.error).toBe('');
    expect(account.restUrl).toBe('');
    expect(account.wsUrl).toBe('');
    expect(account.proxyLocalPort).toBeNull();
    expect(account.hasTerminal).toBe(false);
    expect(account.createdAt.toISOString()).toBe('2026-01-02T03:04:05.000Z');
  });

  it('ignores fields it does not know', () => {
    const account = decodeAccount({
      id: 'a',
      platform: 'mt5',
      server: 'Demo',
      login: 1,
      status: 'connected',
      created_at: '2026-01-02T03:04:05Z',
      some_future_field: { nested: true },
    });
    expect(account.id).toBe('a');
    expect('some_future_field' in account).toBe(false);
  });

  it('passes an unrecognised status through unchanged', () => {
    const account = decodeAccount({ id: 'a', status: 'reconnecting' });
    expect(account.status).toBe('reconnecting');
  });
});

describe('decodePrivateServer', () => {
  it('handles an absent period end and account list', () => {
    const server = decodePrivateServer({ id: 's', status: 'provisioning' });
    expect(server.periodEnd).toBeNull();
    expect(server.accounts).toEqual([]);
    expect(server.isReady).toBe(false);
    expect(server.freeSlots).toBe(0);
    expect(server.cancelAtPeriodEnd).toBe(false);
  });
});

describe('decodeReadOnlyKey', () => {
  it('defaults the scope and derives the account ids', () => {
    const key = decodeReadOnlyKey({
      id: 'k',
      key: 'fxs_ro_x',
      scope: 'selected',
      accounts: [{ id: 'a1' }, { id: 'a2' }],
      created_at: '2026-01-01T00:00:00Z',
    });
    expect(key.accountIds).toEqual(['a1', 'a2']);
    expect(key.isScoped).toBe(true);
    expect(key.lastUsedAt).toBeNull();
  });
});

describe('decodeOrderResult', () => {
  it('treats retcode 10025 as a no-op even without an outcome', () => {
    const result = decodeOrderResult({ success: false, retcode: 10025 });
    expect(result.isNoChange).toBe(true);
    expect(result.isEffective).toBe(true);
    expect(result.outcome).toBe('');
  });

  it('is not effective on a plain rejection', () => {
    const result = decodeOrderResult({
      success: false,
      outcome: 'rejected',
      retcode: 10006,
    });
    expect(result.isNoChange).toBe(false);
    expect(result.isEffective).toBe(false);
  });
});

describe('decodeBatchOrderResult', () => {
  it('partitions legs into filled, failed and unknown', () => {
    const result = decodeBatchOrderResult({
      batch_id: 'b',
      summary: { requested: 3, filled: 1, failed: 1, unknown: 1 },
      results: [
        { account_id: 'a1', status: 'filled' },
        { account_id: 'a2', status: 'rejected' },
        { account_id: 'a3', status: 'timeout' },
      ],
    });
    expect(result.allFilled).toBe(false);
    expect(result.filledLegs.map((l) => l.accountId)).toEqual(['a1']);
    expect(result.failedLegs.map((l) => l.accountId)).toEqual(['a2']);
    expect(result.unknownLegs.map((l) => l.accountId)).toEqual(['a3']);
    expect(result.idempotentReplay).toBe(false);
  });

  it('reports allFilled when every leg landed', () => {
    const result = decodeBatchOrderResult({
      batch_id: 'b',
      summary: { requested: 1, filled: 1, failed: 0, unknown: 0 },
      results: [{ account_id: 'a1', status: 'filled' }],
    });
    expect(result.allFilled).toBe(true);
  });
});

describe('decodeBatchCloseResult', () => {
  it('does not call a batch closed while an account is unknown', () => {
    const result = decodeBatchCloseResult({
      batch_id: 'b',
      summary: {
        accounts: 1,
        matched: 0,
        closed: 0,
        failed: 0,
        unknown: 0,
        accounts_unknown: 1,
      },
      results: [{ account_id: 'a1', status: 'timeout' }],
    });
    expect(result.allClosed).toBe(false);
    expect(result.unknownAccounts).toHaveLength(1);
  });
});

describe('decodeWallet', () => {
  it('derives euro amounts from cents', () => {
    const wallet = decodeWallet({
      balance_eur_cents: 1234,
      upcoming_total_eur_cents: 500,
      shortfall_eur_cents: 0,
      covers_upcoming: true,
    });
    expect(wallet.balanceEur).toBe(12.34);
    expect(wallet.upcomingTotalEur).toBe(5);
    expect(wallet.shortfallEur).toBe(0);
  });
});

describe('decodeHealth', () => {
  it('fills in every missing section', () => {
    const health = decodeHealth({ status: 'starting' });
    expect(health.isReady).toBe(false);
    expect(health.terminal.alive).toBe(false);
    expect(health.broker.connected).toBe(false);
    expect(health.account.loggedIn).toBe(false);
    expect(health.bridge.tradeEaHeartbeatAgeMs).toBe(-1);
    expect(health.serverTime).toBe('');
  });
});

describe('decodeTradeEvent', () => {
  it('computes net profit from profit, commission and swap', () => {
    const event = decodeTradeEvent({ profit: 10, commission: -2, swap: -0.5 });
    expect(event.netProfit).toBe(7.5);
  });
});
