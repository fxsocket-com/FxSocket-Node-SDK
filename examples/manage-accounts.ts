/**
 * List the trading accounts linked to your FxSocket API key.
 *
 * Run:  FXSOCKET_API_KEY=fxs_live_... npx tsx examples/manage-accounts.ts
 */

import { FxSocket } from 'fxsocket';

async function main(): Promise<void> {
  const fx = new FxSocket(); // reads FXSOCKET_API_KEY from the environment
  try {
    const accounts = await fx.accounts.list();
    console.log(`${accounts.length} account(s):`);
    for (const account of accounts) {
      const terminal = account.restUrl || '(no terminal — bridge-only/provisioning)';
      console.log(
        `  ${account.id}  ${account.platform.padEnd(3)}  ` +
          `${account.status.padEnd(12)}  ${terminal}`,
      );
    }
  } finally {
    await fx.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
