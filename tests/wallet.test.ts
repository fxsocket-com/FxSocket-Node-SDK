/** Tests for the read-only wallet accessor (`client.wallet`). */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FxSocket } from '../src/index.js';
import { HttpMock, ORIGIN } from './helpers/mock-http.js';

const WALLET = {
  balance_eur_cents: 2400,
  pending_topups: [
    {
      id: 17,
      status: 'partial',
      amount_eur_cents: 5000,
      credited_eur_cents: 1250,
      deposit_address: '0xabc',
      deposit_amount: '50000000',
      deposit_amount_decimal: '50.0',
      asset_code: 'USDC',
      blockchain_code: 'ETH',
      expires_at: '2026-09-09T12:30:00Z',
    },
  ],
  upcoming: [
    {
      when: '2026-09-15T00:00:00Z',
      amount_eur_cents: 1200,
      kind: 'seat',
      label: 'demo',
    },
    {
      when: '2026-09-20T00:00:00Z',
      amount_eur_cents: 1200,
      kind: 'seat',
      label: 'prop-1',
    },
    {
      when: '2026-09-28T00:00:00Z',
      amount_eur_cents: 1200,
      kind: 'server',
      label: 'My Prop Guard',
    },
  ],
  upcoming_total_eur_cents: 3600,
  shortfall_eur_cents: 1200,
  covers_upcoming: false,
};

let mock: HttpMock;

beforeEach(() => {
  mock = new HttpMock(ORIGIN);
});

afterEach(async () => {
  await mock.close();
});

describe('wallet.get', () => {
  it('decodes the balance, top-ups and upcoming charges', async () => {
    const route = mock.get('/v1/wallet', { status: 200, json: WALLET });
    const fx = new FxSocket({ apiKey: 'fxs_ro_test', dispatcher: mock.dispatcher });
    const wallet = await fx.wallet.get();

    expect(route.last.headers['x-api-key']).toBe('fxs_ro_test');
    expect(wallet.balanceEurCents).toBe(2400);
    expect(wallet.balanceEur).toBe(24);
    expect(wallet.coversUpcoming).toBe(false);
    expect(wallet.shortfallEur).toBe(12);
    expect(wallet.upcomingTotalEur).toBe(36);

    const [topup] = wallet.pendingTopups;
    expect(topup!.id).toBe(17);
    expect(topup!.creditedEur).toBe(12.5);
    expect(topup!.expiresAt?.getUTCFullYear()).toBe(2026);
    expect(topup!.depositAmountDecimal).toBe('50.0');

    expect(wallet.upcoming.map((c) => c.kind)).toEqual(['seat', 'seat', 'server']);
    expect(wallet.upcoming[2]!.label).toBe('My Prop Guard');
    expect(wallet.upcoming[0]!.amountEur).toBe(12);
    expect(wallet.upcoming[0]!.when.getUTCMonth()).toBe(8);
    await fx.close();
  });

  it('tolerates a minimal body', async () => {
    mock.get('/v1/wallet', { status: 200, json: { balance_eur_cents: 0 } });
    const fx = new FxSocket({ apiKey: 'fxs_live_test', dispatcher: mock.dispatcher });
    const wallet = await fx.wallet.get();

    expect(wallet.balanceEur).toBe(0);
    expect(wallet.pendingTopups).toEqual([]);
    expect(wallet.upcoming).toEqual([]);
    expect(wallet.coversUpcoming).toBe(true);
    await fx.close();
  });
});
