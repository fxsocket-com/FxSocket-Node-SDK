/**
 * FxSocket Node.js / TypeScript SDK.
 *
 * Account management, multi-account trading and the wallet (the v1 API), plus
 * per-account terminal REST and WebSocket streaming for MT4/MT5.
 *
 * ```ts
 * import { FxSocket } from '@fxsocket/sdk';
 *
 * const fx = new FxSocket({ apiKey: 'fxs_live_…' });
 * const [account] = await fx.accounts.list();
 * const terminal = fx.terminal(account);
 * console.log((await terminal.quote('EURUSD')).ask);
 * await fx.close();
 * ```
 */

export { VERSION } from './version.js';

export { DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS, ENV_API_KEY } from './config.js';

export {
  FxSocket,
  FxSocket as Client,
  type FxSocketOptions,
  type StreamFactoryOptions,
  type TerminalAccount,
  type TerminalOptions,
} from './client.js';

export {
  Orders,
  buildCloseBatch,
  buildOrderBatch,
  idempotencyHeaders,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  type CloseOrdersOptions,
  type SendOrdersOptions,
} from './trading.js';

export {
  Accounts,
  accountIdOf,
  type CreateAccountParams,
  type UpdateAccountParams,
} from './management/accounts.js';

export {
  PrivateServers,
  privateServerIdOf,
  type AddPrivateAccountParams,
} from './management/private-servers.js';

export {
  ReadOnlyKeys,
  readonlyKeyIdOf,
  type CreateReadOnlyKeyParams,
  type UpdateReadOnlyKeyParams,
} from './management/readonly-keys.js';

export { WalletResource } from './management/wallet.js';

export {
  parseEvent,
  Stream,
  TerminalClient,
  withApiKey,
  type AccountEvent,
  type BarEvent,
  type CloseAllParams,
  type OrderCloseParams,
  type OrderModifyParams,
  type OrderSendParams,
  type PositionsEvent,
  type StreamErrorEvent,
  type StreamEvent,
  type StreamEventMap,
  type StreamOptions,
  type SubscribedEvent,
  type SubscriptionsEvent,
  type TerminalClientOptions,
  type TerminalEvent,
  type TickEvent,
  type TimeRange,
  type TradeEventMessage,
  type UnknownEvent,
  type UnsubscribedEvent,
  type WarningEvent,
} from './terminal/index.js';

export {
  checkTimeframe,
  coerceOperation,
  coerceTimeframe,
  formatTime,
} from './validate.js';

export {
  CloseKind,
  CloseLegStatus,
  ClosedTicketStatus,
  CloseSide,
  DealEntry,
  HealthStatus,
  KeyScope,
  MT5_ONLY_TIMEFRAMES,
  OrderKind,
  OrderLegStatus,
  OrderOperation,
  OrderOutcome,
  PENDING_OPERATIONS,
  Platform,
  PrivateAccountStatus,
  PrivateServerStatus,
  STOP_LIMIT_OPERATIONS,
  STREAM_TOPICS,
  StreamTopic,
  SymbolMatch,
  Timeframe,
  TradingStatus,
  type OrderOperationInput,
  type TimeframeAlias,
  type TimeframeInput,
} from './enums.js';

export {
  AccountCapError,
  AuthError,
  ConnectFailedError,
  ConnectionError,
  DuplicateAccountError,
  errorFromResponse,
  ForbiddenError,
  FxSocketError,
  IdempotencyError,
  InsufficientBalanceError,
  NoSubscriptionError,
  NotFoundError,
  PaymentRequiredError,
  RateLimitError,
  SeatLapsedError,
  SlotsFullError,
  StreamError,
  TerminalNotReadyError,
  TerminalTimeoutError,
  TimeoutError,
  UnsupportedOnPlatformError,
  ValidationError,
  type ErrorResponse,
  type FxSocketErrorOptions,
} from './errors.js';

export type {
  Account,
  AccountHealth,
  AccountInfo,
  AccountRef,
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
  CloseDefaults,
  ClosedTicket,
  CloseFields,
  CloseLeg,
  CloseLegInput,
  CloseLegResult,
  CommissionRule,
  CommissionTier,
  Health,
  HealthChecks,
  HistoryTrade,
  MarginCalc,
  OpenedOrder,
  OrderDefaults,
  OrderFields,
  OrderLeg,
  OrderLegInput,
  OrderLegResult,
  OrderResult,
  PositionTrade,
  PrivateServer,
  PrivateServerAccount,
  ProfitCalc,
  Quote,
  ReadOnlyKey,
  ScopedAccount,
  ServerTimezone,
  SymbolInfo,
  TerminalHealth,
  TerminalStatus,
  TimeInput,
  TopUp,
  TradeEvent,
  TradingSession,
  UpcomingCharge,
  Wallet,
} from './types.js';
