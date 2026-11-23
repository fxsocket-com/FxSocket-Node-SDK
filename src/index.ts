/**
 * FxSocket Node.js / TypeScript SDK.
 *
 * Account management, cTrader sign-in, multi-account trading and the wallet (the
 * v1 API), plus per-account terminal REST and WebSocket streaming for MT4, MT5
 * and cTrader.
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
  CtraderSignIns,
  linkAccountsPayload,
  MAX_LINK_ACCOUNTS,
  signInIdOf,
  type CreateSignInParams,
  type SignInRef,
  type WaitSignInOptions,
} from './management/ctrader-sign-ins.js';

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
  type JournalParams,
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
  formatSinceUtc,
  formatUtcTime,
  MAX_BULK_SYMBOLS,
  MAX_JOURNAL_ENTRIES,
} from './validate.js';

export {
  CloseKind,
  CloseLegStatus,
  ClosedTicketStatus,
  CloseSide,
  CtraderSignInStatus,
  DealEntry,
  Execution,
  ExpirationMode,
  HealthStatus,
  JournalKind,
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
  type ExecutionInput,
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
  CtraderAccountNotInSignInError,
  CtraderReauthRequiredError,
  DuplicateAccountError,
  errorFromResponse,
  ForbiddenError,
  FxSocketError,
  IdempotencyError,
  InsufficientBalanceError,
  ManualNotSentError,
  NoSubscriptionError,
  NotBalanceFundedError,
  NotFoundError,
  NotPendingError,
  PaymentRequiredError,
  RateLimitError,
  SeatLapsedError,
  ServerLimitError,
  SignInExpiredError,
  SignInLimitError,
  SignInNotCompletedError,
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
  CtraderAccountInput,
  CtraderLinkResult,
  CtraderSignIn,
  CtraderSignInAccount,
  CtraderSignInStarted,
  Health,
  HealthChecks,
  HistoryTrade,
  JournalEntry,
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
