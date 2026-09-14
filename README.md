# FxSocket Node.js SDK

[![npm](https://img.shields.io/npm/v/%40fxsocket%2Fsdk.svg)](https://www.npmjs.com/package/@fxsocket/sdk)
[![node](https://img.shields.io/node/v/%40fxsocket%2Fsdk.svg)](https://www.npmjs.com/package/@fxsocket/sdk)
[![CI](https://github.com/fxsocket-com/FxSocket-Node-SDK/actions/workflows/ci.yml/badge.svg)](https://github.com/fxsocket-com/FxSocket-Node-SDK/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/fxsocket-com/FxSocket-Node-SDK/blob/main/LICENSE)

Typed Node.js / TypeScript client for the [FxSocket](https://fxsocket.com) API.
Connect your MetaTrader 4 / 5 accounts, then place trades, read market data, and
stream live updates over REST and WebSocket.

## Features

- **Account management** — link, list, fetch, and disconnect MT4/MT5 accounts.
- **Private servers** — buy, resize, cancel and delete dedicated hosting
  servers, and manage the accounts on them.
- **Read-only keys** — mint, scope, rotate and revoke `fxs_ro_…` keys for
  dashboards and monitors.
- **Trading** — market & pending orders, modify, close, close-all, plus
  margin/profit calculators.
- **Multi-account trading** — one order, or one close, fanned out to several
  accounts in a single request, with idempotency keys for safe retries.
- **Wallet** — read your prepaid balance, pending top-ups and upcoming charges.
- **Market data** — quotes, symbol specifications (incl. commission rules &
  trading sessions), OHLC history, account state & info.
- **Live streaming** — ticks, bars, account, positions, trades, and terminal
  status over WebSocket, with automatic reconnect + subscription replay.
- **Fully typed** — hand-written types throughout, a discriminated union for
  stream events, and no `any` in the public surface.
- **ESM and CommonJS** — one package, both module systems, types for each.
- **One interface for MT4 and MT5** — platform differences handled for you.

## Install

```bash
npm install @fxsocket/sdk
```

Requires Node.js 20 or newer.

## Quickstart

```ts
import { FxSocket } from '@fxsocket/sdk';

const fx = new FxSocket({ apiKey: 'fxs_live_…' }); // or set FXSOCKET_API_KEY

const [account] = await fx.accounts.list();
const terminal = fx.terminal(account);

console.log('equity:', (await terminal.accountSummary()).equity);
console.log('EURUSD:', (await terminal.quote('EURUSD')).ask);

await fx.close();
```

CommonJS works the same way:

```js
const { FxSocket } = require('@fxsocket/sdk');
```

Every method returns a promise. There is no separate synchronous client — where
the Python SDK has `Client` and `AsyncClient`, this one has a single `FxSocket`.

## Authentication

Every call uses your FxSocket API key (`fxs_live_…`), from the dashboard. Pass it
explicitly, or set the `FXSOCKET_API_KEY` environment variable and construct
`new FxSocket()` with no arguments.

```ts
const fx = new FxSocket({ apiKey: 'fxs_live_…' });

for (const account of await fx.accounts.list()) {
  console.log(account.platform, account.nickname, account.status);
}
```

`fx.close()` releases the connection pool and every terminal client the instance
opened. You can also let the runtime do it:

```ts
await using fx = new FxSocket({ apiKey: 'fxs_live_…' });
```

## Managing accounts

```ts
// Link a new account (platform defaults to mt5).
let account = await fx.accounts.create({
  platform: 'mt5',
  server: 'ICMarkets-Demo',
  login: 1150125,
  password: '…',
});

// Poll until it's connected.
account = await fx.accounts.get(account.id);
console.log(account.status); // connecting → connected

// Where this account's terminal API lives (empty until provisioned).
console.log(account.restUrl, account.wsUrl);

// Move the trade expert to a specific chart symbol (the terminal restarts on
// it — poll until connected again). '' reverts to automatic.
account = await fx.accounts.update(account, { tradeEaSymbol: 'EURUSDm' });

await fx.accounts.delete(account.id); // unlink
```

An account's terminal can be routed through an outbound proxy at link time. The
proxy is verified first — an unreachable one raises `ConnectFailedError` with
`code === 'proxy_unreachable'` and nothing is created. The address, type and
local port are readable on the `Account`; the credentials never come back.

```ts
const account = await fx.accounts.create({
  server: 'ICMarkets-Demo',
  login: 1150125,
  password: '…',
  tradeEaSymbol: 'EURUSDm', // optional, broker-exact
  proxyAddress: '10.0.0.5:1080',
  proxyType: 'socks5',
  proxyAuth: 'user:secret',
  proxyLocalPort: 1080,
});
```

## Read-only keys

A read-only key (`fxs_ro_…`) can call every GET endpoint but nothing that mutates
state. `fx.readonlyKeys` manages named ones; each has a `scope` — `all` sees
every account, `selected` only the accounts attached to it (everything else is
absent from lists, 404 by id and 401 at the terminal). Passing `accounts`
implies `selected`.

```ts
import { KeyScope } from '@fxsocket/sdk';

let key = await fx.readonlyKeys.create({ name: 'dashboard', accounts: [account] });
console.log(key.key); // plaintext, returned on every read

key = await fx.readonlyKeys.update(key, { name: 'ops-dashboard' });
key = await fx.readonlyKeys.rotate(key); // new secret, same name & scope
await fx.readonlyKeys.delete(key); // revoke — immediate, irreversible

for (const k of await fx.readonlyKeys.list()) {
  console.log(k.name, k.scope === KeyScope.ALL, k.lastUsedAt);
}
```

Terminals are started with the exact set of read-only keys they accept, so
creating, re-scoping, rotating or revoking a key **restarts the terminals of
every account in its scope** — each goes briefly offline, typically a few
minutes. Renaming is free. Key management itself always needs the full
`fxs_live_…` key, even for reads, because the replies contain plaintext key
values.

## Trading & market data

`fx.terminal(account)` returns a REST client bound to that account's terminal
(resolved from `account.restUrl`, whether it's a shared pod or a private
droplet):

```ts
const account = await fx.accounts.get('…'); // must be connected
const terminal = fx.terminal(account);

const summary = await terminal.accountSummary(); // balance, equity, margin, …
const quote = await terminal.quote('EURUSD'); // latest tick
const from = new Date(Date.now() - 24 * 60 * 60 * 1000);
const bars = await terminal.priceHistory('EURUSD', 'M5', { from }); // OHLC bars

const result = await terminal.orderSend({
  symbol: 'EURUSD',
  operation: 'Buy',
  volume: 0.1,
  stopLoss: 1.07,
  takeProfit: 1.1,
});

if (result.success) {
  await terminal.orderModify(result.order, { takeProfit: 1.12 }); // SL untouched
  await terminal.orderClose(result.order);
}
```

Every order call returns an `OrderResult`. A `200` only means the terminal
answered — check the body: `success` is true for `retcode` `10009` (done) or
`10008` (placed), and `outcome` classifies the result as `applied` / `no_change`
/ `partial` / `rejected`.

`no_change` (retcode `10025`) is a benign, idempotent no-op — the requested
SL/TP/price already match — so it's safe to treat as applied even though
`success` is `false`. For idempotent SL/TP management (e.g. re-sending after a
lost confirmation), send absolute values and gate on `isEffective` (true for both
`applied` and `no_change`):

```ts
const res = await terminal.orderModify(ticket, { stopLoss: 1.085 });
if (res.isEffective) {
  // applied now, or already in effect
}
```

There's also a panic button. `closeAll()` closes every open position in one
trade-EA pass — optionally filtered by `symbol` and/or `magic` (`magic: 0`
matches manually-opened orders), and `deletePending: true` also deletes matching
pending orders. It returns a `CloseAllSummary` with per-ticket results. On a 504
the pass _continues inside the terminal_ — check `openedOrders()` before acting
again rather than re-sending:

```ts
const summary = await terminal.closeAll({ symbol: 'EURUSD', deletePending: true });
for (const row of summary.results) {
  if (!row.success) console.log(row.ticket, row.retcode, row.retcodeDescription);
}
```

Inputs are validated client-side before they're sent. One guard worth knowing: in
`orderModify`, a literal `stopLoss: 0` would _remove_ your stop-loss, so it's
rejected — pass `clearStopLoss: true` to remove one deliberately, while omitting
the field keeps the current value.

MT4 and MT5 share one interface. MT5-only timeframes (`M2`, `M3`, `H2`, `H6`,
`H8`, `H12`) raise `UnsupportedOnPlatformError` on MT4 before any request.

> **Always bound `priceHistory`.** Without `from`/`to` the terminal asks the
> broker for its _entire_ history for that timeframe — a million M1 bars on a
> typical demo account — which usually exceeds the terminal's own deadline and
> comes back as `TerminalTimeoutError` (HTTP 504). A bounded request answers in
> well under a second:
>
> ```ts
> const from = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
> const bars = await terminal.priceHistory('EURUSD', 'M5', { from });
> ```
>
> On MT4 the opposite failure also exists: a bounded request (or the `D1`
> timeframe) can fail server-side with `CopyRates failed` when the terminal
> hasn't loaded that history yet. Retry after the chart has warmed up.

## Multi-account trading

`fx.orders` sends one order — or one close — to several accounts in a single
request, through the management API rather than each terminal. Every leg inherits
`defaults` and may override any of it, so "same trade, three accounts, three lot
sizes" stays short. A leg can be a full object, or just the account (object or
id) when `defaults` say everything else.

```ts
const accounts = (await fx.accounts.list()).filter((a) => a.hasTerminal);

const result = await fx.orders.send(
  accounts.map((account, i) => ({ accountId: account, volume: 0.1 * (i + 1) })),
  {
    defaults: { symbol: 'EURUSD', operation: 'buy', stopLoss: 1.07 },
    idempotencyKey: 'signal-4711',
  },
);

result.results.forEach((leg, i) => {
  console.log(accounts[i].nickname, leg.status, leg.order, leg.message);
});
```

**Validation is all-or-nothing, execution is not.** A malformed leg raises
`ValidationError` before anything is sent (the SDK checks what the API checks —
symbol / operation / volume present, a price for pending orders, …). Once
dispatched the legs are independent: you get a `BatchOrderResult` with a
positional `results` list — index it against what you sent rather than matching
on `accountId`, which repeats when several legs target one account. Each
`OrderLegResult.status` is only trustworthy as `filled`; a `timeout` leg _may_
have executed (`isUnknown`), so never blind-retry it. `result.allFilled`,
`filledLegs`, `failedLegs` and `unknownLegs` roll this up.

Symbols are per broker (`EURUSD`, `EURUSD.sd`, `EURUSDm`), so a single `defaults`
symbol across mixed brokers will partly fail by design — that is what a leg-level
`symbol` is for.

**Idempotency.** Pass an `idempotencyKey` (any opaque string, ≤ 128 chars)
whenever a retry is possible: replaying the identical batch with the same key
returns the stored reply (`idempotentReplay: true`) and sends nothing. Keys are
remembered for 15 minutes. A key that is still in flight, was already used for a
different body, or can't currently be guaranteed raises `IdempotencyError` —
nothing is sent in any of those cases.

Closing works by **selector**, not by ticket: each account is matched against
`symbol` (plus optional `side`, `kind`, `magic`), the backend resolves the
tickets from that account's open orders and closes them. `symbol` is required —
type `'*'` to mean every symbol; it is never implied. `symbolMatch: 'base'` lets
one selector reach `EURUSD`, `EURUSD.sd` and `EURUSDm` across brokers. `kind`
defaults to `position`, so a routine close does not also delete resting pending
orders.

```ts
const closed = await fx.orders.close(
  [
    { accountId: accounts[0], side: 'long', volume: 0.05 }, // partial
    { accountId: accounts[1], tickets: [123456, 123457] }, // explicit
    accounts[2], // defaults only
  ],
  {
    defaults: { symbol: 'EURUSD', symbolMatch: 'base' },
    idempotencyKey: 'flatten-4711',
  },
);

for (const leg of closed.results) {
  console.log(leg.accountId, leg.status, `${leg.closed}/${leg.matched}`);
  for (const ticket of leg.results) {
    console.log('   ', ticket.ticket, ticket.status, ticket.retcodeDescription);
  }
}
```

`nothing_matched` is a normal answer, not an error. `skipped` tickets were never
sent; `timeout` ones may well have closed. An `idempotencyKey` matters most for
partial closes, where a blind retry genuinely over-closes.

Both calls need the full `fxs_live_…` key — a read-only key raises
`ForbiddenError`.

## Streaming (WebSocket)

Subscribe to live ticks, bars, account, positions, trades, and terminal status. A
dropped connection auto-reconnects and replays active subscriptions
(`autoReconnect: true` by default).

A `Stream` is an async iterable, so `for await` reads it:

```ts
const account = await fx.accounts.get('…');
const stream = fx.stream(account);

await stream.connect();
await stream.subscribePrices('EURUSD');
await stream.subscribeBars('EURUSD', 'M5');
await stream.subscribeAccount();

for await (const event of stream) {
  switch (event.type) {
    case 'tick':
      console.log(event.symbol, event.data.bid, event.data.ask);
      break;
    case 'bar':
      console.log(event.symbol, event.timeframe, event.data.close);
      break;
    case 'account':
      console.log('equity', event.data.equity);
      break;
  }
}
```

`event.type` is a discriminated union, so TypeScript narrows `event.data` inside
each branch. Keep a `default` arm: an unrecognised frame arrives as
`{type: 'unknown'}` with the raw payload rather than being dropped.

Each event goes to exactly one iterator, so a stream supports **one** `for await`
loop at a time — a second one throws rather than quietly starving. Use the event
listeners below when several parts of your app need the same events.

It is also an `EventEmitter`, which suits long-lived services better:

```ts
stream.on('tick', (event) => console.log(event.data.bid));
stream.on('trade', (event) => record(event.data));
stream.on('reconnected', ({ attempt }) => console.log('back after', attempt));
stream.on('error', (error) => console.error(error));

await stream.connect();
await stream.subscribePrices('EURUSD');
```

A server-sent `error` frame (a bad timeframe, say) is data, not a transport
failure, so it arrives on `streamError` — the `error` channel is reserved for a
connection that dropped and could not be re-established.

A `subscribe*()` call resolves once the request is written to the socket, not
once the server has started feeding that topic. The server confirms the second
step with a `subscribed` frame, so if you are about to trigger the very events
you want to observe — placing an order and watching for its `trade` events —
wait for that acknowledgement first:

```ts
const ready = new Promise<void>((resolve) => {
  stream.once('subscribed', () => resolve());
});
await stream.subscribeTrades();
await ready;
// now place the order
```

Close the stream when you're done; `fx.close()` does not close streams.

```ts
await stream.close();
```

### Backpressure

Events buffer while your consumer is busy. Past `maxQueueSize` (10,000 by
default) the oldest are dropped and a `lag` event fires with the running count —
memory stays bounded even if a tick feed outruns the loop reading it. Pass
`maxQueueSize: 0` to buffer without limit. That is separate from the server-side
`warning` frame, which reports what the _server_ dropped because this client
lagged.

### Trade events

A `trade` event carries the full deal: `commission`, `swap`, `magic` and a real
`comment` alongside `profit` (bridges MT5 0.12+ / MT4 0.11+; zero on older pods).
Event-only P&L accounting is `data.netProfit` (`profit + commission + swap`).

Correlate the `In` and `Out` events of one round-trip through `data.position` —
on MT5, `Out` deals carry `magic: 0` / `comment: ''` unless the closing request
set them (platform behavior, not a bridge gap), so position id is the reliable
join key. On MT4, `deal` is always 0 and `position` equals the order ticket. The
same id appears as `position` in `orderHistory()` rows and as `positionId` in
`positionHistory()`.

If the bridge can't fully enrich an event in time it sets `data.degraded = true`:
identifiers, `symbol`, `type`, `volume` and `price` are still trustworthy, but
`entry` is `'Unknown'` and the cost fields are zeroed — reconcile that deal via
`orderHistory()`.

```ts
stream.on('trade', ({ data }) => {
  if (data.degraded)
    reconcileLater(data.position); // costs/entry unreliable
  else if (data.entry === 'Out') console.log(data.position, 'net', data.netProfit);
});
```

## Errors

Every failure rejects with a subclass of `FxSocketError`:

| Error                              | When                                                                |
| ---------------------------------- | ------------------------------------------------------------------- |
| `AuthError`                        | missing/invalid API key                                             |
| `ForbiddenError`                   | key not allowed to do this (read-only key on a mutating call)       |
| `RateLimitError`                   | rate limited (`.retryAfter`)                                        |
| `ValidationError`                  | malformed request (`.code`: `invalid_batch`, `unknown_account`, …)  |
| `IdempotencyError`                 | batch refused because of its `Idempotency-Key` (`.code`)            |
| `NotFoundError`                    | account/resource not found                                          |
| `PaymentRequiredError`             | base for every 402 below (plan / balance doesn't allow it)          |
| `AccountCapError`                  | plan account limit reached (`.cap`, `.current`)                     |
| `NoSubscriptionError`              | no plan permits linking accounts                                    |
| `InsufficientBalanceError`         | prepaid balance too low (`.shortfallEurCents`, `.shortfallEur`)     |
| `SeatLapsedError`                  | seats lapsed, existing accounts unseated — renew first              |
| `DuplicateAccountError`            | account already linked                                              |
| `SlotsFullError`                   | every purchased private-server slot is taken (`.used`, `.cap`)      |
| `ServerLimitError`                 | you already own the maximum number of private servers               |
| `AccountsExceedTargetError`        | resize below the accounts already on the server                     |
| `AlreadyLapsedError`               | the paid period ran out — a cancel can no longer be resumed         |
| `NotBalanceFundedError`            | card-/crypto-funded server (a `ForbiddenError`) — use the dashboard |
| `ConnectFailedError`               | broker rejected the login                                           |
| `TerminalNotReadyError`            | terminal not provisioned / not ready                                |
| `TerminalTimeoutError`             | the terminal didn't answer in time                                  |
| `UnsupportedOnPlatformError`       | feature not available on this platform                              |
| `StreamError`                      | WebSocket dropped, or could not be opened                           |
| `ConnectionError` / `TimeoutError` | the request never completed                                         |

```ts
import { AccountCapError, InsufficientBalanceError } from '@fxsocket/sdk';

try {
  await fx.accounts.create({ server: 'Demo', login: 1, password: '…' });
} catch (error) {
  if (error instanceof AccountCapError) {
    console.log(`Plan limit reached: ${error.current}/${error.cap}`);
  } else if (error instanceof InsufficientBalanceError) {
    console.log(`Top up ${error.shortfallEur} EUR first`); // undefined if not given
  } else {
    throw error;
  }
}
```

## Private hosting

Dedicated private servers are managed through `fx.privateServers`:

```ts
import { FxSocket, PrivateAccountStatus, SlotsFullError } from '@fxsocket/sdk';

const fx = new FxSocket({ apiKey: 'fxs_live_…', verifyTerminalTls: false });

let [server] = await fx.privateServers.list();
console.log(server.name, server.status, `${server.usedSlots}/${server.purchasedSlots}`);

const credentials = { server: 'ICMarkets-Demo', login: 1150125, password: '…' };

let account;
try {
  account = await fx.privateServers.addAccount(server, credentials);
} catch (error) {
  if (!(error instanceof SlotsFullError)) throw error;
  console.log(`Server full (${error.used}/${error.cap}) — buying another slot`);
  server = await fx.privateServers.resize(server, { slots: server.purchasedSlots + 1 });
  account = await fx.privateServers.addAccount(server, credentials);
}

// Poll until the on-server agent has the terminal up, then trade as usual.
for (;;) {
  const current = await fx.privateServers.get(server);
  const found = current.accounts.find((a) => a.id === account.id);
  if (found?.status === PrivateAccountStatus.READY) {
    account = found;
    break;
  }
  await new Promise((r) => setTimeout(r, 5000));
}

console.log(await fx.terminal(account).accountSummary());
```

Accounts on a private server are traded and streamed exactly like shared-cluster
accounts — their `restUrl` / `wsUrl` simply point at the server's dedicated IP.
The server presents a self-signed certificate, so reach it with
`new FxSocket({ verifyTerminalTls: false })`, or per call with
`fx.terminal(account, { verify: false })`.

`server.cancelAtPeriodEnd` is `true` once a server has been told to stop instead
of renewing; it then runs until `server.periodEnd` and expires.

### Buying, resizing and canceling

`fx.privateServers.regions()` returns where servers may run, how big they may be
and what that costs — call it before buying rather than hardcoding slugs:

```ts
const options = await fx.privateServers.regions();
if (options.enabled) {
  console.log(options.regionCodes); // ['fra1', 'lon1', …]
  console.log(options.maxSlots, options.maxServers);
  console.log(options.monthlyPriceEur(3)); // 45 — three slots for a month
}
```

`create()` buys one, charged to the prepaid balance immediately. It comes back
`provisioning`; poll `get()` until it is `ready`, usually a couple of minutes:

```ts
import {
  InsufficientBalanceError,
  PrivateServerStatus,
  ServerLimitError,
} from '@fxsocket/sdk';

let server;
try {
  server = await fx.privateServers.create({
    slots: 2,
    region: 'fra1',
    name: 'prop-guard',
  });
} catch (error) {
  if (error instanceof InsufficientBalanceError) {
    console.log(`Top up ${error.shortfallEur} EUR first`);
  } else if (error instanceof ServerLimitError) {
    console.log(`Already own the maximum (${options.maxServers})`);
  }
  throw error;
}

while (server.status !== PrivateServerStatus.READY) {
  await new Promise((r) => setTimeout(r, 10_000));
  server = await fx.privateServers.get(server);
}
```

`resize()` changes the slot count. Increases are prorated over the rest of the
period and charged now (the renewal date doesn't move); decreases are free and
apply at the next renewal, so paid-for capacity is never destroyed mid-month.
Shrinking below the accounts already on the server raises
`AccountsExceedTargetError` — remove accounts first:

```ts
server = await fx.privateServers.resize(server, { slots: 4 });
```

`cancel()` stops the server renewing: it runs until `periodEnd`, then expires.
`resume()` undoes that while the period lasts (afterwards the machine is gone and
`AlreadyLapsedError` is raised). `delete()` destroys the machine and every account
on it right away, with **no refund** for the rest of the prepaid month — prefer
`cancel()` unless you really want it gone now:

```ts
server = await fx.privateServers.cancel(server); // stop at periodEnd
server = await fx.privateServers.resume(server); // changed your mind
await fx.privateServers.delete(server); // irreversible, no refund
```

All of these move the prepaid balance, so they only work on balance-funded
servers — a card- or crypto-funded one raises `NotBalanceFundedError` (a
`ForbiddenError` subclass) and is managed from the dashboard. Read-only
`fxs_ro_…` keys get a plain `ForbiddenError`.

## Wallet

`fx.wallet.get()` is a read-only view of your prepaid balance: what is in it,
top-ups that haven't landed yet, and what the balance will pay for over the next
30 days (account seats and balance-funded private servers together). Amounts are
integer EUR cents and authoritative; the `*Eur` fields are those cents divided by
100, for display.

```ts
const wallet = await fx.wallet.get();
console.log(
  `balance ${wallet.balanceEur} EUR, covers 30 days: ${wallet.coversUpcoming}`,
);
for (const charge of wallet.upcoming) {
  console.log(charge.when.toISOString().slice(0, 10), charge.kind, charge.label);
}
if (!wallet.coversUpcoming) console.log(`top up at least ${wallet.shortfallEur} EUR`);
```

Affordability is cumulative — with 24 EUR and three 12 EUR renewals the first two
are covered and the third is not — so `shortfallEur` is the total gap, not the
size of any single charge. Topping up happens in the dashboard; the balance is
only ever _spent_ through the SDK (account seats and `privateServers.create()` /
`resize()`), never topped up.

## Timestamps

Management timestamps (`account.createdAt`, `wallet.upcoming[].when`, …) are real
UTC instants and decode to `Date`.

Terminal timestamps (`quote.time`, candle `time`, order times) are **strings in
broker server time** — the trailing `Z` is stylistic and does **not** mean UTC, so
the SDK leaves them as sent rather than silently mis-dating them. Use
`terminal.serverTimezone()` to get the broker's UTC offset if you need to convert.

The same applies to timestamps you _send_ — an order `expiration`, or the `from`
/ `to` bounds on the history endpoints. A string is passed through verbatim and
is the unambiguous way to express them. A `Date` is rendered as its UTC wall
clock with no zone suffix (`2030-01-01T21:30:00`), which keeps the value the same
whatever `TZ` the process runs under. The terminal then reads those digits as
broker time, so on a broker three hours ahead of UTC an expiry built from a
`Date` lands three hours earlier than the instant you meant. When that matters,
shift it yourself:

```ts
const { utcOffsetSeconds } = await terminal.serverTimezone();
const wanted = Date.now() + 3 * 24 * 60 * 60 * 1000; // the real instant
const expiration = new Date(wanted + utcOffsetSeconds * 1000)
  .toISOString()
  .slice(0, 19); // broker wall clock
```

## Advanced

**Custom dispatcher.** `dispatcher` takes any undici `Dispatcher` — a proxy
agent, a pool with your own connection limits, or a `MockAgent` in tests:

```ts
import { ProxyAgent } from 'undici';

const fx = new FxSocket({
  apiKey: 'fxs_live_…',
  dispatcher: new ProxyAgent('http://proxy.internal:8080'),
});
```

**Timeouts.** `timeoutMs` (30,000 by default) covers a whole REST call and raises
`TimeoutError`. Set it per terminal with `fx.terminal(account, { timeoutMs })`.

**No automatic retries.** Nothing in this SDK retries a request. Order send /
modify / close must never replay, and a silent retry elsewhere would make that
guarantee accidental. Retry deliberately, with an `idempotencyKey` for batches.

## Coming from the Python SDK

The two SDKs cover the same API and the same concepts. What differs:

| Python                                     | Node                                                |
| ------------------------------------------ | --------------------------------------------------- |
| `fxsocket` on PyPI                         | `@fxsocket/sdk` on npm                              |
| `Client` / `AsyncClient`                   | one promise-based `FxSocket` (`Client` is an alias) |
| `TerminalClient` / `AsyncTerminalClient`   | `TerminalClient`                                    |
| `Stream` / `AsyncStream`                   | `Stream` — async-iterable _and_ an `EventEmitter`   |
| `snake_case` methods and fields            | `camelCase`                                         |
| keyword arguments                          | a single options object                             |
| `fx.readonly_keys`                         | `fx.readonlyKeys`                                   |
| `term.order_history(from_, to)`            | `term.orderHistory({ from, to })`                   |
| `Tick`, `Bar`, `AccountUpdate`, … classes  | one union discriminated on `event.type`             |
| `result.is_filled`, `account.has_terminal` | the same names in camelCase, as plain fields        |
| `Decimal` euro amounts                     | integer `…EurCents` plus a `…Eur` number            |
| `timeout=30.0` (seconds)                   | `timeoutMs: 30_000`                                 |
| `verify_terminal_tls=False`                | `verifyTerminalTls: false`                          |
| raises `ValidationError`                   | rejects with `ValidationError`                      |

Wire formats, validation rules, error codes and streaming semantics are
identical, so a strategy ported between them behaves the same way.

## Requirements

- Node.js 20+ (`Symbol.asyncDispose`, used by `await using`, landed in Node 20)
- TypeScript 5.0+, if you use TypeScript
- [`undici`](https://undici.nodejs.org/) and [`ws`](https://github.com/websockets/ws)
  (installed automatically)

## Links

- API reference: <https://api.fxsocket.com/v1/docs>
- Examples: [`examples/`](https://github.com/fxsocket-com/FxSocket-Node-SDK/tree/main/examples)
- Python SDK: <https://github.com/fxsocket-com/FxSocket-Python-SDK>

## Development

```bash
npm install
npm run check   # lint + typecheck + unit tests
npm run build
```

Integration tests run against the real API and are opt-in:

```bash
FXSOCKET_API_KEY=fxs_live_… npm run test:live
```

## License

MIT — see [LICENSE](https://github.com/fxsocket-com/FxSocket-Node-SDK/blob/main/LICENSE).
