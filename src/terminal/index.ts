/**
 * Per-account terminal API — REST trading/market-data and WebSocket streaming.
 *
 * The endpoints for an account come from `Account.restUrl` / `Account.wsUrl`
 * (populated by the management API), which already resolve shared-pod vs
 * private-droplet hosting.
 */

export {
  TerminalClient,
  type CloseAllParams,
  type OrderCloseParams,
  type OrderModifyParams,
  type OrderSendParams,
  type TerminalClientOptions,
  type TimeRange,
} from './client.js';

export {
  parseEvent,
  Stream,
  withApiKey,
  type AccountEvent,
  type BarEvent,
  type PositionsEvent,
  type StreamErrorEvent,
  type StreamEvent,
  type StreamEventMap,
  type StreamOptions,
  type SubscribedEvent,
  type SubscriptionsEvent,
  type TerminalEvent,
  type TickEvent,
  type TradeEventMessage,
  type UnknownEvent,
  type UnsubscribedEvent,
  type WarningEvent,
} from './stream.js';
