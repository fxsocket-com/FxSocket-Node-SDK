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
