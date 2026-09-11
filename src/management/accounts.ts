/**
 * Account management — `client.accounts` (`/v1/accounts`).
 */

import { decodeAccount, decodeList } from '../decode.js';
import type { Platform } from '../enums.js';
import { ValidationError } from '../errors.js';
import type { HttpTransport } from '../http.js';
import type { Account, AccountRef } from '../types.js';

/** Accept either an account object or a bare id string. */
export function accountIdOf(account: AccountRef): string {
  return typeof account === 'string' ? account : account.id;
}

export interface CreateAccountParams {
  /** Broker server name, exactly as MetaTrader spells it. */
  server: string;
  /** Account number. */
  login: number;
  /** Account password (write-only — never returned). */
  password: string;
  /** Trading platform. Defaults to `mt5`. */
  platform?: Platform;
  /** Free-text label for your own use. */
  nickname?: string;
  /**
   * Chart symbol the terminal hosts its trade expert on, exactly as the broker
   * names it (e.g. `EURUSDm` on a suffixed broker). Leave empty to let the
   * terminal pick one.
   */
  tradeEaSymbol?: string;
  /** Outbound proxy address, `host:port`. Required to use any proxy field. */
  proxyAddress?: string;
  /** Proxy type as the terminal names it, e.g. `socks5` / `http`. */
  proxyType?: string;
  /** Proxy credentials, `user:password`. Write-only. */
  proxyAuth?: string;
  /** Local port the terminal binds for the proxy. 1–65535. */
  proxyLocalPort?: number;
}

export interface UpdateAccountParams {
  /** New trade-EA host symbol. `''` reverts to automatic selection. */
  tradeEaSymbol?: string;
}

function createPayload(params: CreateAccountParams): Record<string, unknown> {
  const {
    server,
    login,
    password,
    platform = 'mt5',
    nickname = '',
    tradeEaSymbol = '',
    proxyAddress = '',
    proxyType = '',
    proxyAuth = '',
    proxyLocalPort,
  } = params;

  const body: Record<string, unknown> = {
    platform,
    server,
    login,
    password,
    nickname,
    trade_ea_symbol: tradeEaSymbol,
  };

  if (proxyAddress || proxyType || proxyAuth || proxyLocalPort !== undefined) {
    if (!proxyAddress) {
      throw new ValidationError('proxyAddress is required when using a proxy');
    }
    if (
      proxyLocalPort !== undefined &&
      !(
        Number.isInteger(proxyLocalPort) &&
        proxyLocalPort >= 1 &&
        proxyLocalPort <= 65535
      )
    ) {
      throw new ValidationError(
        `proxyLocalPort must be 1–65535, got ${proxyLocalPort}`,
      );
    }
    body['proxy_address'] = proxyAddress;
    body['proxy_type'] = proxyType;
    body['proxy_auth'] = proxyAuth;
    if (proxyLocalPort !== undefined) body['proxy_local_port'] = proxyLocalPort;
  }
  return body;
}

function updatePayload(params: UpdateAccountParams): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (params.tradeEaSymbol !== undefined) {
    body['trade_ea_symbol'] = params.tradeEaSymbol;
  }
  if (Object.keys(body).length === 0) {
    throw new ValidationError('nothing to update — pass tradeEaSymbol');
  }
  return body;
}

/** Linked MT4/MT5 accounts. */
export class Accounts {
  constructor(private readonly http: HttpTransport) {}

  /** List every account owned by the authenticated user. */
  async list(): Promise<Account[]> {
    return decodeList(await this.http.request('GET', '/accounts'), decodeAccount);
  }

  /** Fetch one account by id (use this to poll connection status). */
  async get(account: AccountRef): Promise<Account> {
    return decodeAccount(
      await this.http.request('GET', `/accounts/${accountIdOf(account)}`),
    );
  }

  /**
   * Link (connect) a new MT4/MT5 account. Returns it in `connecting` state —
   * poll {@link Accounts.get} until it reaches `connected`.
   *
   * The optional `proxy*` arguments route this account's terminal through an
   * outbound proxy. The proxy is verified before the account is created — an
   * unreachable one raises {@link ConnectFailedError} with
   * `code === 'proxy_unreachable'`.
   */
  async create(params: CreateAccountParams): Promise<Account> {
    return decodeAccount(
      await this.http.request('POST', '/accounts', { json: createPayload(params) }),
    );
  }

  /**
   * Change the trade-EA host symbol (`PATCH /accounts/{id}`).
   *
   * The terminal restarts on the new symbol right away — poll
   * {@link Accounts.get} until `status` returns to `connected`. Pass an empty
   * string to revert to automatic selection. Nothing else is mutable: different
   * credentials or server mean a different broker account (unlink and relink
   * instead).
   */
  async update(account: AccountRef, params: UpdateAccountParams): Promise<Account> {
    return decodeAccount(
      await this.http.request('PATCH', `/accounts/${accountIdOf(account)}`, {
        json: updatePayload(params),
      }),
    );
  }

  /** Unlink (disconnect) an account and tear down its terminal. */
  async delete(account: AccountRef): Promise<void> {
    await this.http.request('DELETE', `/accounts/${accountIdOf(account)}`);
  }
}
