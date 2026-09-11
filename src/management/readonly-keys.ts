/**
 * Named read-only keys — `client.readonlyKeys` (`/v1/readonly-keys`).
 */

import { decodeList, decodeReadOnlyKey } from '../decode.js';
import { KeyScope } from '../enums.js';
import { ValidationError } from '../errors.js';
import type { HttpTransport } from '../http.js';
import type { AccountRef, ReadOnlyKey } from '../types.js';

/** Accept either a {@link ReadOnlyKey} or a bare id string. */
export function readonlyKeyIdOf(key: ReadOnlyKey | string): string {
  return typeof key === 'string' ? key : key.id;
}

export interface CreateReadOnlyKeyParams {
  /** Human label for the key. Required, and must not be blank. */
  name: string;
  /** `all` (the default) or `selected`. Passing `accounts` implies `selected`. */
  scope?: KeyScope;
  /** Accounts the key may see. Implies `scope: 'selected'`. */
  accounts?: readonly AccountRef[];
}

export interface UpdateReadOnlyKeyParams {
  /** New label. Omit to keep the current one. */
  name?: string;
  /** New scope. Widening to `all` drops the account attachments. */
  scope?: KeyScope;
  /** New account set. Implies `scope: 'selected'`. */
  accounts?: readonly AccountRef[];
}

const SCOPES = Object.values(KeyScope);

/**
 * Body for create (`partial: false`) / update (`partial: true`).
 *
 * `scope` is inferred as `selected` when `accounts` are given and no scope was
 * named; on create it otherwise defaults to `all`.
 */
export function readonlyKeyPayload(
  params: UpdateReadOnlyKeyParams,
  partial: boolean,
): Record<string, unknown> {
  const accountIds =
    params.accounts === undefined
      ? undefined
      : params.accounts.map((a) => (typeof a === 'string' ? a : a.id));

  let scope = params.scope;
  if (scope === undefined) {
    if (accountIds !== undefined) scope = KeyScope.SELECTED;
    else if (!partial) scope = KeyScope.ALL;
  } else if (!SCOPES.includes(scope)) {
    throw new ValidationError(
      `scope must be one of ${SCOPES.join(', ')}, got '${String(scope)}'`,
    );
  }
  if (
    scope === KeyScope.SELECTED &&
    (accountIds === undefined || accountIds.length === 0)
  ) {
    throw new ValidationError(
      "scope='selected' needs at least one account (pass accounts: [...])",
    );
  }

  const body: Record<string, unknown> = {};
  if (params.name !== undefined) {
    if (params.name.trim() === '') {
      throw new ValidationError('name must not be blank');
    }
    body['name'] = params.name;
  }
  if (scope !== undefined) body['scope'] = scope;
  if (accountIds !== undefined) body['account_ids'] = accountIds;
  if (!partial && !('name' in body)) {
    throw new ValidationError('name is required');
  }
  return body;
}

/**
 * Management of named read-only keys.
 *
 * Every call needs the full `fxs_live_…` key — a read-only key gets
 * {@link ForbiddenError} even on reads, since replies carry plaintext key
 * values.
 *
 * Terminals are started with the exact set of read-only keys they accept, so
 * creating, re-scoping, rotating or revoking a key **restarts the terminals of
 * every account in its scope** (each goes briefly offline, typically a few
 * minutes). A key scoped to `all` covers every connected account. Renaming is
 * free.
 */
export class ReadOnlyKeys {
  constructor(private readonly http: HttpTransport) {}

  /** List your named read-only keys, plaintext values included. */
  async list(): Promise<ReadOnlyKey[]> {
    return decodeList(
      await this.http.request('GET', '/readonly-keys'),
      decodeReadOnlyKey,
    );
  }

  /** Fetch one read-only key by id. */
  async get(key: ReadOnlyKey | string): Promise<ReadOnlyKey> {
    return decodeReadOnlyKey(
      await this.http.request('GET', `/readonly-keys/${readonlyKeyIdOf(key)}`),
    );
  }

  /**
   * Mint a new `fxs_ro_…` key.
   *
   * `scope` is `'all'` (the default) or `'selected'`; passing `accounts`
   * implies `'selected'` unless you say otherwise. A selected key only sees
   * those accounts — everything else is absent from lists, 404 by id and 401 at
   * the terminal. Restarts the terminals in scope.
   */
  async create(params: CreateReadOnlyKeyParams): Promise<ReadOnlyKey> {
    return decodeReadOnlyKey(
      await this.http.request('POST', '/readonly-keys', {
        json: readonlyKeyPayload(params, false),
      }),
    );
  }

  /**
   * Rename and/or re-scope a key (partial update; an omitted field is kept).
   *
   * Renaming is free; changing the scope restarts the terminals of the accounts
   * that enter or leave it. Widening to `'all'` drops the account attachments;
   * passing `accounts` implies `'selected'`.
   */
  async update(
    key: ReadOnlyKey | string,
    params: UpdateReadOnlyKeyParams,
  ): Promise<ReadOnlyKey> {
    return decodeReadOnlyKey(
      await this.http.request('PATCH', `/readonly-keys/${readonlyKeyIdOf(key)}`, {
        json: readonlyKeyPayload(params, true),
      }),
    );
  }

  /**
   * Issue a new secret for the key, keeping its name and scope.
   *
   * The old value stops authenticating this API immediately; terminals keep
   * honouring it until they restart onto the new list (which this triggers).
   * The returned object carries the new `key`.
   */
  async rotate(key: ReadOnlyKey | string): Promise<ReadOnlyKey> {
    return decodeReadOnlyKey(
      await this.http.request('POST', `/readonly-keys/${readonlyKeyIdOf(key)}/rotate`),
    );
  }

  /**
   * Revoke the key. It stops authenticating immediately and cannot be restored;
   * the terminals in its scope restart.
   */
  async delete(key: ReadOnlyKey | string): Promise<void> {
    await this.http.request('DELETE', `/readonly-keys/${readonlyKeyIdOf(key)}`);
  }
}
