/** Tests for private-server management (`client.privateServers`). */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AccountsExceedTargetError,
  AlreadyLapsedError,
  DuplicateAccountError,
  ForbiddenError,
  FxSocket,
  InsufficientBalanceError,
  NotBalanceFundedError,
  PrivateAccountStatus,
  PrivateServerStatus,
  ServerLimitError,
  SlotsFullError,
  TerminalClient,
  ValidationError,
} from '../src/index.js';
import { HttpMock, ORIGIN } from './helpers/mock-http.js';

const SERVER_ID = 'ecf2fa95-4177-4402-8a00-dea33ae0e79a';
const SERVER_ACCOUNT_ID = '22222222-2222-2222-2222-222222222222';

const SERVER_ACCOUNT = {
  id: SERVER_ACCOUNT_ID,
  nickname: 'prop-1',
  platform: 'mt5',
  server: 'ICMarkets-Demo',
  login: 7001,
  status: 'ready',
  rest_url: `https://159.223.244.125/${SERVER_ACCOUNT_ID}`,
  ws_url: `wss://159.223.244.125/${SERVER_ACCOUNT_ID}/ws`,
  trade_ea_symbol: '',
  created_at: '2026-07-16T08:00:00Z',
};

const SERVER = {
  id: SERVER_ID,
  name: 'My Prop Guard',
  status: 'ready',
  region: 'lon1',
  ip: '159.223.244.125',
  purchased_slots: 2,
  used_slots: 1,
  cancel_at_period_end: false,
  period_end: '2026-08-16T07:01:08Z',
  accounts: [SERVER_ACCOUNT],
};

const REGIONS = {
  enabled: true,
  regions: [
    { code: 'fra1', label: 'Frankfurt, Germany' },
    { code: 'lon1', label: 'London, United Kingdom' },
  ],
  max_slots: 10,
  max_servers: 3,
  first_slot_eur_cents: 1700,
  additional_slot_eur_cents: 1400,
};

let mock: HttpMock;

function client(): FxSocket {
  return new FxSocket({ apiKey: 'fxs_live_test', dispatcher: mock.dispatcher });
}

beforeEach(() => {
  mock = new HttpMock(ORIGIN);
});

afterEach(async () => {
  await mock.close();
});

describe('privateServers.list', () => {
  it('decodes servers and their accounts', async () => {
    mock.get('/v1/private-servers', { status: 200, json: [SERVER] });
    const fx = client();
    const [server] = await fx.privateServers.list();

    expect(server!.name).toBe('My Prop Guard');
    expect(server!.status).toBe(PrivateServerStatus.READY);
    expect(server!.isReady).toBe(true);
    expect(server!.ip).toBe('159.223.244.125');
    expect(server!.freeSlots).toBe(1);
    expect(server!.cancelAtPeriodEnd).toBe(false);
    expect(server!.periodEnd?.getUTCFullYear()).toBe(2026);

    const [account] = server!.accounts;
    expect(account!.status).toBe(PrivateAccountStatus.READY);
    expect(account!.hasTerminal).toBe(true);
    await fx.close();
  });

  it('never reports negative free slots', async () => {
    mock.get('/v1/private-servers', {
      status: 200,
      json: [{ ...SERVER, purchased_slots: 1, used_slots: 3 }],
    });
    const fx = client();
    const [server] = await fx.privateServers.list();
    expect(server!.freeSlots).toBe(0);
    await fx.close();
  });
});

describe('privateServers.get', () => {
  it('accepts a server object or an id', async () => {
    const route = mock.get(`/v1/private-servers/${SERVER_ID}`, {
      status: 200,
      json: SERVER,
    });
    const fx = client();
    const byId = await fx.privateServers.get(SERVER_ID);
    const byModel = await fx.privateServers.get(byId);
    expect(route.callCount).toBe(2);
    expect(byModel.id).toBe(SERVER_ID);
    await fx.close();
  });
});

describe('privateServers.regions', () => {
  it('decodes the options payload and prices a server', async () => {
    mock.get('/v1/private-servers/regions', { status: 200, json: REGIONS });
    const fx = client();
    const options = await fx.privateServers.regions();

    expect(options.enabled).toBe(true);
    expect(options.regionCodes).toEqual(['fra1', 'lon1']);
    expect(options.regions[0]!.label).toBe('Frankfurt, Germany');
    expect(options.maxSlots).toBe(10);
    expect(options.maxServers).toBe(3);
    expect(options.monthlyPriceEurCents(1)).toBe(1700);
    expect(options.monthlyPriceEurCents(3)).toBe(4500);
    expect(options.monthlyPriceEur(3)).toBe(45);
    expect(() => options.monthlyPriceEurCents(0)).toThrow(ValidationError);

    // Pricing must survive being pulled off the object.
    const { monthlyPriceEur } = options;
    expect(monthlyPriceEur(2)).toBe(31);
    await fx.close();
  });

  it('reports a deployment with private hosting switched off', async () => {
    mock.get('/v1/private-servers/regions', {
      status: 200,
      json: {
        enabled: false,
        regions: [],
        max_slots: 0,
        max_servers: 0,
        first_slot_eur_cents: 0,
        additional_slot_eur_cents: 0,
      },
    });
    const fx = client();
    const options = await fx.privateServers.regions();
    expect(options.enabled).toBe(false);
    expect(options.regionCodes).toEqual([]);
    await fx.close();
  });
});

describe('privateServers.create', () => {
  it('posts slots, region and name', async () => {
    const route = mock.post('/v1/private-servers', {
      status: 201,
      json: { ...SERVER, status: 'provisioning', accounts: [] },
    });
    const fx = client();
    const server = await fx.privateServers.create({
      slots: 2,
      region: 'lon1',
      name: 'My Prop Guard',
    });

    expect(route.sent).toEqual({ slots: 2, region: 'lon1', name: 'My Prop Guard' });
    expect(server.status).toBe(PrivateServerStatus.PROVISIONING);
    expect(server.isReady).toBe(false);
    await fx.close();
  });

  it('omits a blank name', async () => {
    const route = mock.post('/v1/private-servers', { status: 201, json: SERVER });
    const fx = client();
    await fx.privateServers.create({ slots: 1, region: 'fra1' });
    expect(route.sent).toEqual({ slots: 1, region: 'fra1' });
    await fx.close();
  });

  it('rejects a nonsensical slot count before sending anything', async () => {
    const route = mock.post('/v1/private-servers', { status: 201, json: SERVER });
    const fx = client();
    await expect(
      fx.privateServers.create({ slots: 0, region: 'fra1' }),
    ).rejects.toThrow(ValidationError);
    await expect(
      fx.privateServers.create({ slots: 1.5, region: 'fra1' }),
    ).rejects.toThrow(ValidationError);
    expect(route.called).toBe(false);
    await fx.close();
  });

  it('maps an unaffordable purchase to InsufficientBalanceError', async () => {
    mock.post('/v1/private-servers', {
      status: 402,
      json: {
        error: 'insufficient_balance',
        detail: 'Balance does not cover it.',
        shortfall_eur_cents: 1200,
      },
    });
    const fx = client();
    const error = await fx.privateServers
      .create({ slots: 2, region: 'lon1' })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(InsufficientBalanceError);
    expect((error as InsufficientBalanceError).shortfallEur).toBe(12);
    await fx.close();
  });

  it('maps server_limit_reached to its own error, not a duplicate', async () => {
    mock.post('/v1/private-servers', {
      status: 409,
      json: { error: 'server_limit_reached', detail: 'You own 3 of 3.' },
    });
    const fx = client();
    const error = await fx.privateServers
      .create({ slots: 1, region: 'lon1' })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ServerLimitError);
    expect(error).not.toBeInstanceOf(DuplicateAccountError);
    expect((error as ServerLimitError).code).toBe('server_limit_reached');
    await fx.close();
  });
});

describe('privateServers.resize', () => {
  it('patches the new slot count', async () => {
    const route = mock.patch(`/v1/private-servers/${SERVER_ID}`, {
      status: 200,
      json: { ...SERVER, purchased_slots: 4 },
    });
    const fx = client();
    const server = await fx.privateServers.resize(SERVER_ID, { slots: 4 });

    expect(route.sent).toEqual({ slots: 4 });
    expect(server.purchasedSlots).toBe(4);
    expect(server.freeSlots).toBe(3);
    await fx.close();
  });

  it('maps shrinking below the hosted accounts to a typed error', async () => {
    mock.patch(`/v1/private-servers/${SERVER_ID}`, {
      status: 409,
      json: { error: 'accounts_exceed_target', detail: '2 accounts, 1 slot.' },
    });
    const fx = client();
    await expect(fx.privateServers.resize(SERVER_ID, { slots: 1 })).rejects.toThrow(
      AccountsExceedTargetError,
    );
    await fx.close();
  });

  it('maps a card-funded server to NotBalanceFundedError, a ForbiddenError', async () => {
    mock.patch(`/v1/private-servers/${SERVER_ID}`, {
      status: 403,
      json: { error: 'not_balance_funded', detail: 'Card-funded server.' },
    });
    const fx = client();
    const error = await fx.privateServers
      .resize(SERVER_ID, { slots: 4 })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(NotBalanceFundedError);
    expect(error).toBeInstanceOf(ForbiddenError);
    await fx.close();
  });
});

describe('privateServers.cancel / resume / delete', () => {
  it('cancels and resumes over the same /cancel path', async () => {
    const cancelRoute = mock.post(`/v1/private-servers/${SERVER_ID}/cancel`, {
      status: 200,
      json: { ...SERVER, cancel_at_period_end: true },
    });
    const resumeRoute = mock.delete(`/v1/private-servers/${SERVER_ID}/cancel`, {
      status: 200,
      json: SERVER,
    });
    const fx = client();
    const stopped = await fx.privateServers.cancel(SERVER_ID);
    const resumed = await fx.privateServers.resume(stopped);

    expect(cancelRoute.called).toBe(true);
    expect(resumeRoute.called).toBe(true);
    expect(stopped.cancelAtPeriodEnd).toBe(true);
    expect(resumed.cancelAtPeriodEnd).toBe(false);
    await fx.close();
  });

  it('maps a resume after the period lapsed', async () => {
    mock.delete(`/v1/private-servers/${SERVER_ID}/cancel`, {
      status: 409,
      json: { error: 'already_lapsed', detail: 'Period has lapsed.' },
    });
    const fx = client();
    await expect(fx.privateServers.resume(SERVER_ID)).rejects.toThrow(
      AlreadyLapsedError,
    );
    await fx.close();
  });

  it('destroys the server', async () => {
    const route = mock.delete(`/v1/private-servers/${SERVER_ID}`, { status: 204 });
    const fx = client();
    await fx.privateServers.delete(SERVER_ID);
    expect(route.called).toBe(true);
    await fx.close();
  });
});

describe('privateServers.addAccount', () => {
  it('posts the expected payload', async () => {
    const route = mock.post(`/v1/private-servers/${SERVER_ID}/accounts`, {
      status: 201,
      json: SERVER_ACCOUNT,
    });
    const fx = client();
    const account = await fx.privateServers.addAccount(SERVER_ID, {
      server: 'ICMarkets-Demo',
      login: 7001,
      password: 'pw',
      nickname: 'prop-1',
    });

    expect(route.sent).toEqual({
      platform: 'mt5',
      server: 'ICMarkets-Demo',
      login: 7001,
      password: 'pw',
      nickname: 'prop-1',
      trade_ea_symbol: '',
    });
    expect(account.login).toBe(7001);
    await fx.close();
  });

  it('maps slots_full to a typed error carrying used/cap', async () => {
    mock.post(`/v1/private-servers/${SERVER_ID}/accounts`, {
      status: 409,
      json: {
        error: 'slots_full',
        detail: 'Server is full (2/2).',
        used: 2,
        cap: 2,
      },
    });
    const fx = client();
    await expect(
      fx.privateServers.addAccount(SERVER_ID, {
        server: 'Demo',
        login: 1,
        password: 'pw',
      }),
    ).rejects.toMatchObject({ constructor: SlotsFullError, used: 2, cap: 2 });
    await fx.close();
  });

  it('still maps a duplicate to DuplicateAccountError', async () => {
    mock.post(`/v1/private-servers/${SERVER_ID}/accounts`, {
      status: 409,
      json: { error: 'duplicate', detail: 'Already linked.' },
    });
    const fx = client();
    await expect(
      fx.privateServers.addAccount(SERVER_ID, {
        server: 'Demo',
        login: 1,
        password: 'pw',
      }),
    ).rejects.toThrow(DuplicateAccountError);
    await fx.close();
  });
});

describe('privateServers.removeAccount', () => {
  it('deletes the account from the server', async () => {
    const route = mock.delete(
      `/v1/private-servers/${SERVER_ID}/accounts/${SERVER_ACCOUNT_ID}`,
      { status: 204 },
    );
    const fx = client();
    await fx.privateServers.removeAccount(SERVER_ID, SERVER_ACCOUNT_ID);
    expect(route.called).toBe(true);
    await fx.close();
  });
});

describe('terminal from a private-server account', () => {
  it('builds a terminal client bound to the droplet endpoint', async () => {
    mock.get('/v1/private-servers', { status: 200, json: [SERVER] });
    const fx = client();
    const [server] = await fx.privateServers.list();
    const terminal = fx.terminal(server!.accounts[0]!);
    expect(terminal).toBeInstanceOf(TerminalClient);
    expect(terminal.baseUrl).toBe(SERVER_ACCOUNT.rest_url);
    await fx.close();
  });

  it('skips TLS verification for a self-signed droplet certificate', async () => {
    // No dispatcher here: the client builds its own agent with verification
    // off, which is the whole point of verifyTerminalTls.
    const fx = new FxSocket({ apiKey: 'fxs_live_test', verifyTerminalTls: false });
    const terminal = fx.terminal({
      ...SERVER_ACCOUNT,
      platform: 'mt5' as const,
      restUrl: SERVER_ACCOUNT.rest_url,
      wsUrl: SERVER_ACCOUNT.ws_url,
      tradeEaSymbol: '',
      createdAt: new Date(),
      hasTerminal: true,
      status: 'ready' as const,
    });
    expect(terminal).toBeInstanceOf(TerminalClient);
    await fx.close();
  });

  it('refuses to silently ignore verify:false when a dispatcher is supplied', () => {
    // TLS belongs to whoever built the dispatcher, so the contradiction has to
    // surface rather than leave the droplet failing on its certificate.
    const fx = client();
    expect(() =>
      fx.terminal(
        {
          ...SERVER_ACCOUNT,
          platform: 'mt5' as const,
          restUrl: SERVER_ACCOUNT.rest_url,
          wsUrl: SERVER_ACCOUNT.ws_url,
          tradeEaSymbol: '',
          createdAt: new Date(),
          hasTerminal: true,
          status: 'ready' as const,
        },
        { verify: false },
      ),
    ).toThrow(/cannot be combined with a custom dispatcher/);
    void fx.close();
  });
});
