/** Tests for account management (`client.accounts`). */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AccountCapError,
  AuthError,
  ConnectFailedError,
  DuplicateAccountError,
  FxSocket,
  ValidationError,
} from '../src/index.js';
import {
  A1,
  BRIDGE_ACCOUNT,
  POD_ACCOUNT,
  PROXIED_ACCOUNT,
} from './helpers/fixtures.js';
import { HttpMock, ORIGIN } from './helpers/mock-http.js';

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

describe('api key resolution', () => {
  it('raises AuthError when no key is configured', () => {
    const saved = process.env['FXSOCKET_API_KEY'];
    delete process.env['FXSOCKET_API_KEY'];
    try {
      expect(() => new FxSocket()).toThrow(AuthError);
    } finally {
      if (saved !== undefined) process.env['FXSOCKET_API_KEY'] = saved;
    }
  });

  it('reads the key from the environment', async () => {
    const saved = process.env['FXSOCKET_API_KEY'];
    process.env['FXSOCKET_API_KEY'] = 'fxs_live_env';
    const route = mock.get('/v1/accounts', { status: 200, json: [] });
    try {
      const fx = new FxSocket({ dispatcher: mock.dispatcher });
      await fx.accounts.list();
      expect(route.last.headers['x-api-key']).toBe('fxs_live_env');
      await fx.close();
    } finally {
      if (saved === undefined) delete process.env['FXSOCKET_API_KEY'];
      else process.env['FXSOCKET_API_KEY'] = saved;
    }
  });
});

describe('accounts.list', () => {
  it('decodes every account', async () => {
    mock.get('/v1/accounts', { status: 200, json: [POD_ACCOUNT, BRIDGE_ACCOUNT] });
    const fx = client();
    const accounts = await fx.accounts.list();

    expect(accounts.map((a) => a.platform)).toEqual(['mt5', 'mt4']);
    const [pod, bridge] = accounts;
    expect(pod!.status).toBe('connected');
    expect(pod!.hasTerminal).toBe(true);
    expect(pod!.restUrl.endsWith(`/mt5/${A1}`)).toBe(true);
    expect(pod!.createdAt.getUTCFullYear()).toBe(2026);
    expect(bridge!.hasTerminal).toBe(false);
    expect(bridge!.restUrl).toBe('');
    expect(pod!.proxyAddress).toBe('');
    expect(pod!.proxyLocalPort).toBeNull();
    expect(pod!.tradeEaSymbol).toBe('');
    await fx.close();
  });
});

describe('accounts.get', () => {
  it('sends the API key header', async () => {
    const route = mock.get(`/v1/accounts/${A1}`, { status: 200, json: POD_ACCOUNT });
    const fx = client();
    const account = await fx.accounts.get(A1);

    expect(account.login).toBe(1150125);
    expect(route.last.headers['x-api-key']).toBe('fxs_live_test');
    expect(route.last.headers['user-agent']).toMatch(/^fxsocket-node\//);
    await fx.close();
  });

  it('accepts an account object in place of an id', async () => {
    const route = mock.get(`/v1/accounts/${A1}`, { status: 200, json: POD_ACCOUNT });
    const fx = client();
    const account = await fx.accounts.get(A1);
    await fx.accounts.get(account);
    expect(route.callCount).toBe(2);
    await fx.close();
  });
});

describe('accounts.create', () => {
  it('posts the expected payload', async () => {
    const route = mock.post('/v1/accounts', { status: 201, json: POD_ACCOUNT });
    const fx = client();
    const account = await fx.accounts.create({
      server: 'ICMarkets-Demo',
      login: 1150125,
      password: 'pw',
      platform: 'mt5',
    });

    expect(account.id).toBe(A1);
    expect(route.sent).toEqual({
      platform: 'mt5',
      server: 'ICMarkets-Demo',
      login: 1150125,
      password: 'pw',
      nickname: '',
      trade_ea_symbol: '',
    });
    await fx.close();
  });

  it('defaults the platform to mt5', async () => {
    const route = mock.post('/v1/accounts', { status: 201, json: POD_ACCOUNT });
    const fx = client();
    await fx.accounts.create({ server: 'Demo', login: 1, password: 'pw' });
    expect(route.sent['platform']).toBe('mt5');
    await fx.close();
  });

  it('sends proxy fields and the trade-EA symbol', async () => {
    const route = mock.post('/v1/accounts', { status: 201, json: PROXIED_ACCOUNT });
    const fx = client();
    const account = await fx.accounts.create({
      server: 'ICMarkets-Demo',
      login: 1150125,
      password: 'pw',
      tradeEaSymbol: 'EURUSDm',
      proxyAddress: '10.0.0.5:1080',
      proxyType: 'socks5',
      proxyAuth: 'user:secret',
      proxyLocalPort: 1080,
    });

    expect(route.sent).toEqual({
      platform: 'mt5',
      server: 'ICMarkets-Demo',
      login: 1150125,
      password: 'pw',
      nickname: '',
      trade_ea_symbol: 'EURUSDm',
      proxy_address: '10.0.0.5:1080',
      proxy_type: 'socks5',
      proxy_auth: 'user:secret',
      proxy_local_port: 1080,
    });
    expect(account.proxyAddress).toBe('10.0.0.5:1080');
    expect(account.proxyType).toBe('socks5');
    expect(account.proxyLocalPort).toBe(1080);
    expect(account.tradeEaSymbol).toBe('EURUSDm');
    await fx.close();
  });

  it('validates the proxy arguments before sending', async () => {
    const fx = client();
    await expect(
      fx.accounts.create({
        server: 'Demo',
        login: 1,
        password: 'pw',
        proxyType: 'http',
      }),
    ).rejects.toThrow(/proxyAddress is required/);
    await expect(
      fx.accounts.create({
        server: 'Demo',
        login: 1,
        password: 'pw',
        proxyAddress: 'h:1',
        proxyLocalPort: 70000,
      }),
    ).rejects.toThrow(/proxyLocalPort/);
    await fx.close();
  });

  it('maps proxy_unreachable to ConnectFailedError', async () => {
    mock.post('/v1/accounts', {
      status: 400,
      json: { error: 'proxy_unreachable', detail: 'cannot reach proxy' },
    });
    const fx = client();
    await expect(
      fx.accounts.create({
        server: 'Demo',
        login: 1,
        password: 'pw',
        proxyAddress: 'h:1',
      }),
    ).rejects.toMatchObject({
      constructor: ConnectFailedError,
      code: 'proxy_unreachable',
    });
    await fx.close();
  });

  it('maps a duplicate account to a typed error', async () => {
    mock.post('/v1/accounts', {
      status: 409,
      json: { error: 'duplicate', detail: 'already linked' },
    });
    const fx = client();
    await expect(
      fx.accounts.create({ server: 'Demo', login: 1, password: 'pw' }),
    ).rejects.toMatchObject({
      constructor: DuplicateAccountError,
      status: 409,
      code: 'duplicate',
    });
    await fx.close();
  });

  it('carries cap and current on account_cap_reached', async () => {
    mock.post('/v1/accounts', {
      status: 402,
      json: {
        error: 'account_cap_reached',
        detail: 'limit reached',
        cap: 3,
        current: 3,
      },
    });
    const fx = client();
    await expect(
      fx.accounts.create({ server: 'Demo', login: 1, password: 'pw' }),
    ).rejects.toMatchObject({ constructor: AccountCapError, cap: 3, current: 3 });
    await fx.close();
  });
});

describe('accounts.update', () => {
  it('patches the trade-EA symbol, empty string included', async () => {
    const route = mock.patch(`/v1/accounts/${A1}`, {
      status: 200,
      json: { ...POD_ACCOUNT, trade_ea_symbol: 'EURUSDm' },
    });
    const fx = client();
    const account = await fx.accounts.update(A1, { tradeEaSymbol: 'EURUSDm' });
    await fx.accounts.update(account, { tradeEaSymbol: '' });

    expect(route.at(0).json).toEqual({ trade_ea_symbol: 'EURUSDm' });
    expect(route.at(1).json).toEqual({ trade_ea_symbol: '' });
    expect(account.tradeEaSymbol).toBe('EURUSDm');
    await fx.close();
  });

  it('rejects an update with nothing in it', async () => {
    const fx = client();
    await expect(fx.accounts.update(A1, {})).rejects.toThrow(
      new ValidationError('nothing to update — pass tradeEaSymbol'),
    );
    await fx.close();
  });
});

describe('accounts.delete', () => {
  it('resolves to undefined on a 204', async () => {
    const route = mock.delete(`/v1/accounts/${A1}`, { status: 204 });
    const fx = client();
    await expect(fx.accounts.delete(A1)).resolves.toBeUndefined();
    expect(route.called).toBe(true);
    await fx.close();
  });
});

describe('auth failures', () => {
  it('maps a bad key to AuthError', async () => {
    mock.get('/v1/accounts', { status: 401, json: { detail: 'Invalid API key.' } });
    const fx = client();
    await expect(fx.accounts.list()).rejects.toThrow(AuthError);
    await fx.close();
  });
});
