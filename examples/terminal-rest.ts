/**
 * Read account state and market data from an account's terminal (REST).
 *
 * Run:  FXSOCKET_API_KEY=fxs_live_... npx tsx examples/terminal-rest.ts <account-id>
 */

import { FxSocket } from '@fxsocket/sdk';

async function main(accountId: string): Promise<void> {
  const fx = new FxSocket();
  try {
    const account = await fx.accounts.get(accountId);
    if (!account.hasTerminal) {
      console.log('account has no terminal endpoint yet');
      return;
    }
    const terminal = fx.terminal(account);

    const [health, summary, symbols] = await Promise.all([
      terminal.status(),
      terminal.accountSummary(),
      terminal.symbols(),
    ]);

    console.log(`platform : ${account.platform}`);
    console.log(`status   : ${health.status} (broker=${health.broker.server})`);
    console.log(`balance  : ${summary.balance} ${summary.currency}`);
    console.log(`equity   : ${summary.equity}`);

    const symbol = symbols.includes('EURUSD') ? 'EURUSD' : symbols[0]!;
    const quote = await terminal.quote(symbol);
    console.log(`${symbol}   : bid=${quote.bid} ask=${quote.ask}`);

    // Always bound the range — an unbounded request asks for the broker's
    // entire history and can exceed the terminal's deadline.
    const from = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const bars = await terminal.priceHistory(symbol, 'M5', { from });
    for (const bar of bars.slice(-5)) {
      console.log(
        `  ${bar.time}  O=${bar.open} H=${bar.high} L=${bar.low} C=${bar.close}`,
      );
    }

    // To place a trade (this executes a REAL order on the account):
    //   const res = await terminal.orderSend({
    //     symbol, operation: 'Buy', volume: 0.1, stopLoss: 1.07, takeProfit: 1.1,
    //   });
    //   if (res.success) console.log('opened ticket', res.order);
  } finally {
    await fx.close();
  }
}

const accountId = process.argv[2];
if (accountId === undefined) {
  console.error('usage: npx tsx examples/terminal-rest.ts <account-id>');
  process.exit(1);
}
main(accountId).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
