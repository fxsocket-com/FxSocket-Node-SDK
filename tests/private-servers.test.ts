/** Tests for private-server management (`client.privateServers`). */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DuplicateAccountError,
  FxSocket,
  PrivateAccountStatus,
  PrivateServerStatus,
  SlotsFullError,
  TerminalClient,
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
  it('builds a terminal client with TLS verification off', async () => {
    mock.get('/v1/private-servers', { status: 200, json: [SERVER] });
    const fx = client();
    const [server] = await fx.privateServers.list();
    const terminal = fx.terminal(server!.accounts[0]!, { verify: false });
    expect(terminal).toBeInstanceOf(TerminalClient);
    expect(terminal.baseUrl).toBe(SERVER_ACCOUNT.rest_url);
    await fx.close();
  });
});
