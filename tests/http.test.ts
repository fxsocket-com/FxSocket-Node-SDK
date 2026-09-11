/**
 * Tests for the HTTP transport: URL building, header handling, body decoding
 * and the failure paths that never reach a response.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AuthError,
  ConnectionError,
  FxSocketError,
  TimeoutError,
  VERSION,
} from '../src/index.js';
import { HttpTransport } from '../src/http.js';
import { HttpMock, ORIGIN } from './helpers/mock-http.js';

interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

interface TestServer {
  origin: string;
  calls: Recorded[];
  close: () => Promise<void>;
}

const servers: Server[] = [];

/**
 * A real HTTP server, for the paths a mock dispatcher cannot exercise: TLS
 * options, sockets that hang, and responses with no body.
 */
async function startServer(
  handler: (
    call: Recorded,
  ) => { status: number; body?: string; headers?: Record<string, string> } | 'hang',
): Promise<TestServer> {
  const calls: Recorded[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const call: Recorded = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      };
      calls.push(call);
      const reply = handler(call);
      if (reply === 'hang') return; // never answers
      res.writeHead(reply.status, reply.headers ?? {});
      res.end(reply.body ?? '');
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        }),
    ),
  );
});

function transport(baseUrl: string, timeoutMs = 5_000): HttpTransport {
  return new HttpTransport({ baseUrl, apiKey: 'fxs_live_k', timeoutMs });
}

describe('request shape', () => {
  it('sends the auth headers on every request', async () => {
    const server = await startServer(() => ({ status: 200, body: '{"ok":true}' }));
    const http = transport(`${server.origin}/v1`);
    await http.request('GET', '/accounts');
    await http.close();

    const [call] = server.calls;
    expect(call!.headers['x-api-key']).toBe('fxs_live_k');
    expect(call!.headers['user-agent']).toBe(`fxsocket-node/${VERSION}`);
    expect(call!.headers['accept']).toBe('application/json');
  });

  it('joins the base URL and path without doubling slashes', async () => {
    const server = await startServer(() => ({ status: 200, body: '[]' }));
    const http = transport(`${server.origin}/v1/`);
    await http.request('GET', '/accounts');
    await http.request('GET', 'wallet');
    await http.close();

    expect(server.calls.map((c) => c.url)).toEqual(['/v1/accounts', '/v1/wallet']);
  });

  it('appends query parameters and drops null or undefined ones', async () => {
    const server = await startServer(() => ({ status: 200, body: '[]' }));
    const http = transport(server.origin);
    await http.request('GET', '/PriceHistory', {
      params: {
        symbol: 'EURUSD',
        timeframe: 'M5',
        from: undefined,
        to: null,
        count: 10,
        flag: false,
      },
    });
    await http.close();

    const url = new URL(server.calls[0]!.url, 'http://x');
    expect(url.searchParams.get('symbol')).toBe('EURUSD');
    expect(url.searchParams.get('count')).toBe('10');
    expect(url.searchParams.get('flag')).toBe('false');
    expect(url.searchParams.has('from')).toBe(false);
    expect(url.searchParams.has('to')).toBe(false);
  });

  it('escapes a symbol that needs encoding', async () => {
    const server = await startServer(() => ({ status: 200, body: '{}' }));
    const http = transport(server.origin);
    await http.request('GET', '/getQuote', { params: { symbol: 'EUR/USD m' } });
    await http.close();

    const url = new URL(server.calls[0]!.url, 'http://x');
    expect(url.searchParams.get('symbol')).toBe('EUR/USD m');
    expect(server.calls[0]!.url).not.toContain(' ');
  });

  it('sends an empty object as a real JSON body', async () => {
    const server = await startServer(() => ({ status: 200, body: '{}' }));
    const http = transport(server.origin);
    await http.request('POST', '/CloseAll', { json: {} });
    await http.close();

    expect(server.calls[0]!.body).toBe('{}');
    expect(server.calls[0]!.headers['content-type']).toBe('application/json');
  });

  it('sends no body and no content-type when there is no payload', async () => {
    const server = await startServer(() => ({ status: 204 }));
    const http = transport(server.origin);
    await http.request('DELETE', '/accounts/abc');
    await http.close();

    expect(server.calls[0]!.body).toBe('');
    expect(server.calls[0]!.headers['content-type']).toBeUndefined();
  });

  it('merges per-request headers over the defaults', async () => {
    const server = await startServer(() => ({ status: 200, body: '{}' }));
    const http = transport(server.origin);
    await http.request('POST', '/orders', {
      json: { orders: [] },
      headers: { 'Idempotency-Key': 'k-1' },
    });
    await http.close();

    expect(server.calls[0]!.headers['idempotency-key']).toBe('k-1');
    expect(server.calls[0]!.headers['x-api-key']).toBe('fxs_live_k');
  });
});

describe('response handling', () => {
  it('returns null for a 204', async () => {
    const server = await startServer(() => ({ status: 204 }));
    const http = transport(server.origin);
    await expect(http.request('DELETE', '/x')).resolves.toBeNull();
    await http.close();
  });

  it('returns null for a 200 with an empty body', async () => {
    const server = await startServer(() => ({ status: 200, body: '' }));
    const http = transport(server.origin);
    await expect(http.request('GET', '/x')).resolves.toBeNull();
    await http.close();
  });

  it('keeps a non-JSON success body as text', async () => {
    const server = await startServer(() => ({ status: 200, body: 'plain text' }));
    const http = transport(server.origin);
    await expect(http.request('GET', '/x')).resolves.toBe('plain text');
    await http.close();
  });

  it('maps a failure status through the error table', async () => {
    const server = await startServer(() => ({
      status: 401,
      body: '{"detail":"Invalid API key."}',
    }));
    const http = transport(server.origin);
    await expect(http.request('GET', '/x')).rejects.toThrow(AuthError);
    await http.close();
  });

  it('surfaces a non-JSON failure body as a bare HTTP error', async () => {
    const server = await startServer(() => ({
      status: 502,
      body: '<html>bad gateway</html>',
    }));
    const http = transport(server.origin);
    await expect(http.request('GET', '/x')).rejects.toMatchObject({
      constructor: FxSocketError,
      status: 502,
      message: 'HTTP 502',
    });
    await http.close();
  });

  it('exposes the response on the error, with lower-cased headers', async () => {
    const server = await startServer(() => ({
      status: 429,
      body: '{"detail":"slow down"}',
      headers: { 'Retry-After': '7' },
    }));
    const http = transport(server.origin);
    try {
      await http.request('GET', '/x');
      expect.unreachable('should have thrown');
    } catch (error) {
      const err = error as FxSocketError;
      expect(err.response?.status).toBe(429);
      expect(err.response?.headers['retry-after']).toBe('7');
      expect(err.response?.body).toEqual({ detail: 'slow down' });
    }
    await http.close();
  });

  it('returns a failure response unmapped from raw()', async () => {
    const server = await startServer(() => ({
      status: 503,
      body: '{"status":"starting"}',
    }));
    const http = transport(server.origin);
    const response = await http.raw('GET', '/healthz');
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: 'starting' });
    await http.close();
  });
});

describe('transport failures', () => {
  it('raises TimeoutError when the server never answers', async () => {
    const server = await startServer(() => 'hang');
    const http = transport(server.origin, 300);
    await expect(http.request('GET', '/slow')).rejects.toThrow(TimeoutError);
    await http.close();
  });

  it('honours a per-request timeout override', async () => {
    const server = await startServer(() => 'hang');
    const http = transport(server.origin, 60_000);
    await expect(
      http.request('GET', '/slow', { timeoutMs: 250 }),
    ).rejects.toMatchObject({ constructor: TimeoutError });
    await http.close();
  });

  it('raises ConnectionError when the host refuses the connection', async () => {
    const http = transport('http://127.0.0.1:1');
    const error = await http.request('GET', '/x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectionError);
    expect(error).not.toBeInstanceOf(TimeoutError);
    await http.close();
  });

  it('reports a TimeoutError as a ConnectionError subclass', async () => {
    const server = await startServer(() => 'hang');
    const http = transport(server.origin, 200);
    const error = await http.request('GET', '/slow').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error).toBeInstanceOf(ConnectionError);
    await http.close();
  });
});

describe('lifecycle', () => {
  it('closes a dispatcher it built itself, and does so once', async () => {
    // verifyTls:false makes the transport build its own Agent, which it owns.
    const http = new HttpTransport({
      baseUrl: 'https://example.invalid',
      apiKey: 'k',
      timeoutMs: 1_000,
      verifyTls: false,
    });
    await expect(http.close()).resolves.toBeUndefined();
    await expect(http.close()).resolves.toBeUndefined();
  });

  it('does not close a dispatcher it was handed', async () => {
    const mock = new HttpMock(ORIGIN);
    mock.get('/v1/accounts', { status: 200, json: [] });
    const http = new HttpTransport({
      baseUrl: `${ORIGIN}/v1`,
      apiKey: 'k',
      timeoutMs: 1_000,
      dispatcher: mock.dispatcher,
    });
    await http.request('GET', '/accounts');
    await http.close();
    // The caller's dispatcher is still usable after the transport closed.
    await expect(http.request('GET', '/accounts')).resolves.toEqual([]);
    await mock.close();
  });
});
