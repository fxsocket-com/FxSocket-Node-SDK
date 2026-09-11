import { buildOrderBatch, buildCloseBatch } from '../src/trading.js';

function show(label: string, fn: () => unknown) {
  try {
    console.log(label, JSON.stringify(fn()));
  } catch (e) {
    console.log(label, 'THREW:', (e as Error).constructor.name, (e as Error).message);
  }
}

// 1. basic order batch
show('A order basic ->', () =>
  buildOrderBatch([{ accountId: 'a1', volume: 0.1 }], {
    defaults: { symbol: 'EURUSD', operation: 'buy', volume: 1, magic: 42 },
  }),
);

// 2. expiration as Date
show('B expiration ->', () =>
  buildOrderBatch([{ accountId: 'a1' }], {
    defaults: {
      symbol: 'EURUSD',
      operation: 'BuyLimit',
      volume: 1,
      price: 1.1,
      expiration: new Date('2030-01-01T00:00:00Z'),
    },
  }),
);

// 3. leg-level magic 0 overriding default magic
show('C magic 0 ->', () =>
  buildOrderBatch([{ accountId: 'a1', magic: 0 }], {
    defaults: { symbol: 'EURUSD', operation: 'buy', volume: 1, magic: 99 },
  }),
);

// 4. slippage negative on leg
show('D negative slippage leg ->', () =>
  buildOrderBatch([{ accountId: 'a1', slippage: -5 }], {
    defaults: { symbol: 'EURUSD', operation: 'buy', volume: 1 },
  }),
);

// 5. negative slippage only in DEFAULTS, leg overrides nothing
show('E negative slippage defaults ->', () =>
  buildOrderBatch([{ accountId: 'a1' }], {
    defaults: { symbol: 'EURUSD', operation: 'buy', volume: 1, slippage: -5 },
  }),
);

// 6. volume 0 -> should throw
show('F volume 0 ->', () =>
  buildOrderBatch([{ accountId: 'a1', volume: 0 }], {
    defaults: { symbol: 'EURUSD', operation: 'buy', volume: 1 },
  }),
);

// 7. stop-limit without stopLimitPrice
show('G stoplimit ->', () =>
  buildOrderBatch([{ accountId: 'a1' }], {
    defaults: { symbol: 'EURUSD', operation: 'BuyStopLimit', volume: 1, price: 1.1 },
  }),
);

// 8. account object as leg
show('H account object ->', () =>
  buildOrderBatch([{ id: 'acc_9' } as never], {
    defaults: { symbol: 'EURUSD', operation: 'buy', volume: 1 },
  }),
);

// 9. close with tickets
show('I close tickets ->', () =>
  buildCloseBatch([{ accountId: 'a1', tickets: [1, 2] }]),
);

// 10. close tickets + selector in defaults only (allowed?)
show('J close tickets + default symbol ->', () =>
  buildCloseBatch([{ accountId: 'a1', tickets: [1] }], { defaults: { symbol: 'EURUSD' } }),
);

// 11. close selector
show('K close selector ->', () =>
  buildCloseBatch([{ accountId: 'a1' }], {
    defaults: { symbol: '*', kind: 'ANY', side: 'Long', symbolMatch: 'BASE' },
  }),
);

// 12. close no symbol
show('L close no symbol ->', () => buildCloseBatch([{ accountId: 'a1' }]));

// 13. close volume 0
show('M close volume 0 ->', () =>
  buildCloseBatch([{ accountId: 'a1', symbol: 'EURUSD', volume: 0 }]),
);

// 14. empty
show('N empty orders ->', () => buildOrderBatch([]));

// 15. requireReachable
show('O requireReachable ->', () =>
  buildOrderBatch([{ accountId: 'a1' }], {
    defaults: { symbol: 'EURUSD', operation: 'buy', volume: 1 },
    requireReachable: true,
  }),
);

// 16. unknown field
show('P unknown field ->', () =>
  buildOrderBatch([{ accountId: 'a1', stop_loss: 1 } as never], {
    defaults: { symbol: 'EURUSD', operation: 'buy', volume: 1 },
  }),
);

// 17. leg with accountId as object
show('Q accountId object ->', () =>
  buildOrderBatch([{ accountId: { id: 'acc_7' } as never, volume: 2 }], {
    defaults: { symbol: 'EURUSD', operation: 'buy', volume: 1 },
  }),
);

// 18. expiration string passthrough
show('R expiration string ->', () =>
  buildOrderBatch([{ accountId: 'a1' }], {
    defaults: {
      symbol: 'EURUSD',
      operation: 'SellStop',
      volume: 1,
      price: 1.0,
      expiration: '2030-01-01 00:00',
    },
  }),
);

// 19. tickets non-integer
show('S tickets 1.5 ->', () =>
  buildCloseBatch([{ accountId: 'a1', tickets: [1.5] }]),
);

// 20. close leg magic only (no symbol) -> python requires symbol
show('T close magic only ->', () =>
  buildCloseBatch([{ accountId: 'a1', magic: 5 }]),
);
