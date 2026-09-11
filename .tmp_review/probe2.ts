import { buildOrderBatch } from '../src/trading.js';
const d = { symbol: 'EURUSD', operation: 'buy', volume: 1 } as any;
for (const entry of [
  'acc_str',
  { id: 'acc_9' },
  { id: 'acc_9', nickname: 'n', platform: 'mt5' },
]) {
  try {
    console.log(JSON.stringify(entry), '->', JSON.stringify(buildOrderBatch([entry as any], { defaults: d })));
  } catch (e) { console.log(JSON.stringify(entry), '-> THREW', (e as Error).message); }
}
