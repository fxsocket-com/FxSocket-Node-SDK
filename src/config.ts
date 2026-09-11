/** Library-wide defaults. */

/** Base URL of the public management API (account CRUD + status). */
export const DEFAULT_BASE_URL = 'https://api.fxsocket.com/v1';

/** Default request timeout, in milliseconds, for REST calls. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Environment variable read when no `apiKey` is passed explicitly. */
export const ENV_API_KEY = 'FXSOCKET_API_KEY';
