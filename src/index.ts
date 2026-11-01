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
  type CreatePrivateServerParams,
  type ResizePrivateServerParams,
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
  type ModifyEvent,
  type OrderCloseParams,
  type OrderEventMessage,
  type OrderModifyParams,
  type OrderSendParams,
  type OrdersEvent,
  type PositionsEvent,
  type ReplayedEvent,
  type StreamEnvelope,
  type StreamErrorEvent,
  type StreamEvent,
  type StreamEventMap,
  type StreamOptions,
  type SubscribedEvent,
  type SubscribeOptions,
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
  CLIENT_ORDER_ID_MAX_LENGTH,
  coerceOperation,
  coerceTimeframe,
  formatTime,
  formatUtcTime,
  MAX_BULK_SYMBOLS,
} from './validate.js';

export {
  CloseKind,
  CloseLegStatus,
  ClosedTicketStatus,
  CloseSide,
  DealEntry,
  ExpirationMode,
  HealthStatus,
  KeyScope,
  MT5_ONLY_TIMEFRAMES,
  OrderEventKind,
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
  TerminalErrorCode,
  Timeframe,
  TradingStatus,
  type OrderOperationInput,
  type TimeframeAlias,
  type TimeframeInput,
} from './enums.js';

export {
  AccountCapError,
  AccountsExceedTargetError,
  AlreadyLapsedError,
  AuthError,
  ClientOrderIdReusedError,
  ConnectFailedError,
  ConnectionError,
  DuplicateAccountError,
  errorFromResponse,
  ForbiddenError,
  FxSocketError,
  IdempotencyError,
  InsufficientBalanceError,
  NoSubscriptionError,
  NotBalanceFundedError,
  NotFoundError,
  PaymentRequiredError,
  RateLimitError,
  SeatLapsedError,
  ServerLimitError,
  SlotsFullError,
  StreamError,
  TerminalNotReadyError,
  TerminalTimeoutError,
  TimeoutError,
  TradeAbandonedError,
  TradeOutcomeUnknownError,
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
  OrderEventData,
  OrderFields,
  OrderLeg,
  OrderLegInput,
  OrderLegResult,
  OrderResult,
  PendingOrder,
  PositionModifyData,
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
  ServerTiming,
  SymbolInfo,
  SymbolInfoBatch,
  SymbolInfoError,
  SymbolSelectResult,
  TerminalHealth,
  TerminalStatus,
  TimeInput,
  TopUp,
  TradeEvent,
  TradingSession,
  UpcomingCharge,
  Wallet,
} from './types.js';
