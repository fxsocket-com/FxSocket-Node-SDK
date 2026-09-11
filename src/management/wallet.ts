/**
 * Prepaid balance — `client.wallet` (`/v1/wallet`, read-only).
 */

import { decodeWallet } from '../decode.js';
import type { HttpTransport } from '../http.js';
import type { Wallet } from '../types.js';

/**
 * Read-only view of the prepaid balance.
 *
 * Informational only: topping up (`/wallet/assets`, `/wallet/topup`) happens in
 * the dashboard and is deliberately not exposed here.
 */
export class WalletResource {
  constructor(private readonly http: HttpTransport) {}

  /**
   * Balance, pending top-ups and the charges it must cover over the next 30
   * days — one call. Works with a read-only key.
   */
  async get(): Promise<Wallet> {
    return decodeWallet(await this.http.request('GET', '/wallet'));
  }
}
