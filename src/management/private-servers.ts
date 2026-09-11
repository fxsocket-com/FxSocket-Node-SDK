/**
 * Private hosting servers — `client.privateServers` (`/v1/private-servers`).
 *
 * Read + on-server account management only: purchasing a server, canceling, and
 * slot changes happen in the dashboard.
 */

import {
  decodeList,
  decodePrivateServer,
  decodePrivateServerAccount,
} from '../decode.js';
import type { Platform } from '../enums.js';
import type { HttpTransport } from '../http.js';
import { coercePlatform } from '../validate.js';
import type { AccountRef, PrivateServer, PrivateServerAccount } from '../types.js';

/** Accept either a {@link PrivateServer} or a bare id string. */
export function privateServerIdOf(server: PrivateServer | string): string {
  return typeof server === 'string' ? server : server.id;
}

export interface AddPrivateAccountParams {
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
  /** Chart symbol the terminal hosts its trade expert on. */
  tradeEaSymbol?: string;
}

/** Dedicated private hosting servers and the accounts living on them. */
export class PrivateServers {
  constructor(private readonly http: HttpTransport) {}

  /** List every private server owned by the authenticated user. */
  async list(): Promise<PrivateServer[]> {
    return decodeList(
      await this.http.request('GET', '/private-servers'),
      decodePrivateServer,
    );
  }

  /** Fetch one server by id (use this to poll account readiness). */
  async get(server: PrivateServer | string): Promise<PrivateServer> {
    return decodePrivateServer(
      await this.http.request('GET', `/private-servers/${privateServerIdOf(server)}`),
    );
  }

  /**
   * Connect an MT4/MT5 account onto the server.
   *
   * The on-server agent brings the terminal up asynchronously — poll
   * {@link PrivateServers.get} until the account's `status` reaches `ready`.
   * Raises {@link SlotsFullError} when every purchased slot is taken and
   * {@link DuplicateAccountError} when the account is already linked.
   */
  async addAccount(
    privateServer: PrivateServer | string,
    params: AddPrivateAccountParams,
  ): Promise<PrivateServerAccount> {
    const body = {
      platform: coercePlatform(params.platform ?? 'mt5'),
      server: params.server,
      login: params.login,
      password: params.password,
      nickname: params.nickname ?? '',
      trade_ea_symbol: params.tradeEaSymbol ?? '',
    };
    return decodePrivateServerAccount(
      await this.http.request(
        'POST',
        `/private-servers/${privateServerIdOf(privateServer)}/accounts`,
        { json: body },
      ),
    );
  }

  /** Detach an account from the server, freeing its slot. */
  async removeAccount(
    privateServer: PrivateServer | string,
    account: AccountRef,
  ): Promise<void> {
    const serverId = privateServerIdOf(privateServer);
    const accountId = typeof account === 'string' ? account : account.id;
    await this.http.request(
      'DELETE',
      `/private-servers/${serverId}/accounts/${accountId}`,
    );
  }
}
