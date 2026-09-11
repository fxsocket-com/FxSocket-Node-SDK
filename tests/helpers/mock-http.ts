/**
 * HTTP mocking helpers built on undici's MockAgent.
 *
 * Each helper returns a recorder so a test can assert on what was sent — the
 * Node equivalent of respx's `route.calls.last.request`.
 */

import { MockAgent, type Dispatcher, type Interceptable } from 'undici';

export const BASE = 'https://api.fxsocket.com/v1';
export const ORIGIN = 'https://api.fxsocket.com';
export const TERM = 'https://term.test';

export interface RecordedCall {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
  /** The request body parsed as JSON, or `undefined` when there was none. */
  json: Record<string, unknown> | undefined;
  /** Query parameters parsed from the path. */
  query: URLSearchParams;
}

export class Recorder {
  readonly calls: RecordedCall[] = [];

  get called(): boolean {
    return this.calls.length > 0;
  }

  get callCount(): number {
    return this.calls.length;
  }

  get last(): RecordedCall {
    const call = this.calls.at(-1);
    if (call === undefined) throw new Error('no calls recorded');
    return call;
  }

  /** The JSON body of the most recent call. */
  get sent(): Record<string, unknown> {
    const { json } = this.last;
    if (json === undefined) throw new Error('last call had no JSON body');
    return json;
  }

  at(index: number): RecordedCall {
    const call = this.calls[index];
    if (call === undefined) throw new Error(`no call at index ${index}`);
    return call;
  }
}

function normalizeHeaders(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(raw)) {
    for (let i = 0; i < raw.length; i += 2) {
      out[String(raw[i]).toLowerCase()] = String(raw[i + 1]);
    }
    return out;
  }
  if (typeof raw === 'object' && raw !== null) {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (value !== undefined) out[key.toLowerCase()] = String(value);
    }
  }
  return out;
}

export interface MockReply {
  status: number;
  /** JSON body. Omit for an empty body (e.g. a 204). */
  json?: unknown;
  headers?: Record<string, string>;
}

/**
 * A mock HTTP server for one origin.
 *
 * ```ts
 * const mock = new HttpMock(ORIGIN);
 * const route = mock.get('/v1/accounts', { status: 200, json: [] });
 * const fx = new FxSocket({ apiKey: 'k', dispatcher: mock.dispatcher });
 * ```
 */
export class HttpMock {
  readonly agent: MockAgent;
  private readonly pool: Interceptable;

  constructor(origin: string) {
    this.agent = new MockAgent();
    this.agent.disableNetConnect();
    this.pool = this.agent.get(origin);
  }

  get dispatcher(): Dispatcher {
    return this.agent;
  }

  /** Intercept one method+path, replying with `replies` in order. */
  route(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    ...replies: MockReply[]
  ): Recorder {
    const recorder = new Recorder();
    const queue = [...replies];
    const last = queue.at(-1);
    if (last === undefined) throw new Error('route needs at least one reply');

    this.pool
      .intercept({
        path: (candidate: string) => candidate.split('?')[0] === path,
        method,
      })
      .reply((options) => {
        const bodyText = typeof options.body === 'string' ? options.body : undefined;
        let json: Record<string, unknown> | undefined;
        if (bodyText !== undefined && bodyText !== '') {
          try {
            json = JSON.parse(bodyText) as Record<string, unknown>;
          } catch {
            json = undefined;
          }
        }
        const fullPath = String(options.path);
        recorder.calls.push({
          method,
          path: fullPath,
          headers: normalizeHeaders(options.headers),
          body: bodyText,
          json,
          query: new URLSearchParams(fullPath.split('?')[1] ?? ''),
        });
        const reply = queue.length > 1 ? queue.shift()! : last;
        return {
          statusCode: reply.status,
          data: reply.json === undefined ? '' : JSON.stringify(reply.json),
          responseOptions: {
            headers: { 'content-type': 'application/json', ...reply.headers },
          },
        };
      })
      .persist();

    return recorder;
  }

  get(path: string, ...replies: MockReply[]): Recorder {
    return this.route('GET', path, ...replies);
  }

  post(path: string, ...replies: MockReply[]): Recorder {
    return this.route('POST', path, ...replies);
  }

  patch(path: string, ...replies: MockReply[]): Recorder {
    return this.route('PATCH', path, ...replies);
  }

  delete(path: string, ...replies: MockReply[]): Recorder {
    return this.route('DELETE', path, ...replies);
  }

  async close(): Promise<void> {
    await this.agent.close();
  }
}
