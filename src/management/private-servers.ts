/**
 * Private hosting servers — `client.privateServers` (`/v1/private-servers`).
 *
 * The whole lifecycle: `regions()` to see what can be bought, `create()` to buy
 * one from the prepaid balance, `resize()`, `cancel()` / `resume()`, `delete()`,
 * and `addAccount()` / `removeAccount()` for the accounts on it.
 */

import {
  decodeList,
  decodePrivateServer,
  decodePrivateServerAccount,
  decodePrivateServerOptions,
} from '../decode.js';
import type { Platform } from '../enums.js';
import { ValidationError } from '../errors.js';
import type { HttpTransport } from '../http.js';
import { coercePlatform } from '../validate.js';
import type {
  AccountRef,
  PrivateServer,
  PrivateServerAccount,
  PrivateServerOptions,
} from '../types.js';

/** Accept either a {@link PrivateServer} or a bare id string. */
export function privateServerIdOf(server: PrivateServer | string): string {
  return typeof server === 'string' ? server : server.id;
}

export interface CreatePrivateServerParams {
  /** How many accounts the server should hold. At least 1. */
  slots: number;
  /** Region slug — one of the `code` values from {@link PrivateServers.regions}. */
  region: string;
  /** Free-text label for your own use. */
  name?: string;
}

export interface ResizePrivateServerParams {
  /** The new slot count. At least 1. */
  slots: number;
}

function requireSlots(slots: number): number {
  if (!Number.isInteger(slots) || slots < 1) {
    throw new ValidationError(`slots must be a whole number >= 1, got ${slots}`);
  }
  return slots;
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

/**
 * Dedicated private hosting servers and the accounts living on them.
 *
 * Balance is the only payment method here — card and crypto purchases need a
 * checkout redirect, so those stay in the dashboard.
 */
export class PrivateServers {
  constructor(private readonly http: HttpTransport) {}

  /** List every private server owned by the authenticated user. */
  async list(): Promise<PrivateServer[]> {
    return decodeList(
      await this.http.request('GET', '/private-servers'),
      decodePrivateServer,
    );
  }

  /**
   * Where private servers may run, how big they may be, what it costs.
   *
   * Returns the whole options payload, not just the region list — see
   * {@link PrivateServerOptions}.
   */
  async regions(): Promise<PrivateServerOptions> {
    return decodePrivateServerOptions(
      await this.http.request('GET', '/private-servers/regions'),
    );
  }

  /** Fetch one server by id (use this to poll account readiness). */
  async get(server: PrivateServer | string): Promise<PrivateServer> {
    return decodePrivateServer(
      await this.http.request('GET', `/private-servers/${privateServerIdOf(server)}`),
    );
  }

  /**
   * Buy a dedicated server, charged to the prepaid balance now.
   *
   * `region` must be one of the `code` values from
   * {@link PrivateServers.regions}, `slots` how many accounts it should hold
   * (priced `firstSlot + additionalSlot * (slots - 1)` per month, billed again
   * every month until you {@link PrivateServers.cancel} it) and `name` an
   * optional label for your own reference.
   *
   * Comes back already `provisioning` — poll {@link PrivateServers.get} until
   * `status` is `ready`, usually a couple of minutes. Raises
   * {@link InsufficientBalanceError} when the balance does not cover it,
   * {@link ServerLimitError} when you already own the maximum, and
   * {@link ForbiddenError} when private hosting is off for the deployment or
   * the key is read-only.
   */
  async create(params: CreatePrivateServerParams): Promise<PrivateServer> {
    const body: Record<string, unknown> = {
      slots: requireSlots(params.slots),
      region: params.region,
    };
    if (params.name) body['name'] = params.name;
    return decodePrivateServer(
      await this.http.request('POST', '/private-servers', { json: body }),
    );
  }

  /**
   * Change how many accounts the server may hold.
   *
   * Increases are prorated over what is left of the current period and charged
   * to the balance immediately; the renewal date does not move. Decreases are
   * free and take effect at the next renewal, so capacity already paid for is
   * never destroyed mid-period.
   *
   * Raises {@link AccountsExceedTargetError} when more accounts are on the
   * server than the new limit allows (remove some first),
   * {@link InsufficientBalanceError} when the balance does not cover a prorated
   * increase, and {@link NotBalanceFundedError} for card- or crypto-funded
   * servers.
   */
  async resize(
    server: PrivateServer | string,
    params: ResizePrivateServerParams,
  ): Promise<PrivateServer> {
    return decodePrivateServer(
      await this.http.request(
        'PATCH',
        `/private-servers/${privateServerIdOf(server)}`,
        {
          json: { slots: requireSlots(params.slots) },
        },
      ),
    );
  }

  /**
   * Stop the server renewing, letting the paid period run out.
   *
   * It keeps running until `periodEnd`, then expires; nothing is refunded and
   * nothing is charged again. Prefer this to {@link PrivateServers.delete},
   * which forfeits the rest of the month. Reversible with
   * {@link PrivateServers.resume} while the period lasts. Raises
   * {@link NotBalanceFundedError} for card- or crypto-funded servers.
   */
  async cancel(server: PrivateServer | string): Promise<PrivateServer> {
    return decodePrivateServer(
      await this.http.request(
        'POST',
        `/private-servers/${privateServerIdOf(server)}/cancel`,
      ),
    );
  }

  /**
   * Undo a {@link PrivateServers.cancel}, so the server renews from the balance
   * again at the end of the current period.
   *
   * Only works while it is still running: raises {@link AlreadyLapsedError}
   * once the paid period has lapsed and the machine is gone — buy a new one
   * with {@link PrivateServers.create}.
   */
  async resume(server: PrivateServer | string): Promise<PrivateServer> {
    return decodePrivateServer(
      await this.http.request(
        'DELETE',
        `/private-servers/${privateServerIdOf(server)}/cancel`,
      ),
    );
  }

  /**
   * Destroy the machine and everything on it — irreversible.
   *
   * The droplet is torn down, its IP released and every account hosted on it
   * removed. There is **no refund**: whatever is left of the prepaid month is
   * forfeited. To stop paying without losing the rest of the period, use
   * {@link PrivateServers.cancel} instead.
   */
  async delete(server: PrivateServer | string): Promise<void> {
    await this.http.request('DELETE', `/private-servers/${privateServerIdOf(server)}`);
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
