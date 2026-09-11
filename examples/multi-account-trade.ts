/**
 * Send one trade to every connected account, then flatten it everywhere.
 *
 * Run:  FXSOCKET_API_KEY=fxs_live_... npx tsx examples/multi-account-trade.ts
 *
 * Requires the full fxs_live_… key — read-only keys cannot trade.
 * This places REAL orders; point the key at demo accounts.
 */

import { randomUUID } from 'node:crypto';

import { FxSocket } from '@fxsocket/sdk';

async function main(): Promise<void> {
  const fx = new FxSocket();
  try {
    const accounts = (await fx.accounts.list()).filter((a) => a.hasTerminal);
    if (accounts.length === 0) {
      console.log('no connected accounts');
      return;
    }

    // Same trade on every account; the first one gets a bigger size.
    const legs = accounts.map((account, index) => ({
      accountId: account,
      ...(index === 0 ? { volume: 0.2 } : {}),
    }));

    const result = await fx.orders.send(legs, {
      defaults: { symbol: 'EURUSD', operation: 'buy', volume: 0.1 },
      idempotencyKey: randomUUID(), // makes a retry safe
    });

    console.log(`batch ${result.batchId}:`, result.summary);
    result.results.forEach((leg, index) => {
      const account = accounts[index]!;
      console.log(`  ${account.nickname || account.id}: ${leg.status} ${leg.message}`);
    });
    if (result.unknownLegs.length > 0) {
      console.log('  some legs timed out — reconcile before re-sending');
    }

    // Flatten: close every EURUSD position on every account, whatever suffix
    // the broker uses (EURUSD, EURUSD.sd, EURUSDm ...).
    const closed = await fx.orders.close(accounts, {
      defaults: { symbol: 'EURUSD', symbolMatch: 'base' },
      idempotencyKey: randomUUID(),
    });

    closed.results.forEach((leg, index) => {
      const account = accounts[index]!;
      console.log(
        `  ${account.nickname || account.id}: ${leg.status} ` +
          `(${leg.closed}/${leg.matched} closed)`,
      );
    });
  } finally {
    await fx.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
