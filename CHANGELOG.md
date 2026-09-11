# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.6.0]: https://github.com/fxsocket-com/FxSocket-Node-SDK/releases/tag/v0.6.0
