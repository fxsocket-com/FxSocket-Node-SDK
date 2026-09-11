/**
 * Stream live ticks and account updates over WebSocket.
 *
 * Run:  FXSOCKET_API_KEY=fxs_live_... npx tsx examples/stream-quotes.ts <account-id>
 */

import { FxSocket } from '@fxsocket/sdk';

async function main(accountId: string): Promise<void> {
  const fx = new FxSocket();
  const account = await fx.accounts.get(accountId);
  const stream = fx.stream(account);

  // Ctrl-C ends the loop cleanly.
  process.once('SIGINT', () => void stream.close());

  try {
    await stream.connect();
    await stream.subscribePrices('EURUSD');
    await stream.subscribeAccount();
    console.log('streaming — Ctrl-C to stop');

    for await (const event of stream) {
      switch (event.type) {
        case 'tick':
          console.log(
            `tick ${event.symbol}  bid=${event.data.bid}  ask=${event.data.ask}`,
          );
          break;
        case 'account':
          console.log(`account equity=${event.data.equity} ${event.data.currency}`);
          break;
        default:
          break;
      }
    }
  } finally {
    await stream.close();
    await fx.close();
  }
}

const accountId = process.argv[2];
if (accountId === undefined) {
  console.error('usage: npx tsx examples/stream-quotes.ts <account-id>');
  process.exit(1);
}
main(accountId).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
