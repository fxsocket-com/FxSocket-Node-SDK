/**
 * Wire payload → model decoders.
 *
 * Decoding is deliberately tolerant, matching the Python SDK's pydantic models
 * (`extra="ignore"` plus field defaults): unknown fields are dropped, missing
 * optional fields fall back to the documented default, and unrecognised enum
 * values pass through unchanged instead of raising. That keeps an SDK release
 * working against a newer API.
 *
 * Input payloads are validated strictly elsewhere — see `validate.ts` and
 * `trading.ts`.
 */

import {
  ClosedTicketStatus,
  CloseLegStatus,
  OrderKind,
  OrderLegStatus,
  OrderOutcome,
} from './enums.js';
import type { HealthStatus, KeyScope, PrivateServerStatus } from './enums.js';
import { ValidationError } from './errors.js';
import type {
  Account,
  AccountHealth,
  AccountInfo,
  AccountSummary,
  BatchCloseResult,
  BatchCloseSummary,
  BatchOrderResult,
  BatchOrderSummary,
  BridgeHealth,
  BrokerHealth,
  Candle,
  CloseAllResult,
  CloseAllSummary,
  ClosedTicket,
  CloseLegResult,
  CommissionRule,
  CommissionTier,
  Health,
  HealthChecks,
  HistoryTrade,
  MarginCalc,
  OpenedOrder,
  OrderLegResult,
  OrderResult,
  PositionTrade,
  PrivateServer,
  PrivateServerAccount,
  PrivateServerOptions,
  ProfitCalc,
  Quote,
  ReadOnlyKey,
  Region,
  ScopedAccount,
  ServerTimezone,
  SymbolInfo,
  TerminalHealth,
  TerminalStatus,
  TopUp,
  TradeEvent,
  TradingSession,
  UpcomingCharge,
  Wallet,
} from './types.js';

/** A decoded JSON object. */
export type Wire = Record<string, unknown>;

export function asObject(value: unknown): Wire {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Wire)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function str(value: unknown, fallback = ''): string {
  return typeof value === 'string'
    ? value
    : value === undefined || value === null
      ? fallback
      : String(value);
}

export function num(value: unknown, fallback = 0): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function int(value: unknown, fallback = 0): number {
  return Math.trunc(num(value, fallback));
}

export function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** An integer field that is genuinely nullable on the wire. */
function intOrNull(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const parsed = num(value, Number.NaN);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

/** A UTC timestamp from the management API. */
export function date(value: unknown): Date {
  const parsed = dateOrNull(value);
  return parsed ?? new Date(Number.NaN);
}

/** A UTC timestamp that may be absent. */
export function dateOrNull(value: unknown): Date | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Cents → euros, for display. The cents field stays authoritative. */
export function eur(cents: number): number {
  return cents / 100;
}

function list<T>(value: unknown, decode: (row: Wire) => T): T[] {
  return asArray(value).map((row) => decode(asObject(row)));
}

/**
 * A string enum value, passed through even when the SDK doesn't know it.
 *
 * `T` comes from the target type (the field being decoded), never from the
 * fallback literal, so the result keeps the full union.
 */
function enumStr<T extends string>(value: unknown, fallback: NoInfer<T>): T {
  return typeof value === 'string' && value !== '' ? (value as T) : (fallback as T);
}

// --------------------------------------------------------------------------- //
// Management API (v1)
// --------------------------------------------------------------------------- //

export function decodeAccount(raw: unknown): Account {
  const w = asObject(raw);
  const restUrl = str(w['rest_url']);
  return {
    id: str(w['id']),
    nickname: str(w['nickname']),
    platform: enumStr(w['platform'], 'mt5'),
    server: str(w['server']),
    login: int(w['login']),
    status: enumStr(w['status'], 'connecting'),
    error: str(w['error']),
    restUrl,
    wsUrl: str(w['ws_url']),
    proxyAddress: str(w['proxy_address']),
    proxyType: str(w['proxy_type']),
    proxyLocalPort: intOrNull(w['proxy_local_port']),
    tradeEaSymbol: str(w['trade_ea_symbol']),
    createdAt: date(w['created_at']),
    hasTerminal: restUrl !== '',
  };
}

export function decodePrivateServerAccount(raw: unknown): PrivateServerAccount {
  const w = asObject(raw);
  const restUrl = str(w['rest_url']);
  return {
    id: str(w['id']),
    nickname: str(w['nickname']),
    platform: enumStr(w['platform'], 'mt5'),
    server: str(w['server']),
    login: int(w['login']),
    status: enumStr(w['status'], 'provisioning'),
    restUrl,
    wsUrl: str(w['ws_url']),
    tradeEaSymbol: str(w['trade_ea_symbol']),
    createdAt: date(w['created_at']),
    hasTerminal: restUrl !== '',
  };
}

export function decodePrivateServer(raw: unknown): PrivateServer {
  const w = asObject(raw);
  const status: PrivateServerStatus = enumStr(w['status'], 'provisioning');
  const purchasedSlots = int(w['purchased_slots']);
  const usedSlots = int(w['used_slots']);
  return {
    id: str(w['id']),
    name: str(w['name']),
    status,
    region: str(w['region']),
    ip: str(w['ip']),
    purchasedSlots,
    usedSlots,
    cancelAtPeriodEnd: bool(w['cancel_at_period_end']),
    periodEnd: dateOrNull(w['period_end']),
    accounts: list(w['accounts'], decodePrivateServerAccount),
    isReady: status === 'ready',
    freeSlots: Math.max(purchasedSlots - usedSlots, 0),
  };
}

export function decodeRegion(raw: unknown): Region {
  const w = asObject(raw);
  return { code: str(w['code']), label: str(w['label']) };
}

export function decodePrivateServerOptions(raw: unknown): PrivateServerOptions {
  const w = asObject(raw);
  const regions = list(w['regions'], decodeRegion);
  const firstSlotEurCents = int(w['first_slot_eur_cents']);
  const additionalSlotEurCents = int(w['additional_slot_eur_cents']);
  const priceEurCents = (slots: number): number => {
    if (!Number.isInteger(slots) || slots < 1) {
      throw new ValidationError(`slots must be a whole number >= 1, got ${slots}`);
    }
    return firstSlotEurCents + additionalSlotEurCents * (slots - 1);
  };
  return {
    enabled: bool(w['enabled'], true),
    regions,
    maxSlots: int(w['max_slots']),
    maxServers: int(w['max_servers']),
    firstSlotEurCents,
    additionalSlotEurCents,
    regionCodes: regions.map((region) => region.code),
    // Closures, not `this`, so a destructured `monthlyPriceEur` still works.
    monthlyPriceEurCents: priceEurCents,
    monthlyPriceEur: (slots: number) => eur(priceEurCents(slots)),
  };
}

export function decodeScopedAccount(raw: unknown): ScopedAccount {
  const w = asObject(raw);
  return {
    id: str(w['id']),
    nickname: str(w['nickname']),
    platform: enumStr(w['platform'], 'mt5'),
    server: str(w['server']),
    login: int(w['login']),
  };
}

export function decodeReadOnlyKey(raw: unknown): ReadOnlyKey {
  const w = asObject(raw);
  const scope: KeyScope = enumStr(w['scope'], 'all');
  const accounts = list(w['accounts'], decodeScopedAccount);
  return {
    id: str(w['id']),
    name: str(w['name']),
    key: str(w['key']),
    scope,
    accounts,
    createdAt: date(w['created_at']),
    lastUsedAt: dateOrNull(w['last_used_at']),
    isScoped: scope === 'selected',
    accountIds: accounts.map((a) => a.id),
  };
}

// --------------------------------------------------------------------------- //
// Management API (v1) — multi-account trading
// --------------------------------------------------------------------------- //

export function decodeOrderLegResult(raw: unknown): OrderLegResult {
  const w = asObject(raw);
  const status: OrderLegStatus = enumStr(w['status'], OrderLegStatus.REJECTED);
  return {
    accountId: str(w['account_id']),
    platform: enumStr(w['platform'], 'mt5'),
    symbol: str(w['symbol']),
    operation: enumStr(w['operation'], 'Buy'),
    volume: num(w['volume']),
    status,
    order: int(w['order']),
    deal: int(w['deal']),
    price: num(w['price']),
    bid: num(w['bid']),
    ask: num(w['ask']),
    retcode: int(w['retcode']),
    retcodeDescription: str(w['retcode_description']),
    message: str(w['message']),
    latencyMs: int(w['latency_ms']),
    isFilled: status === OrderLegStatus.FILLED,
    isUnknown: status === OrderLegStatus.TIMEOUT,
  };
}

function decodeBatchOrderSummary(raw: unknown): BatchOrderSummary {
  const w = asObject(raw);
  return {
    requested: int(w['requested']),
    filled: int(w['filled']),
    failed: int(w['failed']),
    unknown: int(w['unknown']),
  };
}

export function decodeBatchOrderResult(raw: unknown): BatchOrderResult {
  const w = asObject(raw);
  const summary = decodeBatchOrderSummary(w['summary']);
  const results = list(w['results'], decodeOrderLegResult);
  return {
    batchId: str(w['batch_id']),
    idempotentReplay: bool(w['idempotent_replay']),
    summary,
    results,
    allFilled: summary.filled === summary.requested,
    filledLegs: results.filter((r) => r.isFilled),
    failedLegs: results.filter((r) => !r.isFilled && !r.isUnknown),
    unknownLegs: results.filter((r) => r.isUnknown),
  };
}

export function decodeClosedTicket(raw: unknown): ClosedTicket {
  const w = asObject(raw);
  const status: ClosedTicketStatus = enumStr(w['status'], ClosedTicketStatus.REJECTED);
  const kind = str(w['kind']);
  return {
    ticket: int(w['ticket']),
    symbol: str(w['symbol']),
    type: enumStr(w['type'], 'Buy'),
    kind,
    volume: num(w['volume']),
    status,
    retcode: int(w['retcode']),
    retcodeDescription: str(w['retcode_description']),
    price: num(w['price']),
    message: str(w['message']),
    latencyMs: int(w['latency_ms']),
    isClosed: status === ClosedTicketStatus.CLOSED,
    isUnknown: status === ClosedTicketStatus.TIMEOUT,
    isPending: kind.toLowerCase() === 'pending',
  };
}

export function decodeCloseLegResult(raw: unknown): CloseLegResult {
  const w = asObject(raw);
  const status: CloseLegStatus = enumStr(w['status'], CloseLegStatus.FAILED);
  return {
    accountId: str(w['account_id']),
    platform: enumStr(w['platform'], ''),
    status,
    matched: int(w['matched']),
    closed: int(w['closed']),
    message: str(w['message']),
    latencyMs: int(w['latency_ms']),
    results: list(w['results'], decodeClosedTicket),
    isClosed: status === CloseLegStatus.CLOSED,
    nothingMatched: status === CloseLegStatus.NOTHING_MATCHED,
    isUnknown: status === CloseLegStatus.TIMEOUT,
  };
}

function decodeBatchCloseSummary(raw: unknown): BatchCloseSummary {
  const w = asObject(raw);
  return {
    accounts: int(w['accounts']),
    matched: int(w['matched']),
    closed: int(w['closed']),
    failed: int(w['failed']),
    unknown: int(w['unknown']),
    accountsUnknown: int(w['accounts_unknown']),
  };
}

export function decodeBatchCloseResult(raw: unknown): BatchCloseResult {
  const w = asObject(raw);
  const summary = decodeBatchCloseSummary(w['summary']);
  const results = list(w['results'], decodeCloseLegResult);
  return {
    batchId: str(w['batch_id']),
    idempotentReplay: bool(w['idempotent_replay']),
    summary,
    results,
    allClosed:
      summary.failed === 0 && summary.unknown === 0 && summary.accountsUnknown === 0,
    unknownAccounts: results.filter((r) => r.isUnknown),
  };
}

// --------------------------------------------------------------------------- //
// Management API (v1) — wallet
// --------------------------------------------------------------------------- //

export function decodeTopUp(raw: unknown): TopUp {
  const w = asObject(raw);
  const amountEurCents = int(w['amount_eur_cents']);
  const creditedEurCents = int(w['credited_eur_cents']);
  return {
    id: int(w['id']),
    status: str(w['status']),
    amountEurCents,
    creditedEurCents,
    depositAddress: str(w['deposit_address']),
    depositAmount: str(w['deposit_amount']),
    depositAmountDecimal: str(w['deposit_amount_decimal']),
    assetCode: str(w['asset_code']),
    blockchainCode: str(w['blockchain_code']),
    expiresAt: dateOrNull(w['expires_at']),
    amountEur: eur(amountEurCents),
    creditedEur: eur(creditedEurCents),
  };
}

export function decodeUpcomingCharge(raw: unknown): UpcomingCharge {
  const w = asObject(raw);
  const amountEurCents = int(w['amount_eur_cents']);
  return {
    when: date(w['when']),
    amountEurCents,
    kind: str(w['kind']),
    label: str(w['label']),
    amountEur: eur(amountEurCents),
  };
}

export function decodeWallet(raw: unknown): Wallet {
  const w = asObject(raw);
  const balanceEurCents = int(w['balance_eur_cents']);
  const upcomingTotalEurCents = int(w['upcoming_total_eur_cents']);
  const shortfallEurCents = int(w['shortfall_eur_cents']);
  return {
    balanceEurCents,
    pendingTopups: list(w['pending_topups'], decodeTopUp),
    upcoming: list(w['upcoming'], decodeUpcomingCharge),
    upcomingTotalEurCents,
    shortfallEurCents,
    coversUpcoming: bool(w['covers_upcoming'], true),
    balanceEur: eur(balanceEurCents),
    upcomingTotalEur: eur(upcomingTotalEurCents),
    shortfallEur: eur(shortfallEurCents),
  };
}

// --------------------------------------------------------------------------- //
// Terminal — account state
// --------------------------------------------------------------------------- //

export function decodeAccountSummary(raw: unknown): AccountSummary {
  const w = asObject(raw);
  return {
    balance: num(w['balance']),
    credit: num(w['credit']),
    profit: num(w['profit']),
    equity: num(w['equity']),
    margin: num(w['margin']),
    freeMargin: num(w['freeMargin']),
    marginLevel: num(w['marginLevel']),
    leverage: int(w['leverage']),
    currency: str(w['currency']),
    type: str(w['type']),
  };
}

export function decodeAccountInfo(raw: unknown): AccountInfo {
  const w = asObject(raw);
  return {
    name: str(w['name']),
    login: int(w['login']),
    server: str(w['server']),
    company: str(w['company']),
    currency: str(w['currency']),
    currencyDigits: int(w['currencyDigits']),
    leverage: int(w['leverage']),
    type: str(w['type']),
    marginMode: str(w['marginMode']),
    marginSoMode: str(w['marginSoMode']),
    marginCallLevel: num(w['marginCallLevel']),
    stopOutLevel: num(w['stopOutLevel']),
    tradeAllowed: bool(w['tradeAllowed']),
    tradeExpert: bool(w['tradeExpert']),
    limitOrders: int(w['limitOrders']),
    fifoClose: bool(w['fifoClose']),
  };
}

export function decodeOpenedOrder(raw: unknown): OpenedOrder {
  const w = asObject(raw);
  const kind: OrderKind = enumStr(w['kind'], OrderKind.POSITION);
  return {
    ticket: int(w['ticket']),
    symbol: str(w['symbol']),
    type: enumStr(w['type'], 'Buy'),
    kind,
    lots: num(w['lots']),
    openPrice: num(w['openPrice']),
    currentPrice: num(w['currentPrice']),
    stopLoss: num(w['stopLoss']),
    takeProfit: num(w['takeProfit']),
    swap: num(w['swap']),
    profit: num(w['profit']),
    magic: int(w['magic']),
    comment: str(w['comment']),
    openTime: str(w['openTime']),
    isPending: kind.toLowerCase() === 'pending',
  };
}

export function decodeHistoryTrade(raw: unknown): HistoryTrade {
  const w = asObject(raw);
  return {
    ticket: int(w['ticket']),
    order: int(w['order']),
    position: int(w['position']),
    symbol: str(w['symbol']),
    type: enumStr(w['type'], 'Buy'),
    entry: enumStr(w['entry'], 'Unknown'),
    volume: num(w['volume']),
    price: num(w['price']),
    commission: num(w['commission']),
    swap: num(w['swap']),
    profit: num(w['profit']),
    magic: int(w['magic']),
    comment: str(w['comment']),
    time: str(w['time']),
  };
}

export function decodePositionTrade(raw: unknown): PositionTrade {
  const w = asObject(raw);
  return {
    positionId: int(w['positionId']),
    symbol: str(w['symbol']),
    type: enumStr(w['type'], 'Buy'),
    volume: num(w['volume']),
    openTime: str(w['openTime']),
    openPrice: num(w['openPrice']),
    closeTime: str(w['closeTime']),
    closePrice: num(w['closePrice']),
    profit: num(w['profit']),
    swap: num(w['swap']),
    commission: num(w['commission']),
    netProfit: num(w['netProfit']),
    magic: int(w['magic']),
    comment: str(w['comment']),
  };
}

export function decodeServerTimezone(raw: unknown): ServerTimezone {
  const w = asObject(raw);
  return {
    serverTime: str(w['serverTime']),
    utcOffsetSeconds: int(w['utcOffsetSeconds']),
  };
}

// --------------------------------------------------------------------------- //
// Terminal — market data
// --------------------------------------------------------------------------- //

export function decodeQuote(raw: unknown): Quote {
  const w = asObject(raw);
  return {
    symbol: str(w['symbol']),
    bid: num(w['bid']),
    ask: num(w['ask']),
    time: str(w['time']),
    last: num(w['last']),
    volume: int(w['volume']),
  };
}

function decodeCommissionTier(raw: unknown): CommissionTier {
  const w = asObject(raw);
  return {
    mode: str(w['mode']),
    volumeType: str(w['volumeType']),
    value: num(w['value']),
    minValue: num(w['minValue']),
    maxValue: num(w['maxValue']),
    rangeFrom: num(w['rangeFrom']),
    rangeTo: num(w['rangeTo']),
    currency: str(w['currency']),
  };
}

export function decodeCommissionRule(raw: unknown): CommissionRule {
  const w = asObject(raw);
  return {
    currency: str(w['currency']),
    rangeMode: str(w['rangeMode']),
    chargeMode: str(w['chargeMode']),
    entryMode: str(w['entryMode']),
    directionMode: str(w['directionMode']),
    profitMode: str(w['profitMode']),
    tiers: list(w['tiers'], decodeCommissionTier),
  };
}

export function decodeTradingSession(raw: unknown): TradingSession {
  const w = asObject(raw);
  return {
    day: str(w['day']),
    from: str(w['from']),
    to: str(w['to']),
  };
}

export function decodeSymbolInfo(raw: unknown): SymbolInfo {
  const w = asObject(raw);
  return {
    symbol: str(w['symbol']),
    description: str(w['description']),
    digits: int(w['digits']),
    point: num(w['point']),
    tickSize: num(w['tickSize']),
    tickValue: num(w['tickValue']),
    contractSize: num(w['contractSize']),
    volumeMin: num(w['volumeMin']),
    volumeMax: num(w['volumeMax']),
    volumeStep: num(w['volumeStep']),
    stopsLevel: int(w['stopsLevel']),
    freezeLevel: int(w['freezeLevel']),
    spread: int(w['spread']),
    tradeMode: str(w['tradeMode']),
    swapLong: num(w['swapLong']),
    swapShort: num(w['swapShort']),
    bid: num(w['bid']),
    ask: num(w['ask']),
    currencyBase: str(w['currencyBase']),
    currencyProfit: str(w['currencyProfit']),
    currencyMargin: str(w['currencyMargin']),
    commissions: list(w['commissions'], decodeCommissionRule),
    sessions: list(w['sessions'], decodeTradingSession),
  };
}

export function decodeCandle(raw: unknown): Candle {
  const w = asObject(raw);
  return {
    time: str(w['time']),
    open: num(w['open']),
    high: num(w['high']),
    low: num(w['low']),
    close: num(w['close']),
    tickVolume: int(w['tickVolume']),
    realVolume: int(w['realVolume']),
    spread: int(w['spread']),
  };
}

// --------------------------------------------------------------------------- //
// Terminal — trading
// --------------------------------------------------------------------------- //

export function decodeOrderResult(raw: unknown): OrderResult {
  const w = asObject(raw);
  const success = bool(w['success']);
  const outcome: OrderOutcome | '' = enumStr(w['outcome'], '');
  const retcode = int(w['retcode']);
  const isNoChange = retcode === 10025 || outcome === OrderOutcome.NO_CHANGE;
  return {
    success,
    outcome,
    retcode,
    retcodeDescription: str(w['retcodeDescription']),
    deal: int(w['deal']),
    order: int(w['order']),
    volume: num(w['volume']),
    price: num(w['price']),
    bid: num(w['bid']),
    ask: num(w['ask']),
    comment: str(w['comment']),
    isNoChange,
    isEffective: success || isNoChange,
  };
}

function decodeCloseAllResult(raw: unknown): CloseAllResult {
  const w = asObject(raw);
  const kind = str(w['kind']);
  return {
    ticket: int(w['ticket']),
    kind,
    success: bool(w['success']),
    retcode: int(w['retcode']),
    retcodeDescription: str(w['retcodeDescription']),
    isPending: kind.toLowerCase() === 'pending',
  };
}

export function decodeCloseAllSummary(raw: unknown): CloseAllSummary {
  const w = asObject(raw);
  return {
    requested: int(w['requested']),
    closed: int(w['closed']),
    failed: int(w['failed']),
    results: list(w['results'], decodeCloseAllResult),
  };
}

export function decodeMarginCalc(raw: unknown): MarginCalc {
  const w = asObject(raw);
  return {
    symbol: str(w['symbol']),
    operation: enumStr(w['operation'], 'Buy'),
    volume: num(w['volume']),
    price: num(w['price']),
    margin: num(w['margin']),
    currency: str(w['currency']),
  };
}

export function decodeProfitCalc(raw: unknown): ProfitCalc {
  const w = asObject(raw);
  return {
    symbol: str(w['symbol']),
    operation: enumStr(w['operation'], 'Buy'),
    volume: num(w['volume']),
    priceOpen: num(w['priceOpen']),
    priceClose: num(w['priceClose']),
    profit: num(w['profit']),
    currency: str(w['currency']),
  };
}

// --------------------------------------------------------------------------- //
// Terminal — health
// --------------------------------------------------------------------------- //

function decodeTerminalHealth(raw: unknown): TerminalHealth {
  const w = asObject(raw);
  return {
    alive: bool(w['alive']),
    build: int(w['build']),
    pingMs: int(w['pingMs']),
  };
}

function decodeBrokerHealth(raw: unknown): BrokerHealth {
  const w = asObject(raw);
  return { connected: bool(w['connected']), server: str(w['server']) };
}

function decodeAccountHealth(raw: unknown): AccountHealth {
  const w = asObject(raw);
  return {
    loggedIn: bool(w['loggedIn']),
    login: int(w['login']),
    currency: str(w['currency']),
    type: str(w['type']),
    tradeAllowed: bool(w['tradeAllowed']),
  };
}

export function decodeBridgeHealth(raw: unknown): BridgeHealth {
  const w = asObject(raw);
  return {
    version: str(w['version']),
    tradeEaReady: bool(w['tradeEaReady']),
    // -1 means "never registered", and is also what pre-0.10 pods imply by
    // omitting the field — so the default must be -1, not 0.
    tradeEaHeartbeatAgeMs: int(w['tradeEaHeartbeatAgeMs'], -1),
    symbolsSynced: bool(w['symbolsSynced']),
  };
}

export function decodeHealth(raw: unknown): Health {
  const w = asObject(raw);
  const status: HealthStatus = enumStr(w['status'], 'down');
  return {
    status,
    terminal: decodeTerminalHealth(w['terminal']),
    broker: decodeBrokerHealth(w['broker']),
    account: decodeAccountHealth(w['account']),
    bridge: decodeBridgeHealth(w['bridge']),
    serverTime: str(w['serverTime']),
    isReady: status === 'ready',
  };
}

export function decodeHealthChecks(raw: unknown): HealthChecks {
  const w = asObject(raw);
  return {
    status: enumStr(w['status'], 'down'),
    terminal: bool(w['terminal']),
    broker: bool(w['broker']),
    account: bool(w['account']),
  };
}

// --------------------------------------------------------------------------- //
// Terminal — streaming payloads
// --------------------------------------------------------------------------- //

export function decodeTradeEvent(raw: unknown): TradeEvent {
  const w = asObject(raw);
  const profit = num(w['profit']);
  const commission = num(w['commission']);
  const swap = num(w['swap']);
  return {
    deal: int(w['deal']),
    order: int(w['order']),
    position: int(w['position']),
    symbol: str(w['symbol']),
    type: enumStr(w['type'], 'Buy'),
    entry: enumStr(w['entry'], 'Unknown'),
    volume: num(w['volume']),
    price: num(w['price']),
    profit,
    commission,
    swap,
    magic: int(w['magic']),
    comment: str(w['comment']),
    time: str(w['time']),
    degraded: bool(w['degraded']),
    netProfit: profit + commission + swap,
  };
}

export function decodeTerminalStatus(raw: unknown): TerminalStatus {
  const w = asObject(raw);
  return {
    connected: bool(w['connected']),
    tradeAllowed: bool(w['tradeAllowed']),
    serverTime: str(w['serverTime']),
  };
}

/** A list decoder, for endpoints that return an array. */
export function decodeList<T>(raw: unknown, decode: (row: unknown) => T): T[] {
  return asArray(raw).map(decode);
}
