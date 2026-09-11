/** Tests for read-only key management (`client.readonlyKeys`). */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  FxSocket,
  ForbiddenError,
  KeyScope,
  NotFoundError,
  ValidationError,
} from '../src/index.js';
import { A1, A2, POD_ACCOUNT } from './helpers/fixtures.js';
import { HttpMock, ORIGIN } from './helpers/mock-http.js';

const KEY_ID = '9c2a1c1e-4d8f-4b7e-9a1f-0c4a7b1e2d33';

const SCOPED_KEY = {
  id: KEY_ID,
  name: 'dashboard',
  key: 'fxs_ro_abc123',
  scope: 'selected',
  accounts: [
    {
      id: A1,
      nickname: 'demo',
      platform: 'mt5',
      server: 'ICMarkets-Demo',
      login: 1150125,
    },
  ],
  created_at: '2026-09-01T10:00:00Z',
  last_used_at: null,
};

const ALL_KEY = {
  id: '22222222-2222-2222-2222-222222222222',
  name: 'monitor',
  key: 'fxs_ro_def456',
  scope: 'all',
  accounts: [],
  created_at: '2026-08-01T10:00:00Z',
  last_used_at: '2026-09-09T08:00:00Z',
};

let mock: HttpMock;

function client(apiKey = 'fxs_live_test'): FxSocket {
  return new FxSocket({ apiKey, dispatcher: mock.dispatcher });
}

beforeEach(() => {
  mock = new HttpMock(ORIGIN);
});

afterEach(async () => {
  await mock.close();
});

describe('readonlyKeys.list', () => {
  it('decodes keys with their scope and accounts', async () => {
    mock.get('/v1/readonly-keys', { status: 200, json: [SCOPED_KEY, ALL_KEY] });
    const fx = client();
    const [scoped, everything] = await fx.readonlyKeys.list();

    expect(scoped!.key).toBe('fxs_ro_abc123');
    expect(scoped!.scope).toBe(KeyScope.SELECTED);
    expect(scoped!.isScoped).toBe(true);
    expect(scoped!.accountIds).toEqual([A1]);
    expect(scoped!.accounts[0]!.platform).toBe('mt5');
    expect(scoped!.lastUsedAt).toBeNull();

    expect(everything!.scope).toBe('all');
    expect(everything!.isScoped).toBe(false);
    expect(everything!.lastUsedAt).not.toBeNull();
    expect(everything!.createdAt.getUTCFullYear()).toBe(2026);
    await fx.close();
  });
});

describe('readonlyKeys.get', () => {
  it('accepts a key object or an id', async () => {
    const route = mock.get(`/v1/readonly-keys/${KEY_ID}`, {
      status: 200,
      json: SCOPED_KEY,
    });
    const fx = client();
    const byId = await fx.readonlyKeys.get(KEY_ID);
    const byModel = await fx.readonlyKeys.get(byId);
    expect(route.callCount).toBe(2);
    expect(byModel.name).toBe('dashboard');
    await fx.close();
  });
});

describe('readonlyKeys.create', () => {
  it('defaults to the all scope', async () => {
    const route = mock.post('/v1/readonly-keys', { status: 201, json: ALL_KEY });
    const fx = client();
    const key = await fx.readonlyKeys.create({ name: 'monitor' });
    expect(route.sent).toEqual({ name: 'monitor', scope: 'all' });
    expect(key.key).toBe('fxs_ro_def456');
    await fx.close();
  });

  it('infers the selected scope from accounts', async () => {
    const route = mock.post('/v1/readonly-keys', { status: 201, json: SCOPED_KEY });
    const fx = client();
    const account = await (async () => {
      mock.get(`/v1/accounts/${A1}`, { status: 200, json: POD_ACCOUNT });
      return fx.accounts.get(A1);
    })();
    await fx.readonlyKeys.create({ name: 'dashboard', accounts: [account, A2] });
    expect(route.sent).toEqual({
      name: 'dashboard',
      scope: 'selected',
      account_ids: [A1, A2],
    });
    await fx.close();
  });

  it('validates before sending', async () => {
    const fx = client();
    await expect(
      fx.readonlyKeys.create({ name: 'x', scope: KeyScope.SELECTED }),
    ).rejects.toThrow(/at least one account/);
    await expect(fx.readonlyKeys.create({ name: '   ' })).rejects.toThrow(/blank/);
    await expect(
      fx.readonlyKeys.create({ name: 'x', scope: 'everything' as KeyScope }),
    ).rejects.toThrow(ValidationError);
    await fx.close();
  });
});

describe('readonlyKeys.update', () => {
  it('sends only the fields given', async () => {
    const route = mock.patch(`/v1/readonly-keys/${KEY_ID}`, {
      status: 200,
      json: SCOPED_KEY,
    });
    const fx = client();

    await fx.readonlyKeys.update(KEY_ID, { name: 'renamed' });
    expect(route.sent).toEqual({ name: 'renamed' });

    await fx.readonlyKeys.update(KEY_ID, { accounts: [A2] });
    expect(route.sent).toEqual({ scope: 'selected', account_ids: [A2] });

    await fx.readonlyKeys.update(KEY_ID, { scope: KeyScope.ALL });
    expect(route.sent).toEqual({ scope: 'all' });
    await fx.close();
  });

  it('rejects an empty selected scope', async () => {
    const fx = client();
    await expect(
      fx.readonlyKeys.update(KEY_ID, { scope: KeyScope.SELECTED, accounts: [] }),
    ).rejects.toThrow(/at least one account/);
    await fx.close();
  });
});

describe('readonlyKeys.rotate / delete', () => {
  it('rotates and revokes', async () => {
    const rotate = mock.post(`/v1/readonly-keys/${KEY_ID}/rotate`, {
      status: 200,
      json: { ...SCOPED_KEY, key: 'fxs_ro_new789' },
    });
    const remove = mock.delete(`/v1/readonly-keys/${KEY_ID}`, { status: 204 });
    const fx = client();

    const key = await fx.readonlyKeys.rotate(KEY_ID);
    await expect(fx.readonlyKeys.delete(key)).resolves.toBeUndefined();
    expect(key.key).toBe('fxs_ro_new789');
    expect(rotate.called).toBe(true);
    expect(remove.called).toBe(true);
    await fx.close();
  });
});

describe('read-only keys and key management', () => {
  it('is forbidden even on reads', async () => {
    mock.get('/v1/readonly-keys', {
      status: 403,
      json: { detail: 'key management requires your full key' },
    });
    mock.get(`/v1/readonly-keys/${KEY_ID}`, {
      status: 404,
      json: { detail: 'Not found.' },
    });
    const fx = client('fxs_ro_test');
    await expect(fx.readonlyKeys.list()).rejects.toThrow(ForbiddenError);
    await expect(fx.readonlyKeys.get(KEY_ID)).rejects.toThrow(NotFoundError);
    await fx.close();
  });
});
