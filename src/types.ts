/**
 * Types for FxSocket API payloads.
 *
 * Two families:
 *
 * - **Management models** ({@link Account}, the multi-account trading batch
 *   models, {@link Wallet}) — the v1 API, which speaks `snake_case` on the wire
 *   and returns genuine UTC timestamps (decoded to `Date`).
 * - **Terminal payloads** — `camelCase` on the wire. Two deliberate typing
 *   choices keep these robust:
 *   - **MetaTrader vocabulary fields** (`type`, `kind`, `entry`, `status`)
 *     carry the documented union but decoders pass unknown server values
 *     through unchanged, so a `switch` over one should keep a `default` arm.
 *   - **Timestamps are `string`, not `Date`**: they are in *broker server time*
 *     with a stylistic trailing `Z`, so decoding them as UTC would be silently
 *     wrong. Use {@link ServerTimezone} to convert if needed.
 *
 * Fields marked *derived* are computed by the SDK when decoding, not sent by
 * the API. They mirror the Python SDK's properties.
 */

import type {
  ClosedTicketStatus,
  CloseKind,
  CloseLegStatus,
  CloseSide,
  DealEntry,
  HealthStatus,
  KeyScope,
  OrderKind,
  OrderLegStatus,
  OrderOperation,
  OrderOperationInput,
  OrderOutcome,
  Platform,
  PrivateAccountStatus,
  PrivateServerStatus,
  SymbolMatch,
  TradingStatus,
} from './enums.js';

// --------------------------------------------------------------------------- //
// Management API (v1)
// --------------------------------------------------------------------------- //

/**
 * A linked trading account, as returned by the management API (v1).
 *
 * `restUrl` / `wsUrl` are where this account's terminal REST and WebSocket APIs
 * live. Both are empty until the account has a reachable terminal (shared pod
 * or private droplet); a bridge-only account exposes none.
 *
 * `proxyAddress` / `proxyType` / `proxyLocalPort` describe the outbound proxy
 * the terminal is routed through (empty / `null` when there is none; the proxy
 * credentials are never returned). `tradeEaSymbol` is the chart symbol hosting
 * the trade expert — empty means the terminal picked one automatically.
 */
export interface Account {
  readonly id: string;
  readonly nickname: string;
  readonly platform: Platform;
  readonly server: string;
  readonly login: number;
  readonly status: TradingStatus;
  readonly error: string;
  readonly restUrl: string;
  readonly wsUrl: string;
  readonly proxyAddress: string;
  readonly proxyType: string;
  readonly proxyLocalPort: number | null;
  readonly tradeEaSymbol: string;
  readonly createdAt: Date;
  /** *Derived.* True when this account exposes a reachable terminal API. */
  readonly hasTerminal: boolean;
}

/**
 * An MT4/MT5 account living on a private server (v1 API).
 *
 * `status` is the private-hosting lifecycle (provisioning / ready / error /
 * expired). `restUrl` / `wsUrl` are the account's terminal API on the server's
 * dedicated IP. Private servers use a self-signed TLS certificate, so pass
 * `verify: false` (or construct the client with `verifyTerminalTls: false`)
 * when calling `client.terminal(...)`.
 */
export interface PrivateServerAccount {
  readonly id: string;
  readonly nickname: string;
  readonly platform: Platform;
  readonly server: string;
  readonly login: number;
  readonly status: PrivateAccountStatus;
  readonly restUrl: string;
  readonly wsUrl: string;
  readonly tradeEaSymbol: string;
  readonly createdAt: Date;
  /** *Derived.* True when this account exposes a reachable terminal API. */
  readonly hasTerminal: boolean;
}

/**
 * A dedicated private hosting server (v1 API).
 *
 * `purchasedSlots` is the paid limit; `usedSlots` how many accounts currently
 * live on the server. `cancelAtPeriodEnd` is true once the server has been told
 * to stop instead of renewing — it then runs until `periodEnd` and expires.
 */
export interface PrivateServer {
  readonly id: string;
  readonly name: string;
  readonly status: PrivateServerStatus;
  readonly region: string;
  readonly ip: string;
  readonly purchasedSlots: number;
  readonly usedSlots: number;
  /** True when the server is set to lapse at `periodEnd` instead of renewing. */
  readonly cancelAtPeriodEnd: boolean;
  readonly periodEnd: Date | null;
  readonly accounts: readonly PrivateServerAccount[];
  /** *Derived.* True when `status === 'ready'`. */
  readonly isReady: boolean;
  /** *Derived.* Purchased slots minus used slots, never below zero. */
  readonly freeSlots: number;
}

/** One place a private server can run in. */
export interface Region {
  readonly code: string;
  readonly label: string;
}

/**
 * Where private servers may run, how big they may be and what that costs
 * (`GET /v1/private-servers/regions`).
 *
 * `enabled` is false when private hosting is off for the deployment — `regions`
 * is then empty. Prices are integer EUR cents, and a server costs
 * `firstSlotEurCents + additionalSlotEurCents * (slots - 1)` per month;
 * {@link PrivateServerOptions.monthlyPriceEurCents} does that arithmetic. Treat
 * the returned list as authoritative rather than hardcoding region slugs.
 */
export interface PrivateServerOptions {
  readonly enabled: boolean;
  readonly regions: readonly Region[];
  readonly maxSlots: number;
  readonly maxServers: number;
  readonly firstSlotEurCents: number;
  readonly additionalSlotEurCents: number;
  /** *Derived.* Just the slugs, in the order the API returned them. */
  readonly regionCodes: readonly string[];
  /**
   * What a server of `slots` accounts costs per month, in integer EUR cents.
   * Raises {@link ValidationError} below one slot.
   */
  monthlyPriceEurCents(slots: number): number;
  /** {@link PrivateServerOptions.monthlyPriceEurCents} as euros, for display. */
  monthlyPriceEur(slots: number): number;
}

/** Compact account shape attached to a scoped read-only key. */
export interface ScopedAccount {
  readonly id: string;
  readonly nickname: string;
  readonly platform: Platform;
  readonly server: string;
  readonly login: number;
}

/**
 * A named read-only API key (`fxs_ro_…`), as returned by the v1 API.
 *
 * `key` is the plaintext secret — it is returned to its owner on every read
 * (there is no show-once step), so treat any object holding one as sensitive.
 * `scope` is `'all'` (sees every account) or `'selected'` (only `accounts`).
 * `lastUsedAt` is `null` until the key has authenticated once.
 */
export interface ReadOnlyKey {
  readonly id: string;
  readonly name: string;
  readonly key: string;
  readonly scope: KeyScope;
  readonly accounts: readonly ScopedAccount[];
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
  /** *Derived.* True when the key only sees the accounts attached to it. */
  readonly isScoped: boolean;
  /** *Derived.* The ids of the accounts attached to the key. */
  readonly accountIds: readonly string[];
}

// --------------------------------------------------------------------------- //
// Management API (v1) — multi-account trading (`/v1/orders`)
// --------------------------------------------------------------------------- //

/** Anything usable where an account id is expected. */
export type AccountRef = string | Account | PrivateServerAccount;

/** A moment in time, as an ISO string or a `Date`. */
export type TimeInput = string | Date;

/**
 * Order parameters shared by {@link OrderDefaults} and {@link OrderLeg}.
 *
 * Every field is optional: a leg only needs what its batch `defaults` don't
 * already say. Unknown fields are rejected, mirroring the API (an unknown field
 * fails the whole batch with `400`).
 */
export interface OrderFields {
  /** Exactly as the account's broker names it (`EURUSD`, `EURUSD.sd`…). */
  symbol?: string;
  /** `Buy`, `SellLimit`, … — case-insensitive. */
  operation?: OrderOperationInput;
  /** Lots; must be > 0. */
  volume?: number;
  /** Entry price — required for pending orders, ignored for market orders. */
  price?: number;
  /** Points; the terminal defaults to 10 when omitted. */
  slippage?: number;
  stopLoss?: number;
  takeProfit?: number;
  /** Required for `*StopLimit` operations. */
  stopLimitPrice?: number;
  /** Omit for good-till-cancelled. */
  expiration?: TimeInput;
  comment?: string;
  /** Magic number written onto the order (`expert_id` on the wire). */
  magic?: number;
  /** The API's own spelling of {@link OrderFields.magic}; either is accepted. */
  expertId?: number;
}

/**
 * Values every leg of a `client.orders.send()` batch inherits unless the leg
 * overrides them — "same trade, three accounts, three lot sizes" stays short
 * while nothing is locked down.
 */
export type OrderDefaults = OrderFields;

/**
 * One order aimed at one account, for `client.orders.send()`.
 *
 * Only `accountId` is mandatory (an {@link Account} / {@link PrivateServerAccount}
 * is accepted in its place); everything else may come from the batch
 * {@link OrderDefaults}. A value set here wins, *including a falsy one*:
 * `slippage: 0` really means zero, not "fall back to the default".
 */
export interface OrderLeg extends OrderFields {
  accountId: AccountRef;
}

/**
 * Anything `client.orders.send()` accepts as one leg: a full {@link OrderLeg},
 * or just the account (object or id) when the batch `defaults` say everything
 * else.
 */
export type OrderLegInput = OrderLeg | AccountRef;

/**
 * What happened to one leg of a `client.orders.send()` batch.
 *
 * `status` is the honest answer and only `'filled'` means the broker took it.
 * `'timeout'` is **unknown** — the order may well have reached the broker;
 * never blind-retry it (see {@link OrderLegResult.isUnknown}).
 *
 * `order` / `deal` are the resulting tickets (0 if none), `retcode` the
 * platform's own return code (0 when it never got that far) and `message` the
 * broker's order comment on a reply, otherwise why this leg did not get one.
 * `volume` is what the broker reported filling where it reported one, otherwise
 * the volume requested.
 */
export interface OrderLegResult {
  readonly accountId: string;
  readonly platform: Platform;
  readonly symbol: string;
  readonly operation: OrderOperation;
  readonly volume: number;
  readonly status: OrderLegStatus;
  readonly order: number;
  readonly deal: number;
  readonly price: number;
  readonly bid: number;
  readonly ask: number;
  readonly retcode: number;
  readonly retcodeDescription: string;
  readonly message: string;
  readonly latencyMs: number;
  /** *Derived.* True when the broker accepted the order. */
  readonly isFilled: boolean;
  /**
   * *Derived.* True when the leg timed out — it may or may not have executed.
   * Replay with the same `idempotencyKey` or reconcile against the account's
   * `openedOrders()` rather than re-sending.
   */
  readonly isUnknown: boolean;
}

/**
 * Counts for one `client.orders.send()` batch.
 *
 * `failed` legs provably never reached the broker; `unknown` legs timed out and
 * may or may not have executed — they are kept apart so a retry is a decision,
 * not a reflex.
 */
export interface BatchOrderSummary {
  readonly requested: number;
  readonly filled: number;
  readonly failed: number;
  readonly unknown: number;
}

/**
 * Reply of `client.orders.send()` (`POST /v1/orders`).
 *
 * `results` is *positional* — it mirrors the `orders` you sent one for one.
 * Don't match on `accountId`: it repeats when several legs target the same
 * account.
 *
 * `idempotentReplay` is true when this is the stored reply of an earlier batch
 * with the same `idempotencyKey` — nothing was sent.
 */
export interface BatchOrderResult {
  readonly batchId: string;
  readonly idempotentReplay: boolean;
  readonly summary: BatchOrderSummary;
  readonly results: readonly OrderLegResult[];
  /** *Derived.* True when every leg was accepted by its broker. */
  readonly allFilled: boolean;
  /** *Derived.* The legs the broker accepted. */
  readonly filledLegs: readonly OrderLegResult[];
  /** *Derived.* Legs that provably did not execute (not filled, not a timeout). */
  readonly failedLegs: readonly OrderLegResult[];
  /** *Derived.* Legs that timed out — they may or may not have executed. */
  readonly unknownLegs: readonly OrderLegResult[];
}

/** Selector shared by {@link CloseDefaults} and {@link CloseLeg}. */
export interface CloseFields {
  /**
   * Symbol to close, as the broker names it. `'*'` closes every symbol and must
   * be typed literally — an omitted symbol is an error, never a silent
   * close-everything.
   */
  symbol?: string;
  /** `exact` (default) or `base`. */
  symbolMatch?: SymbolMatch | (string & {});
  /** `long`, `short` or `any` (default). */
  side?: CloseSide | (string & {});
  /** `position` (default), `pending` or `any`. */
  kind?: CloseKind | (string & {});
  /** Only touch orders carrying this magic number. */
  magic?: number;
  /** Partial-close volume per matched position; omit for a full close. */
  volume?: number;
  /** Points; the terminal defaults to 10 when omitted. */
  slippage?: number;
}

/**
 * Selector values every account of a `client.orders.close()` batch inherits
 * unless it overrides them.
 */
export type CloseDefaults = CloseFields;

/**
 * What to close on one account, for `client.orders.close()`.
 *
 * Either a selector (`symbol` and friends — possibly inherited from the batch
 * {@link CloseDefaults}) or an explicit `tickets` list, never both. Tickets go
 * stale the moment a stop fires, so prefer a selector unless you read them from
 * `openedOrders()` moments ago.
 */
export interface CloseLeg extends CloseFields {
  accountId: AccountRef;
  tickets?: number[];
}

/** Anything `client.orders.close()` accepts as one account entry. */
export type CloseLegInput = CloseLeg | AccountRef;

/**
 * What happened to one ticket in a `client.orders.close()` batch.
 *
 * `'skipped'` means it was never sent (the per-account cap or the batch
 * deadline), so it definitely did not close; `'timeout'` means it was sent and
 * never answered, so it may well have. `kind` is `'position'` or `'pending'`;
 * `type` is `Buy`, `SellLimit`, ….
 */
export interface ClosedTicket {
  readonly ticket: number;
  readonly symbol: string;
  readonly type: OrderOperation;
  readonly kind: string;
  readonly volume: number;
  readonly status: ClosedTicketStatus;
  readonly retcode: number;
  readonly retcodeDescription: string;
  readonly price: number;
  readonly message: string;
  readonly latencyMs: number;
  /** *Derived.* True when the ticket closed. */
  readonly isClosed: boolean;
  /** *Derived.* True when the close timed out — it may or may not have happened. */
  readonly isUnknown: boolean;
  /** *Derived.* True when this row is a pending order (vs. a position). */
  readonly isPending: boolean;
}

/**
 * What happened on one account of a `client.orders.close()` batch.
 *
 * - `closed` — every matched order closed.
 * - `partial` — some closed, some did not; read `results`.
 * - `failed` — orders matched and none of them closed.
 * - `nothing_matched` — the selector found nothing. Not an error.
 * - `unavailable` / `unreachable` / `invalid` — the lookup itself failed, so
 *   nothing is known about what is open there (`matched` is 0 and says nothing).
 * - `timeout` — the lookup or the account's whole job ran out of time. Orders
 *   may have closed.
 */
export interface CloseLegResult {
  readonly accountId: string;
  readonly platform: Platform | '';
  readonly status: CloseLegStatus;
  readonly matched: number;
  readonly closed: number;
  readonly message: string;
  readonly latencyMs: number;
  readonly results: readonly ClosedTicket[];
  /** *Derived.* True when every matched order closed. */
  readonly isClosed: boolean;
  /** *Derived.* True when the selector found nothing. Not an error. */
  readonly nothingMatched: boolean;
  /** *Derived.* True when this account's job timed out — orders may have closed. */
  readonly isUnknown: boolean;
}

/**
 * Counts for one `client.orders.close()` batch.
 *
 * `failed` tickets provably did not close; `unknown` tickets timed out and may
 * or may not have. `accountsUnknown` are accounts whose ticket list was never
 * established — their `matched` is 0 and says nothing about what is actually
 * open there.
 */
export interface BatchCloseSummary {
  readonly accounts: number;
  readonly matched: number;
  readonly closed: number;
  readonly failed: number;
  readonly unknown: number;
  readonly accountsUnknown: number;
}

/**
 * Reply of `client.orders.close()` (`POST /v1/orders/close`).
 *
 * `results` mirrors the `accounts` you sent one for one, in request order.
 * `idempotentReplay` is true when this is the stored reply of an earlier batch
 * with the same `idempotencyKey` — nothing was sent.
 */
export interface BatchCloseResult {
  readonly batchId: string;
  readonly idempotentReplay: boolean;
  readonly summary: BatchCloseSummary;
  readonly results: readonly CloseLegResult[];
  /**
   * *Derived.* True when nothing failed, nothing timed out and every account's
   * open orders could be established — a selector that matched nothing counts
   * as done.
   */
  readonly allClosed: boolean;
  /** *Derived.* Accounts whose job timed out — orders there may have closed. */
  readonly unknownAccounts: readonly CloseLegResult[];
}

// --------------------------------------------------------------------------- //
// Management API (v1) — wallet (`/v1/wallet`, read-only)
// --------------------------------------------------------------------------- //

/**
 * A prepaid-balance top-up order.
 *
 * `status` is `pending`, `partial`, `paid` or `failed`. `creditedEurCents` is
 * what has actually landed so far — lower than `amountEurCents` while a payment
 * is short. `depositAmount` is the provider's raw *unscaled* integer string;
 * `depositAmountDecimal` is the human-readable amount. The quote lapses at
 * `expiresAt`.
 */
export interface TopUp {
  readonly id: number;
  readonly status: string;
  readonly amountEurCents: number;
  readonly creditedEurCents: number;
  readonly depositAddress: string;
  readonly depositAmount: string;
  readonly depositAmountDecimal: string;
  readonly assetCode: string;
  readonly blockchainCode: string;
  readonly expiresAt: Date | null;
  /** *Derived.* `amountEurCents` in euros. */
  readonly amountEur: number;
  /** *Derived.* `creditedEurCents` in euros. */
  readonly creditedEur: number;
}

/**
 * One thing the prepaid balance is going to pay for, and when.
 *
 * `kind` is `'seat'` (an account seat) or `'server'` (a balance-funded private
 * server); `label` names the account or server.
 */
export interface UpcomingCharge {
  readonly when: Date;
  readonly amountEurCents: number;
  readonly kind: 'seat' | 'server' | (string & {});
  readonly label: string;
  /** *Derived.* `amountEurCents` in euros. */
  readonly amountEur: number;
}

/**
 * Your prepaid balance: what is in it, what has been asked for but has not
 * landed yet, and what it is going to pay for over the next 30 days
 * (`GET /v1/wallet`).
 *
 * `upcoming` is a projection in date order covering account seats and
 * balance-funded private servers together, since they share the one balance.
 * Affordability is cumulative: with 24 EUR and three 12 EUR renewals the first
 * two are covered and the third is not, which is why `shortfallEurCents` is the
 * *total* gap (0 when covered), not the size of any single charge. All amounts
 * are integer EUR cents and authoritative; the `*Eur` fields are those cents
 * divided by 100, for display.
 */
export interface Wallet {
  readonly balanceEurCents: number;
  readonly pendingTopups: readonly TopUp[];
  readonly upcoming: readonly UpcomingCharge[];
  readonly upcomingTotalEurCents: number;
  readonly shortfallEurCents: number;
  readonly coversUpcoming: boolean;
  /** *Derived.* `balanceEurCents` in euros. */
  readonly balanceEur: number;
  /** *Derived.* `upcomingTotalEurCents` in euros. */
  readonly upcomingTotalEur: number;
  /** *Derived.* How much to top up to cover everything in `upcoming`, in euros. */
  readonly shortfallEur: number;
}

// --------------------------------------------------------------------------- //
// Terminal — account state
// --------------------------------------------------------------------------- //

/** Live financial snapshot (`GET /AccountSummary`). */
export interface AccountSummary {
  readonly balance: number;
  readonly credit: number;
  readonly profit: number;
  readonly equity: number;
  readonly margin: number;
  readonly freeMargin: number;
  readonly marginLevel: number;
  readonly leverage: number;
  readonly currency: string;
  readonly type: string;
}

/**
 * Static account identity + configuration (`GET /AccountInfo`).
 *
 * On MT4 `marginMode` is always `'Hedging'` and `fifoClose` always `false` (the
 * platform has no native equivalent).
 */
export interface AccountInfo {
  readonly name: string;
  readonly login: number;
  readonly server: string;
  readonly company: string;
  readonly currency: string;
  readonly currencyDigits: number;
  readonly leverage: number;
  readonly type: string;
  readonly marginMode: string;
  readonly marginSoMode: string;
  readonly marginCallLevel: number;
  readonly stopOutLevel: number;
  readonly tradeAllowed: boolean;
  readonly tradeExpert: boolean;
  readonly limitOrders: number;
  readonly fifoClose: boolean;
}

/** An open position or resting pending order (`GET /OpenedOrders`). */
export interface OpenedOrder {
  readonly ticket: number;
  readonly symbol: string;
  readonly type: OrderOperation;
  readonly kind: OrderKind;
  readonly lots: number;
  readonly openPrice: number;
  readonly currentPrice: number;
  readonly stopLoss: number;
  readonly takeProfit: number;
  readonly swap: number;
  readonly profit: number;
  readonly magic: number;
  readonly comment: string;
  /** Broker server time, as sent. Not a UTC timestamp. */
  readonly openTime: string;
  /** *Derived.* True for a resting pending order (vs. a live position). */
  readonly isPending: boolean;
}

/**
 * A historical deal / closed order (`GET /OrderHistory`).
 *
 * On MT4 this is one row per closed *order* (no per-deal granularity); `order`
 * aliases the ticket and `entry` is constant.
 *
 * `position` groups the rows of one round-trip: on MT5 it is the deal's
 * `DEAL_POSITION_ID` — the `In` and `Out` rows share it, and it equals the
 * `trades`-stream events' `position` and {@link PositionTrade.positionId} — so
 * an exit row alone identifies the position it closed even though MT5 exits
 * usually carry `magic = 0` / `comment = ''`. On MT4 it equals the order
 * ticket. 0 on pods older than bridge MT5 0.14 / MT4 0.13. (Netting-account
 * caveat: a reversal `InOut` row reports the position it belongs to *after*
 * processing.)
 */
export interface HistoryTrade {
  readonly ticket: number;
  readonly order: number;
  readonly position: number;
  readonly symbol: string;
  readonly type: OrderOperation;
  readonly entry: DealEntry;
  readonly volume: number;
  readonly price: number;
  readonly commission: number;
  readonly swap: number;
  readonly profit: number;
  readonly magic: number;
  readonly comment: string;
  /** Broker server time, as sent. Not a UTC timestamp. */
  readonly time: string;
}

/** A closed round-trip position (`GET /PositionHistory`). */
export interface PositionTrade {
  readonly positionId: number;
  readonly symbol: string;
  readonly type: OrderOperation;
  readonly volume: number;
  /** Broker server time, as sent. Not a UTC timestamp. */
  readonly openTime: string;
  readonly openPrice: number;
  /** Broker server time, as sent. Not a UTC timestamp. */
  readonly closeTime: string;
  readonly closePrice: number;
  readonly profit: number;
  readonly swap: number;
  readonly commission: number;
  readonly netProfit: number;
  readonly magic: number;
  readonly comment: string;
}

/**
 * Broker server clock + UTC offset (`GET /ServerTimezone`).
 *
 * `utcOffsetSeconds` is `serverTime - UTC`; subtract it from a broker-server
 * timestamp to get UTC.
 */
export interface ServerTimezone {
  readonly serverTime: string;
  readonly utcOffsetSeconds: number;
}

// --------------------------------------------------------------------------- //
// Terminal — market data
// --------------------------------------------------------------------------- //

/**
 * Latest tick for a symbol (`GET /getQuote`).
 *
 * `last` / `volume` are ~0 on forex (and always 0 on MT4).
 */
export interface Quote {
  readonly symbol: string;
  readonly bid: number;
  readonly ask: number;
  /** Broker server time, as sent. Not a UTC timestamp. */
  readonly time: string;
  readonly last: number;
  readonly volume: number;
}

/**
 * One tier of a commission rule — a value and the volume/turnover range it
 * applies to.
 *
 * Enum-like fields (`mode`, `volumeType`) carry the raw MQL5 constant names
 * (e.g. `SYMBOL_COMMISSION_MODE_MONEY`) so nothing is lost in translation.
 * `rangeTo === 0` means unbounded; `minValue` / `maxValue` cap the charged
 * amount (0 = no cap).
 */
export interface CommissionTier {
  readonly mode: string;
  readonly volumeType: string;
  readonly value: number;
  readonly minValue: number;
  readonly maxValue: number;
  readonly rangeFrom: number;
  readonly rangeTo: number;
  readonly currency: string;
}

/**
 * One broker commission rule for a symbol, as configured server-side
 * (MT5 `SymbolInfoCommissions`).
 *
 * A symbol can carry several rules; each has its own tiers. The mode fields
 * carry the MQL5 `ENUM_SYMBOL_COMMISSION_*` constant names verbatim.
 */
export interface CommissionRule {
  readonly currency: string;
  readonly rangeMode: string;
  readonly chargeMode: string;
  readonly entryMode: string;
  readonly directionMode: string;
  readonly profitMode: string;
  readonly tiers: readonly CommissionTier[];
}

/**
 * One trading-session window of a symbol, in *broker server time*.
 *
 * `day` uses the MQL `ENUM_DAY_OF_WEEK` constant names (`SUNDAY` … `SATURDAY`);
 * times are `HH:MM` where `24:00` means end of day, so a 24-hour market shows
 * `00:00`–`24:00`.
 */
export interface TradingSession {
  readonly day: string;
  readonly from: string;
  readonly to: string;
}

/**
 * Contract specification for a symbol (`GET /SymbolInfo`).
 *
 * `commissions` are the broker's commission rules straight from the server's
 * symbol specification; `sessions` are the per-weekday trading windows in
 * broker server time. Both default to empty on pods older than bridge 0.10 (and
 * `commissions` also when the broker publishes none or the terminal predates
 * the API — build 6060+).
 */
export interface SymbolInfo {
  readonly symbol: string;
  readonly description: string;
  readonly digits: number;
  readonly point: number;
  readonly tickSize: number;
  readonly tickValue: number;
  readonly contractSize: number;
  readonly volumeMin: number;
  readonly volumeMax: number;
  readonly volumeStep: number;
  readonly stopsLevel: number;
  readonly freezeLevel: number;
  readonly spread: number;
  readonly tradeMode: string;
  readonly swapLong: number;
  readonly swapShort: number;
  readonly bid: number;
  readonly ask: number;
  readonly currencyBase: string;
  readonly currencyProfit: string;
  readonly currencyMargin: string;
  readonly commissions: readonly CommissionRule[];
  readonly sessions: readonly TradingSession[];
}

/** One OHLC bar (`GET /PriceHistory`). `realVolume` is 0 on MT4. */
export interface Candle {
  /** Broker server time, as sent. Not a UTC timestamp. */
  readonly time: string;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly tickVolume: number;
  readonly realVolume: number;
  readonly spread: number;
}

// --------------------------------------------------------------------------- //
// Terminal — trading
// --------------------------------------------------------------------------- //

/**
 * Result of an order send / modify / close.
 *
 * `success` is true when `retcode` is DONE (10009) or PLACED (10008).
 *
 * `outcome` classifies the result further — `'applied'` / `'no_change'` /
 * `'partial'` / `'rejected'`. `'no_change'` (retcode 10025) is a benign
 * idempotent no-op — the requested SL/TP/price already match the current values
 * — so it is safe to treat as applied even though `success` is `false`. Use
 * {@link OrderResult.isEffective} when you only care that the requested state is
 * in effect (the idempotent-retry case). `outcome` is empty on bridges older
 * than MT5 0.6.1 / MT4 0.5.1.
 *
 * `deal` is the executed deal ticket (0 for pending placement, and always 0 on
 * MT4); `order` is the resulting position / pending-order ticket.
 */
export interface OrderResult {
  readonly success: boolean;
  readonly outcome: OrderOutcome | '';
  readonly retcode: number;
  readonly retcodeDescription: string;
  readonly deal: number;
  readonly order: number;
  readonly volume: number;
  readonly price: number;
  readonly bid: number;
  readonly ask: number;
  readonly comment: string;
  /**
   * *Derived.* True for a benign no-op (retcode 10025 / `outcome ===
   * 'no_change'`): the requested SL/TP/price already match the current values.
   */
  readonly isNoChange: boolean;
  /**
   * *Derived.* True when the requested state is in effect — either `success`
   * (applied) or a no-op. Use this for idempotent SL/TP management, where
   * re-sending an identical modify returns 10025 with `success === false`.
   */
  readonly isEffective: boolean;
}

/**
 * One per-ticket outcome of a `/CloseAll` pass.
 *
 * `kind` is `'position'` (closed) or `'pending'` (deleted).
 */
export interface CloseAllResult {
  readonly ticket: number;
  readonly kind: string;
  readonly success: boolean;
  readonly retcode: number;
  readonly retcodeDescription: string;
  /** *Derived.* True when this row is a deleted pending order. */
  readonly isPending: boolean;
}

/**
 * Reply of `POST /CloseAll` — every matched position (and pending order, when
 * `deletePending` was set) with its close/delete outcome.
 *
 * `requested` is how many orders the filters matched and were attempted;
 * `closed` how many attempts the broker accepted; `failed` how many it rejected
 * — inspect `results` for the per-ticket retcodes.
 */
export interface CloseAllSummary {
  readonly requested: number;
  readonly closed: number;
  readonly failed: number;
  readonly results: readonly CloseAllResult[];
}

/** Required margin for a hypothetical order (`GET /OrderCalcMargin`). */
export interface MarginCalc {
  readonly symbol: string;
  readonly operation: OrderOperation;
  readonly volume: number;
  readonly price: number;
  readonly margin: number;
  readonly currency: string;
}

/** Projected P/L for a hypothetical trade (`GET /OrderCalcProfit`). */
export interface ProfitCalc {
  readonly symbol: string;
  readonly operation: OrderOperation;
  readonly volume: number;
  readonly priceOpen: number;
  readonly priceClose: number;
  readonly profit: number;
  readonly currency: string;
}

// --------------------------------------------------------------------------- //
// Terminal — health
// --------------------------------------------------------------------------- //

export interface TerminalHealth {
  readonly alive: boolean;
  readonly build: number;
  readonly pingMs: number;
}

export interface BrokerHealth {
  readonly connected: boolean;
  readonly server: string;
}

/**
 * Account section of `/status`. `currency` / `type` are blank when not logged
 * in; `login` is always the configured account.
 */
export interface AccountHealth {
  readonly loggedIn: boolean;
  readonly login: number;
  readonly currency: string;
  readonly type: string;
  readonly tradeAllowed: boolean;
}

/**
 * Bridge section of `/status`.
 *
 * `tradeEaHeartbeatAgeMs` is how long ago the trade EA last made dispatcher
 * progress (`-1` = never registered, or a pod older than bridge 0.10). A large
 * age while `tradeEaReady` is still `true` means the EA is blocked in a long
 * dealer call or dead — worth alerting on.
 */
export interface BridgeHealth {
  readonly version: string;
  readonly tradeEaReady: boolean;
  readonly tradeEaHeartbeatAgeMs: number;
  readonly symbolsSynced: boolean;
}

/** Full health snapshot (`GET /status`) — always HTTP 200. */
export interface Health {
  readonly status: HealthStatus;
  readonly terminal: TerminalHealth;
  readonly broker: BrokerHealth;
  readonly account: AccountHealth;
  readonly bridge: BridgeHealth;
  /** Broker server time, as sent. Not a UTC timestamp. */
  readonly serverTime: string;
  /** *Derived.* True when `status === 'ready'`. */
  readonly isReady: boolean;
}

/** PII-free probe body from `/healthz` and `/livez`. */
export interface HealthChecks {
  readonly status: HealthStatus;
  readonly terminal: boolean;
  readonly broker: boolean;
  readonly account: boolean;
}

// --------------------------------------------------------------------------- //
// Terminal — streaming payloads (the inner `data` of some WS events)
// --------------------------------------------------------------------------- //

/**
 * A trade transaction pushed on the `trades` stream.
 *
 * `entry` is the deal direction (`'Unknown'` appears only on degraded frames).
 * `commission` / `swap` / `magic` (and a real `comment` on MT5) arrive on
 * bridges MT5 0.12+ / MT4 0.11+ and default to 0 before that; a deal's net P&L
 * is `profit + commission + swap` ({@link TradeEvent.netProfit}).
 *
 * Platform semantics:
 *
 * - **MT5** — `Out` deals carry `magic = 0` / `comment = ''` unless the closing
 *   request set them (a platform property, not a bridge gap). Correlate
 *   `In`/`Out` through `position`, which is present on every event.
 * - **MT4** — orders keep their magic/comment for the whole lifecycle, so both
 *   `In` and `Out` events carry them; `deal` is always 0 and `position` equals
 *   the order ticket.
 *
 * `degraded === true` (bridges MT5 0.13+ / MT4 0.12+; structurally always
 * `false` on MT4) means the bridge could not fully enrich the event in time:
 * the identifiers, `symbol`, `type`, `volume` and `price` are trustworthy, but
 * `entry` is `'Unknown'` and `profit` / `commission` / `swap` / `magic` /
 * `comment` are zeroed — reconcile the deal via `GET /OrderHistory`.
 */
export interface TradeEvent {
  readonly deal: number;
  readonly order: number;
  readonly position: number;
  readonly symbol: string;
  readonly type: OrderOperation;
  readonly entry: DealEntry;
  readonly volume: number;
  readonly price: number;
  readonly profit: number;
  readonly commission: number;
  readonly swap: number;
  readonly magic: number;
  readonly comment: string;
  /** Broker server time, as sent. Not a UTC timestamp. */
  readonly time: string;
  readonly degraded: boolean;
  /** *Derived.* Deal P&L including costs: `profit + commission + swap`. */
  readonly netProfit: number;
}

/** Terminal status pushed (~1/s) on the `terminal` stream. */
export interface TerminalStatus {
  readonly connected: boolean;
  readonly tradeAllowed: boolean;
  /** Broker server time, as sent. Not a UTC timestamp. */
  readonly serverTime: string;
}
