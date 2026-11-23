/**
 * cTrader sign-in — `client.ctraderSignIns` (`/v1/ctrader/sign-ins`).
 */

import { setTimeout as sleep } from 'node:timers/promises';

import {
  decodeCtraderLinkResults,
  decodeCtraderSignIn,
  decodeCtraderSignInStarted,
} from '../decode.js';
import { ValidationError } from '../errors.js';
import type { HttpTransport } from '../http.js';
import type {
  CtraderAccountInput,
  CtraderLinkResult,
  CtraderSignIn,
  CtraderSignInStarted,
} from '../types.js';
import { rejectUnknownKeys } from '../validate.js';

/** Anything that names a sign-in: one of the models, or its id. */
export type SignInRef = string | CtraderSignIn | CtraderSignInStarted;

/** Accept a {@link CtraderSignIn}, a {@link CtraderSignInStarted} or a bare id. */
export function signInIdOf(signIn: SignInRef): string {
  return typeof signIn === 'string' ? signIn : signIn.id;
}

export interface CreateSignInParams {
  /**
   * Where the browser goes after cTrader's consent page, with
   * `fxsocket_sign_in=<id>` and `status=<status>` added to the query. Must be
   * https (http only for localhost), without user info or fragment, on an
   * origin FxSocket has allowed for you. Leave it out and the browser shows an
   * FxSocket page that asks the user to return to your app.
   */
  returnUrl?: string;
}

export interface WaitSignInOptions {
  /** How long to wait at most, in milliseconds. Default 660 000 (11 minutes). */
  timeoutMs?: number;
  /** How long to wait between reads, in milliseconds. Default 2 000. */
  intervalMs?: number;
  /** Stops the wait: the promise rejects with the signal's reason. */
  signal?: AbortSignal;
}

/** Most accounts one `linkAccounts()` call takes. */
export const MAX_LINK_ACCOUNTS = 50;

const LINK_ITEM_KEYS: ReadonlySet<string> = new Set(['ctraderAccountId', 'nickname']);

function linkItem(
  account: CtraderAccountInput,
  where: string,
): Record<string, unknown> {
  let id: unknown;
  let nickname: unknown;
  if (typeof account === 'number') {
    id = account;
  } else if (
    typeof account === 'object' &&
    account !== null &&
    !Array.isArray(account)
  ) {
    if ('isAvailable' in account) {
      // A granted row from `signIn.accounts`.
      id = account.ctraderAccountId;
    } else {
      rejectUnknownKeys(account as Record<string, unknown>, LINK_ITEM_KEYS, where);
      id = account.ctraderAccountId;
      nickname = account.nickname;
    }
  } else {
    throw new ValidationError(
      `${where}: expected a ctraderAccountId or an account, got ${typeof account}`,
    );
  }
  if (typeof id !== 'number' || !Number.isInteger(id) || id < 1) {
    throw new ValidationError(
      `${where}: ctraderAccountId must be a whole number >= 1, got ${String(id)}`,
    );
  }
  const item: Record<string, unknown> = { ctrader_account_id: id };
  if (nickname !== undefined) {
    if (typeof nickname !== 'string' || nickname.length > 64) {
      throw new ValidationError(
        `${where}: nickname must be a string of at most 64 characters`,
      );
    }
    item['nickname'] = nickname;
  }
  return item;
}

/**
 * Body of `POST /ctrader/sign-ins/{id}/accounts`, checked the way the API
 * checks it: 1-50 accounts, each once.
 */
export function linkAccountsPayload(
  accounts: Iterable<CtraderAccountInput>,
): Record<string, unknown> {
  if (typeof accounts === 'string' || accounts == null) {
    throw new ValidationError('accounts must be an array');
  }
  const items = [...accounts].map((a, i) => linkItem(a, `accounts[${i}]`));
  if (items.length === 0) {
    throw new ValidationError('accounts must not be empty');
  }
  if (items.length > MAX_LINK_ACCOUNTS) {
    throw new ValidationError(
      `at most ${MAX_LINK_ACCOUNTS} accounts per call, got ${items.length}`,
    );
  }
  const ids = items.map((item) => item['ctrader_account_id']);
  if (new Set(ids).size !== ids.length) {
    throw new ValidationError('each account may be listed once');
  }
  return { accounts: items };
}

function checkWait(timeoutMs: number, intervalMs: number): void {
  if (!(Number.isFinite(timeoutMs) && timeoutMs >= 0)) {
    throw new ValidationError(`timeoutMs must be >= 0, got ${timeoutMs}`);
  }
  if (!(Number.isFinite(intervalMs) && intervalMs > 0)) {
    throw new ValidationError(`intervalMs must be > 0, got ${intervalMs}`);
  }
}

/**
 * Link cTrader accounts through the API (`client.ctraderSignIns`).
 *
 * cTrader accounts have no password: the user signs in at cTrader and allows
 * FxSocket's cTrader application access. The flow:
 *
 * 1. {@link CtraderSignIns.create} a sign-in and send the user's browser to its
 *    `authorizeUrl` (cTrader's consent page, which names "FX Socket").
 * 2. {@link CtraderSignIns.wait} until the user is done (or
 *    {@link CtraderSignIns.get} it when the browser comes back to your
 *    `returnUrl`).
 * 3. {@link CtraderSignIns.linkAccounts} with the granted accounts you want.
 *
 * Every call needs the full key (a read-only key gets {@link ForbiddenError},
 * reads included). Where cTrader is not available to your account they throw
 * {@link NotFoundError} with `code === 'ctrader_unavailable'`. Whoever holds
 * your API key and gets someone to allow access gets trading access to their
 * cTrader accounts, so keep the key on your server.
 */
export class CtraderSignIns {
  constructor(private readonly http: HttpTransport) {}

  /**
   * Start a sign-in (`POST /v1/ctrader/sign-ins`). The user has 10 minutes to
   * finish cTrader's consent page.
   *
   * A `returnUrl` FxSocket does not allow throws {@link ValidationError} with
   * `code === 'return_url_not_allowed'`. At most 20 sign-ins may wait at once
   * and 60 may be started per hour; past that it throws
   * {@link SignInLimitError} with `retryAfter`.
   */
  async create(params: CreateSignInParams = {}): Promise<CtraderSignInStarted> {
    const body = params.returnUrl ? { return_url: params.returnUrl } : {};
    return decodeCtraderSignInStarted(
      await this.http.request('POST', '/ctrader/sign-ins', { json: body }),
    );
  }

  /**
   * How the sign-in went and, once `completed`, the trading accounts the user
   * granted (`GET /v1/ctrader/sign-ins/{id}`). A finished sign-in stays
   * readable for 60 minutes. An unknown id throws {@link NotFoundError}
   * (`code === 'sign_in_not_found'`).
   */
  async get(signIn: SignInRef): Promise<CtraderSignIn> {
    return decodeCtraderSignIn(
      await this.http.request('GET', `/ctrader/sign-ins/${signInIdOf(signIn)}`),
    );
  }

  /**
   * Read the sign-in every `intervalMs` until it is no longer `pending`, for at
   * most `timeoutMs`.
   *
   * Resolves to the last sign-in read: `completed`, `denied`, `failed` or
   * `expired`, or still `pending` when the timeout ran out first, so check
   * `status`. The default timeout outlasts the 10 minutes the user has for the
   * consent page, after which a pending sign-in reads `expired`.
   */
  async wait(
    signIn: SignInRef,
    options: WaitSignInOptions = {},
  ): Promise<CtraderSignIn> {
    const { timeoutMs = 660_000, intervalMs = 2_000, signal } = options;
    checkWait(timeoutMs, intervalMs);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      signal?.throwIfAborted();
      const current = await this.get(signIn);
      if (current.status !== 'pending') return current;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return current;
      await sleep(Math.min(intervalMs, remaining), undefined, { signal });
    }
  }

  /**
   * Link accounts a completed sign-in granted
   * (`POST /v1/ctrader/sign-ins/{id}/accounts`).
   *
   * `accounts` are up to 50 `ctraderAccountId` values, rows of
   * `signIn.accounts` (or `signIn.linkableAccounts`), or objects with
   * `ctraderAccountId` and an optional `nickname`, each once. Resolves to one
   * {@link CtraderLinkResult} per account, in order: the linked account, or why
   * that one was refused (plan, seat and duplicate rules as `accounts.create`).
   * An account already linked through this sign-in comes back as linked, so a
   * call whose answer was lost can be repeated.
   *
   * Refused as a whole, nothing linked: {@link SignInNotCompletedError} (still
   * pending, denied or failed), {@link SignInExpiredError} (60 minutes after
   * the user came back), {@link CtraderAccountNotInSignInError} (an account
   * the sign-in did not grant) and {@link CtraderReauthRequiredError} (cTrader
   * no longer accepts the sign-in).
   */
  async linkAccounts(
    signIn: SignInRef,
    accounts: Iterable<CtraderAccountInput>,
  ): Promise<CtraderLinkResult[]> {
    const body = linkAccountsPayload(accounts);
    return decodeCtraderLinkResults(
      await this.http.request(
        'POST',
        `/ctrader/sign-ins/${signInIdOf(signIn)}/accounts`,
        {
          json: body,
        },
      ),
    );
  }
}
