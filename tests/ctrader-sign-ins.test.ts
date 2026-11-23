/** Tests for cTrader API sign-in (`client.ctraderSignIns`). */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CtraderAccountNotInSignInError,
  CtraderReauthRequiredError,
  CtraderSignInStatus,
  ForbiddenError,
  FxSocket,
  NotFoundError,
  RateLimitError,
  SignInExpiredError,
  SignInLimitError,
  SignInNotCompletedError,
  ValidationError,
  type CtraderAccountInput,
} from '../src/index.js';
import { decodeAccount, decodeCtraderSignIn } from '../src/decode.js';
import { HttpMock, ORIGIN } from './helpers/mock-http.js';

const ID = '6f1c2b9e-4d3a-4f6e-9a51-2c7d8e0b1a34';
const PATH = `/v1/ctrader/sign-ins/${ID}`;

const CREATED = {
  id: ID,
  authorize_url: 'https://id.ctrader.com/my/settings/openapi/grantingaccess/?x=1',
  status: 'pending',
  expires_at: '2026-11-22T14:10:00Z',
};

const GRANTED = {
  ctrader_account_id: 49471004,
  login: 5958067,
  broker: 'IC Markets',
  live: false,
  account_type: 'hedged',
  currency: 'EUR',
  active: true,
  unavailable_reason: null,
  linked_account_id: null,
};

const COMPLETED = {
  id: ID,
  status: 'completed',
  error: null,
  created_at: '2026-11-22T14:00:00Z',
  expires_at: '2026-11-22T15:01:12Z',
  accounts: [
    GRANTED,
    {
      ...GRANTED,
      ctrader_account_id: 49471011,
      login: 5958070,
      account_type: 'netted',
      linked_account_id: '0b8f3c52-7a1e-4c9d-8e2f-5d6a7b8c9d0e',
    },
    {
      ...GRANTED,
      ctrader_account_id: 49471012,
      live: true,
      account_type: null,
      currency: null,
      unavailable_reason: 'ctrader_live_not_allowed',
    },
  ],
};

const PENDING = { ...COMPLETED, status: 'pending', accounts: [] };

const LINKED_ACCOUNT = {
  id: '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f',
  nickname: 'Main',
  platform: 'ctrader',
  server: 'IC Markets (demo)',
  login: 5958067,
  status: 'connected',
  error: '',
  suspended: false,
  reauth_required: false,
  rest_url: 'https://api.fxsocket.com/ctrader/3c4d5e6f',
  ws_url: 'wss://api.fxsocket.com/ctrader/3c4d5e6f/ws',
  proxy_address: '',
  proxy_type: '',
  proxy_local_port: null,
  trade_ea_symbol: '',
  created_at: '2026-11-22T14:02:03Z',
};

const LINK_REPLY = {
  accounts: [
    { ctrader_account_id: 49471004, account: LINKED_ACCOUNT },
    {
      ctrader_account_id: 49471011,
      error: 'account_cap_reached',
      detail: 'You have reached your plan limit of 5 accounts.',
      cap: 5,
      current: 5,
    },
  ],
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

describe('ctraderSignIns.create', () => {
  it('starts a sign-in with a return URL', async () => {
    const route = mock.post('/v1/ctrader/sign-ins', { status: 201, json: CREATED });
    const fx = client();
    const started = await fx.ctraderSignIns.create({
      returnUrl: 'https://app.example.com/done',
    });
    expect(started).toEqual({
      id: ID,
      authorizeUrl: CREATED.authorize_url,
      status: CtraderSignInStatus.PENDING,
      expiresAt: new Date('2026-11-22T14:10:00Z'),
    });
    expect(route.sent).toEqual({ return_url: 'https://app.example.com/done' });
    await fx.close();
  });

  it('sends an empty body without a return URL', async () => {
    const route = mock.post('/v1/ctrader/sign-ins', { status: 201, json: CREATED });
    const fx = client();
    await fx.ctraderSignIns.create();
    expect(route.sent).toEqual({});
    await fx.close();
  });

  it.each(['sign_in_pending_limit', 'sign_in_hourly_limit'])(
    'maps a 429 %s to SignInLimitError',
    async (code) => {
      mock.post('/v1/ctrader/sign-ins', {
        status: 429,
        json: { error: code, detail: 'Too many sign-ins.', limit: 20 },
        headers: { 'retry-after': '60' },
      });
      const fx = client();
      const error = await fx.ctraderSignIns.create().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SignInLimitError);
      expect(error).toBeInstanceOf(RateLimitError);
      expect(error).toMatchObject({ code, limit: 20, retryAfter: 60 });
      await fx.close();
    },
  );

  it('maps return_url_not_allowed to ValidationError', async () => {
    mock.post('/v1/ctrader/sign-ins', {
      status: 400,
      json: { error: 'return_url_not_allowed', detail: 'not allowed' },
    });
    const fx = client();
    await expect(
      fx.ctraderSignIns.create({ returnUrl: 'http://evil.example' }),
    ).rejects.toMatchObject({
      constructor: ValidationError,
      code: 'return_url_not_allowed',
    });
    await fx.close();
  });
});

describe('ctraderSignIns.get', () => {
  it('decodes the granted accounts', async () => {
    mock.get(PATH, { status: 200, json: COMPLETED });
    const fx = client();
    const signIn = await fx.ctraderSignIns.get(ID);
    expect(signIn.isCompleted).toBe(true);
    expect(signIn.isPending).toBe(false);
    expect(signIn.error).toBeNull();
    expect(signIn.createdAt).toEqual(new Date('2026-11-22T14:00:00Z'));
    const [first, linked, live] = signIn.accounts;
    expect(first).toMatchObject({
      ctraderAccountId: 49471004,
      login: 5958067,
      broker: 'IC Markets',
      accountType: 'hedged',
      currency: 'EUR',
      isAvailable: true,
      isLinked: false,
    });
    expect(linked!.isLinked).toBe(true);
    expect(live).toMatchObject({
      live: true,
      accountType: null,
      currency: null,
      unavailableReason: 'ctrader_live_not_allowed',
      isAvailable: false,
    });
    expect(signIn.linkableAccounts.map((a) => a.ctraderAccountId)).toEqual([49471004]);
    await fx.close();
  });

  it.each(['sign_in_not_found', 'ctrader_unavailable'])(
    'maps a 404 %s to NotFoundError',
    async (code) => {
      mock.get(PATH, { status: 404, json: { error: code, detail: 'nope' } });
      const fx = client();
      await expect(fx.ctraderSignIns.get(ID)).rejects.toMatchObject({
        constructor: NotFoundError,
        code,
      });
      await fx.close();
    },
  );

  it('maps a read-only key to ForbiddenError', async () => {
    mock.get(PATH, { status: 403, json: { detail: 'read-only key' } });
    const fx = client();
    await expect(fx.ctraderSignIns.get(ID)).rejects.toThrow(ForbiddenError);
    await fx.close();
  });
});

describe('ctraderSignIns.wait', () => {
  it('reads until the sign-in is no longer pending', async () => {
    const route = mock.get(
      PATH,
      { status: 200, json: PENDING },
      { status: 200, json: PENDING },
      { status: 200, json: COMPLETED },
    );
    const fx = client();
    const signIn = await fx.ctraderSignIns.wait(ID, { intervalMs: 1 });
    expect(signIn.isCompleted).toBe(true);
    expect(route.callCount).toBe(3);
    await fx.close();
  });

  it('accepts a started sign-in and returns a denied one', async () => {
    const route = mock.get(PATH, {
      status: 200,
      json: { ...PENDING, status: 'denied', error: 'access_denied' },
    });
    const fx = client();
    const started = {
      ...CREATED,
      authorizeUrl: '',
      expiresAt: new Date(),
      status: 'pending' as const,
    };
    const signIn = await fx.ctraderSignIns.wait(started);
    expect(signIn).toMatchObject({ status: 'denied', error: 'access_denied' });
    expect(route.callCount).toBe(1);
    await fx.close();
  });

  it('returns the pending sign-in when the timeout runs out', async () => {
    const route = mock.get(PATH, { status: 200, json: PENDING });
    const fx = client();
    const signIn = await fx.ctraderSignIns.wait(ID, { timeoutMs: 30, intervalMs: 5 });
    expect(signIn.isPending).toBe(true);
    expect(route.callCount).toBeGreaterThanOrEqual(2);
    await fx.close();
  });

  it('stops on an aborted signal', async () => {
    const route = mock.get(PATH, { status: 200, json: PENDING });
    const fx = client();
    const controller = new AbortController();
    controller.abort(new Error('user closed the tab'));
    await expect(
      fx.ctraderSignIns.wait(ID, { signal: controller.signal }),
    ).rejects.toThrow('user closed the tab');
    expect(route.called).toBe(false);
    await fx.close();
  });

  it.each([{ timeoutMs: -1 }, { intervalMs: 0 }])(
    'checks its options (%o)',
    async (options) => {
      const fx = client();
      await expect(fx.ctraderSignIns.wait(ID, options)).rejects.toThrow(
        ValidationError,
      );
      await fx.close();
    },
  );
});

describe('ctraderSignIns.linkAccounts', () => {
  it('sends ids, rows and nicknames and decodes per-account results', async () => {
    const route = mock.post(`${PATH}/accounts`, { status: 200, json: LINK_REPLY });
    const fx = client();
    const signIn = decodeCtraderSignIn(COMPLETED);
    const results = await fx.ctraderSignIns.linkAccounts(signIn, [
      { ctraderAccountId: 49471004, nickname: 'Main' },
      signIn.accounts[1]!,
      49471012,
    ]);
    expect(route.sent).toEqual({
      accounts: [
        { ctrader_account_id: 49471004, nickname: 'Main' },
        { ctrader_account_id: 49471011 },
        { ctrader_account_id: 49471012 },
      ],
    });
    const [ok, refused] = results;
    expect(ok).toEqual({
      ctraderAccountId: 49471004,
      account: decodeAccount(LINKED_ACCOUNT),
      error: null,
      detail: '',
      isLinked: true,
    });
    expect(ok!.account!.platform).toBe('ctrader');
    expect(ok!.account!.hasTerminal).toBe(true);
    expect(refused).toMatchObject({
      ctraderAccountId: 49471011,
      account: null,
      error: 'account_cap_reached',
      isLinked: false,
    });
    expect(refused!.detail).toContain('plan limit');
    await fx.close();
  });

  it('takes fifty accounts', async () => {
    mock.post(`${PATH}/accounts`, { status: 200, json: { accounts: [] } });
    const fx = client();
    const ids = Array.from({ length: 50 }, (_, i) => i + 1);
    await expect(fx.ctraderSignIns.linkAccounts(ID, ids)).resolves.toEqual([]);
    await fx.close();
  });

  it.each<[string, unknown]>([
    ['empty', []],
    ['a duplicate', [1, 1]],
    ['51 accounts', Array.from({ length: 51 }, (_, i) => i + 1)],
    ['zero', [0]],
    ['a negative id', [-5]],
    ['a string id', ['49471004']],
    ['a fraction', [1.5]],
    ['an unknown key', [{ ctraderAccountId: 1, nick: 'x' }]],
    ['a long nickname', [{ ctraderAccountId: 1, nickname: 'x'.repeat(65) }]],
    ['no id', [{ nickname: 'x' }]],
    ['a string', '49471004'],
  ])('validates before sending: %s', async (_label, accounts) => {
    const route = mock.post(`${PATH}/accounts`, {
      status: 200,
      json: { accounts: [] },
    });
    const fx = client();
    await expect(
      fx.ctraderSignIns.linkAccounts(ID, accounts as Iterable<CtraderAccountInput>),
    ).rejects.toThrow(ValidationError);
    expect(route.called).toBe(false);
    await fx.close();
  });

  it.each<[number, Record<string, unknown>, new (...args: never[]) => Error]>([
    [
      409,
      { error: 'sign_in_not_completed', detail: 'pending', status: 'pending' },
      SignInNotCompletedError,
    ],
    [410, { error: 'sign_in_expired', detail: 'expired' }, SignInExpiredError],
    [
      409,
      { error: 'ctrader_reauth_required', detail: 'sign in again' },
      CtraderReauthRequiredError,
    ],
    [
      400,
      {
        error: 'ctrader_account_not_in_sign_in',
        detail: 'not granted',
        ctrader_account_ids: [7, 8],
      },
      CtraderAccountNotInSignInError,
    ],
  ])('maps a %i %o', async (status, json, errorClass) => {
    mock.post(`${PATH}/accounts`, { status, json });
    const fx = client();
    const error = await fx.ctraderSignIns
      .linkAccounts(ID, [7])
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(errorClass);
    if (error instanceof SignInNotCompletedError) {
      expect(error.signInStatus).toBe('pending');
    }
    if (error instanceof CtraderAccountNotInSignInError) {
      expect(error).toBeInstanceOf(ValidationError);
      expect(error.ctraderAccountIds).toEqual([7, 8]);
    }
    await fx.close();
  });
});

describe('Account cTrader fields', () => {
  it('decodes reauthRequired and suspended, false when absent', () => {
    expect(decodeAccount({ ...LINKED_ACCOUNT, reauth_required: true })).toMatchObject({
      reauthRequired: true,
      suspended: false,
    });
    const { suspended: _s, reauth_required: _r, ...bare } = LINKED_ACCOUNT;
    expect(decodeAccount(bare)).toMatchObject({
      reauthRequired: false,
      suspended: false,
    });
  });
});
