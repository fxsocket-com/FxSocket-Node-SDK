# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.9.0] - 2026-11-01

Matches [FxSocket Python SDK](https://github.com/fxsocket-com/FxSocket-Python-SDK)
0.9.0.

Support for terminal bridge MT5 0.17.0 / MT4 0.15.0: pending orders end to
end, safe order retries, a replay of missed deals, fixed error codes and UTC
times. The new fields and endpoints need a terminal on those bridge versions
(`(await terminal.status()).bridge.version`). On older bridges every new field
keeps its default, so nothing breaks; it is simply absent.

### Added

- `terminal.pendingOrders()` and the `PendingOrder` type: the active pending
  orders with stop-limit price, initial volume, `expirationMode`, `expiration`
  (broker server time) and `expirationUtc`.
- The `orders` stream topic (`stream.subscribeOrders()` /
  `unsubscribeOrders()`): an `orders` snapshot event, then an `order` event per
  step of a pending order's life (`OrderEventKind`: placed, modified, deleted,
  expired, triggered; `triggered` carries the `position` the fill opened).
- `clientOrderId` on `orderSend()` (1-64 characters, remembered by the
  terminal for 10 minutes). A repeat with the same id trades nothing and
  answers with the first result, so a retry after a timeout is safe. Results
  carry `idempotentReplayed`, and reusing an id for a different order throws
  the new `ClientOrderIdReusedError` (409 `MRPC_CLIENT_ORDER_ID_REUSED`).
- `expirationUtc` on `orderSend()` and `orderModify()`: a pending order's
  expiry in real UTC (a `Date`, sent as `YYYY-MM-DDTHH:MM:SSZ`, or an ISO-8601
  UTC string). Cannot be combined with `expiration`.
- `terminal.symbolSelect(symbols)` puts up to 100 symbols into Market Watch in
  one pass and reports whether each quotes; `terminal.symbolInfos(symbols)`
  looks up to 100 symbols at once (`SymbolInfoBatch`, with the misses in
  `errors`). Warm a copier's symbols before its first trade.
- `SymbolInfo.orderModes`, `expirationModes` and `fillingModes` (what the
  broker accepts for the symbol), and the `ExpirationMode` enum.
- `OrderResult.position`, `time`, `timeUtc`, `remainderTicket` (MT4: the ticket
  the rest of a partial close moved to), `clientOrderId`, and `serverTiming`
  (`queueMs` / `execMs`, from the `Server-Timing` header).
- Trade events gain `sl`, `tp`, `positionVolume` (volume still open after the
  deal; `-1` when unknown), `timeUtc`, and on MT4 `remainderTicket` /
  `remainderOf`, which link the halves of a partial close.
- `modify` events on the `trades` topic: an open position's stops moved.
- `subscribeTrades({ since })`: replay the deals at or after a broker server
  time (at most 24 h back, the newest 1000), then a `replayed` event, then live
  frames. Replayed trade events have `replay: true`.
- **Trades resume across a reconnect** (`resumeTrades`, on by default). After
  an automatic reconnect the stream resubscribes `trades` with `since` set to
  the newest deal it delivered, so deals made while the connection was down
  are not lost, and drops the duplicates of the overlap (by `deal` on MT5,
  `order` + `entry` on MT4). This also closes the old gap where deals in the
  first seconds after a cold subscribe could be missed. Pass
  `resumeTrades: false` for the previous behavior.
- The frame envelope on every data event: `seq` (per topic; a gap means the
  server dropped frames), `ts` (Unix ms UTC) and `snapshot`. `warning` events
  name their `topic` (and `symbol` / `timeframe`).
- `TradeOutcomeUnknownError` and `TradeAbandonedError`, both subclasses of
  `TerminalTimeoutError`, tell a trade's two 504s apart: `MRPC_TRADE_OUTCOME_UNKNOWN`
  (the terminal took it; it may have executed) and `MRPC_ABANDONED` (it never
  reached the terminal; sending it again is safe).
- `TerminalErrorCode`, the terminal API's fixed error codes, for branching on
  `error.code`.
- The trade-pipeline fields of `/status` on `BridgeHealth` (`asyncTrades`,
  `tradeInFlight`, `oldestTradeInFlightAgeMs`, `dealerRttMsEwma`,
  `tradeRequestsSent`, `lateTradeVerdicts`, `tradeQueueDepth`,
  `nonTradeQueueDepth`, `tradeDeferred`).
- `DealEntry.OUT_BY`.

### Changed

- On an MT4 account a `BuyStopLimit` / `SellStopLimit` order, or a
  `stopLimitPrice` on `orderModify()`, now throws `UnsupportedOnPlatformError`
  before anything is sent. MT4 has no stop-limit order type: the bridge
  refused the order with a 400 and silently ignored the modify field. The SDK
  docs used to claim MT4 accepted all eight operations.
- `MRPC_TRADE_EA_STOPPED` (the trade EA stopped before it sent the request,
  nothing executed) maps to `TerminalNotReadyError`.
- Terminal errors carry a fixed `code` instead of the generic `MRPC`, and an
  unknown symbol is now a 400 (`ValidationError`, `MRPC_UNKNOWN_SYMBOL`) where
  it used to be a 500. Both come from the bridge; branch on `error.code`.
- `WarningEvent` gained fields, so code comparing a whole warning event with
  `toEqual` needs updating.

## [0.8.0] - 2026-10-26

Matches [FxSocket Python SDK](https://github.com/fxsocket-com/FxSocket-Python-SDK)
0.8.0.

### Removed

- `Timeframe.M2`, `M3`, `H2`, `H6`, `H8` and `H12`, and the `2min`, `3min`,
  `2h`, `6h`, `8h` and `12h` aliases (also dropped from `TimeframeAlias`). The
  SDK treated them as MT5-only, but neither terminal API serves them: MT4 and
  MT5 both accept exactly `M1`, `M5`, `M15`, `M30`, `H1`, `H4`, `D1`, `W1` and
  `MN1`, in REST `priceHistory` and on the `bars` stream. On an MT5 account they
  passed the SDK and the terminal refused them (HTTP 400 from `priceHistory`,
  an `error` frame and no bars from the stream).

  They are removed rather than kept and rejected on both platforms, so that
  `Timeframe` lists exactly what the server accepts: `Object.values(Timeframe)`
  gives the usable set, and `Timeframe.H2` is now a compile error instead of a
  runtime failure. The only code this breaks is code that could never succeed.

### Changed

- A timeframe outside those nine now throws `ValidationError` on both
  platforms before anything is sent, and the message lists the accepted
  labels. On MT4 the six removed ones used to throw
  `UnsupportedOnPlatformError`, so code that caught that for timeframes should
  catch `ValidationError` instead. Nothing throws `UnsupportedOnPlatformError`
  now; it stays exported.

### Deprecated

- `MT5_ONLY_TIMEFRAMES` is always empty, and `checkTimeframe()` no longer looks
  at the platform (its second argument is optional and ignored; it only checks
  the timeframe is one of the nine). Both will be removed in 1.0.

## [0.7.0] - 2026-09-14

Matches [FxSocket Python SDK](https://github.com/fxsocket-com/FxSocket-Python-SDK)
0.7.0.

### Added

- `privateServers` now covers the whole v1 Private Servers surface.
  `create()` buys a server from the prepaid balance (slots / region / optional
  name, charged immediately, comes back `provisioning`); `resize()` changes the
  slot count (increases prorated and charged now, decreases scheduled for
  renewal); `cancel()` / `resume()` stop and restart renewal; `delete()`
  destroys the machine with no refund.
- `privateServers.regions()`, returning the new `PrivateServerOptions` —
  available regions, `maxSlots` / `maxServers` and pricing in cents, with a
  materialized `regionCodes` and `monthlyPriceEurCents()` /
  `monthlyPriceEur()` for what a given slot count costs per month.
- `ServerLimitError` (409 `server_limit_reached`), `AccountsExceedTargetError`
  (409 `accounts_exceed_target`), `AlreadyLapsedError` (409 `already_lapsed`)
  and `NotBalanceFundedError` (403 `not_balance_funded`, a `ForbiddenError`
  subclass). Without these the 409 branch of `errorFromResponse` fell through
  to `DuplicateAccountError`, mislabelling every new conflict.

### Changed

- Docs no longer claim purchasing, resizing and cancelling are dashboard-only;
  `SlotsFullError` points at `resize()` instead.

## [0.6.0] - 2026-09-11

Initial release. Feature parity with the
[FxSocket Python SDK](https://github.com/fxsocket-com/FxSocket-Python-SDK) 0.6.0,
which is why the version starts there rather than at 0.1.0.

### Added

- `FxSocket` client covering the whole v1 management API: `accounts`,
  `privateServers`, `readonlyKeys`, `wallet` and `orders` (multi-account
  trading).
- `TerminalClient` for the per-account terminal REST API — account state,
  market data, symbol specifications, OHLC history, margin/profit calculators,
  order send/modify/close, `closeAll`, and the health endpoints.
- `Stream` for per-account WebSocket streaming: ticks, bars, account,
  positions, trades and terminal status, with automatic reconnect and
  subscription replay. Usable as an async iterable or an `EventEmitter`.
- Client-side validation that mirrors the API's own, so a malformed order or
  batch fails before anything is sent — including the guard that rejects a
  bare `stopLoss: 0` in `orderModify`, which would otherwise silently remove
  the stop.
- Typed error hierarchy under `FxSocketError`, mapped from both the management
  and terminal error envelopes.
- Dual ESM and CommonJS builds with type declarations for each.

### Fixed before release

Found by an adversarial review of the port and reproduced against a local
WebSocket server:

- A stream whose reconnect budget ran out stayed permanently un-iterable. The
  iterator surfaced the error and latched, so the standard recovery (catch,
  reconnect, keep iterating) produced a feed the app believed was live and which
  never delivered another tick. `connect()` now clears the latch.
- `close()` racing an in-flight handshake left a live, subscribed socket and its
  ping timer behind, still delivering events to listeners. The handshake now
  refuses to install a socket once the stream is closing.
- A `reconnected` listener that threw was read as a failed attempt, so the
  retry loop opened a second socket while the first was live and duplicated
  every tick and trade. The event is now emitted outside the retry block.
- `verifyTls: false` was silently discarded whenever a custom dispatcher was
  supplied, leaving private-hosting droplets failing on their self-signed
  certificate with nothing in the caller's configuration to explain it. The
  contradiction now raises.
- A timeout that elapsed while the response body was still streaming escaped as
  undici's own error instead of a `TimeoutError`.
- A second concurrent `for await` on one stream silently starved instead of
  saying so, and `listSubscriptions()` mid-reconnect resolved without ever
  producing a frame.
- A hand-written `{id, volume}` batch leg was read as a bare account, silently
  dropping every other field.

### Notes

- Node is async-only, so the Python SDK's `Client` / `AsyncClient` pair
  collapses into the single promise-based `FxSocket`. `Client` is exported as
  an alias.
- Properties that are Python `@property` accessors (`hasTerminal`, `isFilled`,
  `allClosed`, …) are materialized as plain fields when a payload is decoded.
- Node 20 is the floor: `Symbol.asyncDispose`, which backs `await using`, does
  not exist on Node 18 (itself long past end of life).
- Streams buffer events for a slow consumer and drop the oldest past
  `maxQueueSize` (10,000 by default), emitting a `lag` event, so a fast tick
  feed cannot grow memory without bound.

[0.9.0]: https://github.com/fxsocket-com/FxSocket-Node-SDK/releases/tag/v0.9.0
[0.8.0]: https://github.com/fxsocket-com/FxSocket-Node-SDK/releases/tag/v0.8.0
[0.7.0]: https://github.com/fxsocket-com/FxSocket-Node-SDK/releases/tag/v0.7.0
[0.6.0]: https://github.com/fxsocket-com/FxSocket-Node-SDK/releases/tag/v0.6.0
