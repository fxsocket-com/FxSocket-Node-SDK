/**
 * The top-level entry point: {@link FxSocket}.
 *
 * It exposes the management API — `.accounts`, `.privateServers`,
 * `.readonlyKeys`, `.wallet` and `.orders` (multi-account trading) — plus
 * `.terminal(account)` (the per-account terminal REST client) and
 * `.stream(account)` (WebSocket streaming).
 */

import type { Dispatcher } from 'undici';

import { DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS, ENV_API_KEY } from './config.js';
import { AuthError, TerminalNotReadyError } from './errors.js';
import { HttpTransport } from './http.js';
import { Accounts } from './management/accounts.js';
import { PrivateServers } from './management/private-servers.js';
import { ReadOnlyKeys } from './management/readonly-keys.js';
import { WalletResource } from './management/wallet.js';
import { TerminalClient } from './terminal/client.js';
import { Stream } from './terminal/stream.js';
import { Orders } from './trading.js';
import type { Account, PrivateServerAccount } from './types.js';

/** An account carrying the terminal endpoints, from either management API. */
export type TerminalAccount = Account | PrivateServerAccount;

export interface FxSocketOptions {
  /**
   * Your FxSocket API key (`fxs_live_…`, or a read-only `fxs_ro_…`). Falls back
   * to the `FXSOCKET_API_KEY` environment variable.
   */
  apiKey?: string;
  /** Base URL of the management API. */
  baseUrl?: string;
  /** Request timeout in milliseconds, for REST calls. */
  timeoutMs?: number;
  /**
   * Verify TLS for terminal calls. Private-hosting droplets use a self-signed
   * certificate, so reach them with `false`.
   */
  verifyTerminalTls?: boolean;
  /**
   * An undici `Dispatcher` for management-API calls — a proxy agent, a pool
   * with custom limits, or a mock in tests.
   */
  dispatcher?: Dispatcher;
}

export interface TerminalOptions {
  /** Override the client's `verifyTerminalTls` for this terminal. */
  verify?: boolean;
  /** Override the client's request timeout for this terminal. */
  timeoutMs?: number;
  /** A dispatcher to use instead of the default one. */
  dispatcher?: Dispatcher;
}

export interface StreamFactoryOptions {
  /** Override the client's `verifyTerminalTls` for this stream. */
  verify?: boolean;
  /** Re-establish a dropped connection and replay subscriptions. Default true. */
  autoReconnect?: boolean;
  /** How long to wait for the connection to open, in milliseconds. */
  openTimeoutMs?: number;
  /** Keep-alive ping interval, in milliseconds. 0 disables pings. */
  pingIntervalMs?: number;
  /** How many times to retry a dropped connection before giving up. */
  maxReconnectAttempts?: number;
  /** How many events to buffer for a slow consumer. 0 means unbounded. */
  maxQueueSize?: number;
}

function resolveApiKey(apiKey?: string): string {
  const key = apiKey ?? process.env[ENV_API_KEY];
  if (!key) {
    throw new AuthError(
      `No API key. Pass apiKey: '…' or set the ${ENV_API_KEY} environment variable.`,
    );
  }
  return key;
}

/**
 * The FxSocket client.
 *
 * ```ts
 * import { FxSocket } from '@fxsocket/sdk';
 *
 * const fx = new FxSocket({ apiKey: 'fxs_live_…' });
 * for (const account of await fx.accounts.list()) {
 *   console.log(account.nickname, account.status);
 * }
 * await fx.close();
 * ```
 */
export class FxSocket {
  /** Account management (the v1 API). */
  readonly accounts: Accounts;
  /** Private hosting servers (the v1 API). */
  readonly privateServers: PrivateServers;
  /** Multi-account trading — one order / close fanned out to several accounts. */
  readonly orders: Orders;
  /** Named read-only API keys (the v1 API). */
  readonly readonlyKeys: ReadOnlyKeys;
  /** Prepaid balance, read-only (the v1 API). */
  readonly wallet: WalletResource;

  /**
   * Verify TLS for terminal calls. Private-hosting droplets use a self-signed
   * certificate; set `false` at construction to reach them.
   */
  readonly verifyTerminalTls: boolean;

  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly dispatcher?: Dispatcher;
  private readonly http: HttpTransport;
  private readonly terminals = new Map<string, TerminalClient>();
  private closed = false;

  constructor(options: FxSocketOptions = {}) {
    this.apiKey = resolveApiKey(options.apiKey);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.verifyTerminalTls = options.verifyTerminalTls ?? true;
    this.dispatcher = options.dispatcher;
    this.http = new HttpTransport({
      baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
      apiKey: this.apiKey,
      timeoutMs: this.timeoutMs,
      dispatcher: options.dispatcher,
    });

    this.accounts = new Accounts(this.http);
    this.privateServers = new PrivateServers(this.http);
    this.orders = new Orders(this.http);
    this.readonlyKeys = new ReadOnlyKeys(this.http);
    this.wallet = new WalletResource(this.http);
  }

  /**
   * Return a REST client bound to `account`'s terminal.
   *
   * Resolves the endpoint from `account.restUrl` (shared pod or private
   * droplet). Raises {@link TerminalNotReadyError} when the account has no
   * terminal yet (still provisioning, or bridge-only). Clients are cached per
   * endpoint and closed by {@link FxSocket.close}. Pass `verify: false` for a
   * private droplet's self-signed certificate.
   */
  terminal(account: TerminalAccount, options: TerminalOptions = {}): TerminalClient {
    if (!account.restUrl) {
      throw new TerminalNotReadyError(
        `Account ${account.id} has no terminal endpoint yet ` +
          '(still provisioning, or bridge-only).',
      );
    }
    const key = `${account.restUrl}|${account.platform}`;
    const cached = this.terminals.get(key);
    if (cached !== undefined) return cached;

    const terminal = new TerminalClient({
      baseUrl: account.restUrl,
      apiKey: this.apiKey,
      platform: account.platform,
      verify: options.verify ?? this.verifyTerminalTls,
      timeoutMs: options.timeoutMs ?? this.timeoutMs,
      dispatcher: options.dispatcher ?? this.dispatcher,
    });
    this.terminals.set(key, terminal);
    return terminal;
  }

  /**
   * Create a WebSocket stream for `account`.
   *
   * The stream is returned unconnected — call `connect()`, then subscribe and
   * iterate it. Raises {@link TerminalNotReadyError} if the account has no WS
   * endpoint yet. Streams are not cached or closed by {@link FxSocket.close};
   * close each one you open.
   */
  stream(account: TerminalAccount, options: StreamFactoryOptions = {}): Stream {
    if (!account.wsUrl) {
      throw new TerminalNotReadyError(
        `Account ${account.id} has no WebSocket endpoint yet ` +
          '(still provisioning, or bridge-only).',
      );
    }
    const { verify, ...rest } = options;
    return new Stream({
      wsUrl: account.wsUrl,
      apiKey: this.apiKey,
      platform: account.platform,
      verify: verify ?? this.verifyTerminalTls,
      ...rest,
    });
  }

  /** Close every terminal client this client opened, and its own connections. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const terminals = [...this.terminals.values()];
    this.terminals.clear();
    await Promise.allSettled(terminals.map((terminal) => terminal.close()));
    await this.http.close();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
