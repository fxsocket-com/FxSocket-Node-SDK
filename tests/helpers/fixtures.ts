/** Shared wire-shaped fixtures for the unit tests. */

export const A1 = 'd04096e8-79cd-4078-bc8c-0fd245198938';
export const A2 = '11111111-1111-1111-1111-111111111111';

export const POD_ACCOUNT = {
  id: A1,
  nickname: 'demo',
  platform: 'mt5',
  server: 'ICMarkets-Demo',
  login: 1150125,
  status: 'connected',
  error: '',
  rest_url: `https://api.fxsocket.com/mt5/${A1}`,
  ws_url: `wss://api.fxsocket.com/mt5/${A1}/ws`,
  created_at: '2026-06-22T16:53:56Z',
};

export const PROXIED_ACCOUNT = {
  ...POD_ACCOUNT,
  proxy_address: '10.0.0.5:1080',
  proxy_type: 'socks5',
  proxy_local_port: 1080,
  trade_ea_symbol: 'EURUSDm',
};

export const BRIDGE_ACCOUNT = {
  id: A2,
  nickname: '',
  platform: 'mt4',
  server: 'Demo',
  login: 42,
  status: 'connecting',
  error: '',
  rest_url: '',
  ws_url: '',
  created_at: '2026-06-22T16:53:56Z',
};

export const ORDER_OK = {
  success: true,
  retcode: 10009,
  retcodeDescription: 'Done',
  deal: 0,
  order: 100,
  volume: 0.1,
  price: 1.085,
  bid: 1.0849,
  ask: 1.0851,
  comment: '',
};

export const TICK_FRAME = {
  type: 'tick',
  symbol: 'EURUSD',
  data: {
    symbol: 'EURUSD',
    bid: 1.0849,
    ask: 1.0851,
    time: '2026-06-23T12:00:00Z',
    last: 0.0,
    volume: 0,
  },
};
