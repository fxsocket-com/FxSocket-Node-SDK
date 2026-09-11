/**
 * Thin HTTP transport shared by the management and terminal clients.
 *
 * Built on undici so a caller can supply its own `Dispatcher` (a proxy agent, a
 * mock in tests) and so a private-hosting droplet's self-signed certificate can
 * be reached by turning verification off for that one endpoint.
 *
 * No request is ever retried here. Order send / modify / close must not replay,
 * and a transparent retry elsewhere would make that guarantee accidental.
 */

import { Agent, request, type Dispatcher } from 'undici';

import { ConnectionError, errorFromResponse, TimeoutError } from './errors.js';
import type { ErrorResponse } from './errors.js';
import { VERSION } from './version.js';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** Query-string values; `undefined` and `null` entries are dropped. */
export type QueryParams = Record<string, string | number | boolean | undefined | null>;

export interface RequestOptions {
  params?: QueryParams;
  /** JSON request body. `{}` is sent as an empty object, not omitted. */
  json?: unknown;
  headers?: Record<string, string>;
  /** Overrides the transport's default timeout, in milliseconds. */
  timeoutMs?: number;
}

/** A response that reached the client, before error mapping. */
export interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface HttpTransportOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  /**
   * Verify the server's TLS certificate. Private-hosting droplets present a
   * self-signed certificate, so terminal clients bound to one pass `false`.
   */
  verifyTls?: boolean;
  /** A dispatcher to use instead of the one the transport would build. */
  dispatcher?: Dispatcher;
  /** Extra headers merged into every request. */
  headers?: Record<string, string>;
}

/** Default headers carrying the API key for every request. */
export function authHeaders(apiKey: string): Record<string, string> {
  return {
    'X-API-Key': apiKey,
    'User-Agent': `fxsocket-node/${VERSION}`,
    Accept: 'application/json',
  };
}

function normalizeHeaders(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof raw !== 'object' || raw === null) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === undefined) continue;
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return out;
}

function buildUrl(baseUrl: string, path: string, params?: QueryParams): string {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const suffix = path === '' || path.startsWith('/') ? path : `/${path}`;
  const url = new URL(`${base}${suffix}`);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null) continue;
    url.searchParams.append(key, String(value));
  }
  return url.toString();
}

function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { name?: unknown }).name;
  const code = (error as { code?: unknown }).code;
  return (
    name === 'AbortError' ||
    name === 'TimeoutError' ||
    code === 'UND_ERR_ABORTED' ||
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'UND_ERR_BODY_TIMEOUT' ||
    code === 'UND_ERR_CONNECT_TIMEOUT'
  );
}

/**
 * An HTTP client bound to one base URL, returning decoded JSON and raising the
 * SDK's typed errors.
 */
export class HttpTransport {
  readonly baseUrl: string;
  private readonly baseHeaders: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly dispatcher?: Dispatcher;
  /** True when this transport built its own dispatcher and must close it. */
  private readonly ownsDispatcher: boolean;
  private closed = false;

  constructor(options: HttpTransportOptions) {
    this.baseUrl = options.baseUrl;
    this.timeoutMs = options.timeoutMs;
    this.baseHeaders = { ...authHeaders(options.apiKey), ...options.headers };
    if (options.dispatcher) {
      this.dispatcher = options.dispatcher;
      this.ownsDispatcher = false;
    } else if (options.verifyTls === false) {
      this.dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
      this.ownsDispatcher = true;
    } else {
      this.ownsDispatcher = false;
    }
  }

  /** Perform a request and return the decoded body, or throw a typed error. */
  async request<T = unknown>(
    method: HttpMethod,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const response = await this.raw(method, path, options);
    if (response.status >= 200 && response.status < 300) {
      return response.body as T;
    }
    throw errorFromResponse(response as ErrorResponse);
  }

  /**
   * Perform a request and return the response without mapping failures to
   * errors. Used by `/healthz` and `/livez`, which answer 503 with a body worth
   * reading.
   */
  async raw(
    method: HttpMethod,
    path: string,
    options: RequestOptions = {},
  ): Promise<RawResponse> {
    const url = buildUrl(this.baseUrl, path, options.params);
    const headers: Record<string, string> = { ...this.baseHeaders, ...options.headers };
    let body: string | undefined;
    if (options.json !== undefined) {
      body = JSON.stringify(options.json);
      headers['content-type'] = 'application/json';
    }

    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    let response: Dispatcher.ResponseData;
    try {
      response = await request(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
        ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new TimeoutError(`${method} ${url} timed out after ${timeoutMs}ms`, {
          cause: error,
        });
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new ConnectionError(`${method} ${url} failed: ${detail}`, { cause: error });
    }

    const text = await response.body.text();
    let parsed: unknown = null;
    if (text !== '' && response.statusCode !== 204) {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = text;
      }
    }
    return {
      status: response.statusCode,
      headers: normalizeHeaders(response.headers),
      body: parsed,
    };
  }

  /** Release the dispatcher this transport owns, if any. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.ownsDispatcher && this.dispatcher) {
      await this.dispatcher.close();
    }
  }
}
