/**
 * Re-exports for the tests: the public surface, plus the few internals a test
 * needs to reach directly.
 */

export * from '../../src/index.js';
export { decodeBridgeHealth, decodeTradeEvent } from '../../src/decode.js';
