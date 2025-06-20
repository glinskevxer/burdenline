import { describe, it, expect } from 'vitest';
import {
  daysUntil,
  batchStatus,
  pickBatch,
  sleepCheck,
  checkBatchesForLoading,
  traceForBlast,
  whereElse,
  DEFAULT_BATCH_RULES,
} from '../../../src/domain/magazine/batches.js';
import { ValidationError } from '../../../src/lib/errors.js';

const asOf = '2025-06-17T09:00:00.000Z';

function batch(overrides = {}) {
  return {
    id: 'batch_1',
    batchCode: 'L2025-114',
    productCode: 'ANFO-80',
    receivedAt: '2025-03-01T09:00:00.000Z',
    expiresOn: '2026-03-01',
    quantityHeld: 800,
    supplier: 'Kilcorney Explosives',
    deliveryNote: 'DN-88213',
    ...overrides,
  };
}

describe('daysUntil', () => {
  it('counts the days left', () => {
    expect(daysUntil('2025-06-27', asOf)).toBe(9);
  });

  it('goes negative once the date is past', () => {
    expect(daysUntil('2025-06-01', asOf)).toBeLessThan(0);
  });

  it('has no answer for a batch with no expiry', () => {
    expect(daysUntil(null, asOf)).toBe(null);
  });

  it('refuses a date that is not one', () => {
    expect(() => daysUntil('soon', asOf)).toThrow(ValidationError);
  });
});

describe('batchStatus', () => {
  it('calls a fresh batch usable', () => {
    expect(batchStatus(batch(), asOf).status).toBe('usable');
  });

  it('calls a batch inside the warning window expiring', () => {
    expect(batchStatus(batch({ expiresOn: '2025-07-01' }), asOf).status).toBe('expiring');
  });

  it('calls a batch past its date expired', () => {
    expect(batchStatus(batch({ expiresOn: '2025-05-01' }), asOf).status).toBe('expired');
  });

  it('treats a batch with no expiry as usable', () => {
    expect(batchStatus(batch({ expiresOn: null }), asOf).daysRemaining).toBe(null);
  });

  it('follows a longer warning window', () => {
    const rules = { ...DEFAULT_BATCH_RULES, warnWithinDays: 120 };
    expect(batchStatus(batch({ expiresOn: '2025-09-01' }), asOf, rules).status).toBe('expiring');
  });
});

describe('pickBatch', () => {
  const stock = [
    batch({ id: 'batch_a', batchCode: 'A', expiresOn: '2026-01-01', quantityHeld: 300 }),
    batch({ id: 'batch_b', batchCode: 'B', expiresOn: '2025-09-01', quantityHeld: 200 }),
    batch({ id: 'batch_c', batchCode: 'C', expiresOn: null, quantityHeld: 500 }),
  ];

  it('draws from the batch that expires first', () => {
    const picked = pickBatch(stock, { quantity: 150, asOf });
    expect(picked.drawn).toEqual([{ batchId: 'batch_b', batchCode: 'B', quantity: 150 }]);
    expect(picked.satisfied).toBe(true);
  });

  it('spills into the next batch when the first runs out', () => {
    const picked = pickBatch(stock, { quantity: 400, asOf });
    expect(picked.drawn.map((entry) => entry.batchCode)).toEqual(['B', 'A']);
    expect(picked.drawn[1].quantity).toBe(200);
  });

  it('leaves a batch with no expiry until last', () => {
    const picked = pickBatch(stock, { quantity: 900, asOf });
    expect(picked.drawn.at(-1).batchCode).toBe('C');
  });

  it('skips an expired batch entirely', () => {
    const withExpired = [
      batch({ id: 'batch_x', batchCode: 'X', expiresOn: '2025-01-01', quantityHeld: 900 }),
      ...stock,
    ];
    const picked = pickBatch(withExpired, { quantity: 100, asOf });
    expect(picked.drawn[0].batchCode).toBe('B');
  });

  it('reports a shortfall rather than pretending', () => {
    const picked = pickBatch(stock, { quantity: 2000, asOf });
    expect(picked.satisfied).toBe(false);
    expect(picked.shortfall).toBe(1000);
  });

  it('ignores a batch that is empty', () => {
    const picked = pickBatch([batch({ quantityHeld: 0 })], { quantity: 10, asOf });
    expect(picked.drawn).toEqual([]);
  });
});

describe('sleepCheck', () => {
  it('reports how long a hole has been loaded', () => {
    const check = sleepCheck({
      loadedAt: '2025-06-16T09:00:00.000Z',
      asOf,
      sleepTimeHours: 72,
    });
    expect(check.hoursAsleep).toBe(24);
    expect(check.hoursRemaining).toBe(48);
    expect(check.expired).toBe(false);
  });

  it('flags a hole left past its sleep time', () => {
    const check = sleepCheck({
      loadedAt: '2025-06-10T09:00:00.000Z',
      asOf,
      sleepTimeHours: 72,
    });
    expect(check.expired).toBe(true);
  });

  it('says nothing about a product with no sleep time', () => {
    const check = sleepCheck({ loadedAt: '2025-01-01T09:00:00.000Z', asOf, sleepTimeHours: null });
    expect(check.expired).toBe(false);
    expect(check.hoursAsleep).toBe(null);
  });
});

describe('checkBatchesForLoading', () => {
  it('passes fresh stock', () => {
    expect(checkBatchesForLoading([batch()], asOf).valid).toBe(true);
  });

  it('blocks on an expired batch', () => {
    const result = checkBatchesForLoading([batch({ expiresOn: '2025-05-01' })], asOf);
    expect(result.valid).toBe(false);
    expect(result.blocking[0].rule).toBe('batch.expired');
  });

  it('warns but does not block on a batch about to expire', () => {
    const result = checkBatchesForLoading([batch({ expiresOn: '2025-07-01' })], asOf);
    expect(result.valid).toBe(true);
    expect(result.violations[0].rule).toBe('batch.expiring');
  });

  it('blocks on a quarantined batch', () => {
    const result = checkBatchesForLoading([batch({ quarantined: true })], asOf);
    expect(result.valid).toBe(false);
    expect(result.blocking[0].rule).toBe('batch.quarantined');
  });
});

describe('traceForBlast', () => {
  const batches = new Map([['batch_1', batch()]]);
  const lines = [
    { batchId: 'batch_1', movement: 'issue', quantity: -400, massKg: -400, blastId: 'blast_1' },
    {
      batchId: 'batch_1',
      movement: 'consumption',
      quantity: -380,
      massKg: -380,
      blastId: 'blast_1',
    },
    { batchId: 'batch_1', movement: 'return', quantity: 20, massKg: 20, blastId: 'blast_1' },
  ];

  it('traces only what was actually consumed', () => {
    const trace = traceForBlast(lines, batches);
    expect(trace).toHaveLength(1);
    expect(trace[0].quantity).toBe(380);
  });

  it('carries the delivery note and the supplier through', () => {
    const trace = traceForBlast(lines, batches);
    expect(trace[0].deliveryNote).toBe('DN-88213');
    expect(trace[0].supplier).toBe('Kilcorney Explosives');
  });

  it('leaves the batch details unknown when the batch is gone', () => {
    const trace = traceForBlast(lines, new Map());
    expect(trace[0].batchCode).toBe(null);
  });
});

describe('whereElse', () => {
  it('lists every shot a batch went into', () => {
    const lines = [
      { batchId: 'batch_1', blastId: 'blast_1' },
      { batchId: 'batch_1', blastId: 'blast_2' },
      { batchId: 'batch_1', blastId: 'blast_1' },
      { batchId: 'batch_2', blastId: 'blast_3' },
      { batchId: 'batch_1', blastId: null },
    ];
    expect(whereElse('batch_1', lines)).toEqual(['blast_1', 'blast_2']);
  });
});
