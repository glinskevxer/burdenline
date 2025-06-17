import { describe, it, expect } from 'vitest';
import {
  MOVEMENTS,
  directionOf,
  signedQuantity,
  balances,
  netExplosiveQuantityKg,
  detonatorCount,
  magazineState,
  canApply,
} from '../../../src/domain/magazine/stock.js';
import { ValidationError } from '../../../src/lib/errors.js';

const magazine = {
  id: 'mag_1',
  name: 'Upper store',
  netExplosiveLimitKg: 2000,
  status: 'active',
};

function line(overrides = {}) {
  return {
    magazineId: 'mag_1',
    batchId: 'batch_1',
    movement: 'receipt',
    quantity: 1000,
    unit: 'kg',
    massKg: 1000,
    occurredAt: '2025-06-16T09:00:00.000Z',
    ...overrides,
  };
}

describe('movement direction', () => {
  it('brings receipts and returns in', () => {
    expect(directionOf('receipt')).toBe(1);
    expect(directionOf('return')).toBe(1);
    expect(directionOf('transfer_in')).toBe(1);
  });

  it('takes issues and consumption out', () => {
    expect(directionOf('issue')).toBe(-1);
    expect(directionOf('consumption')).toBe(-1);
    expect(directionOf('disposal')).toBe(-1);
  });

  it('lets a correction go either way', () => {
    expect(directionOf('correction')).toBe(0);
    expect(directionOf('stocktake')).toBe(0);
  });

  it('refuses a movement nobody records', () => {
    expect(() => directionOf('borrowed')).toThrow(ValidationError);
  });

  it('names every movement it knows', () => {
    expect(MOVEMENTS).toHaveLength(9);
  });
});

describe('signedQuantity', () => {
  it('applies the sign so the caller does not have to', () => {
    expect(signedQuantity('receipt', 250)).toBe(250);
    expect(signedQuantity('issue', 250)).toBe(-250);
  });

  it('takes a correction either way', () => {
    expect(signedQuantity('correction', -20)).toBe(-20);
    expect(signedQuantity('correction', 20)).toBe(20);
  });

  it('refuses a negative magnitude on a directional movement', () => {
    expect(() => signedQuantity('issue', -250)).toThrow(/positive quantity/);
    expect(() => signedQuantity('receipt', 0)).toThrow(ValidationError);
  });

  it('refuses a quantity that is not a number', () => {
    expect(() => signedQuantity('receipt', '250')).toThrow(ValidationError);
  });
});

describe('balances', () => {
  it('sums a batch down the ledger', () => {
    const held = balances([
      line(),
      line({ movement: 'issue', quantity: -250, massKg: -250 }),
      line({ movement: 'return', quantity: 40, massKg: 40 }),
    ]);
    expect(held).toHaveLength(1);
    expect(held[0].quantity).toBe(790);
    expect(held[0].lineCount).toBe(3);
  });

  it('keeps batches apart', () => {
    const held = balances([line(), line({ batchId: 'batch_2', quantity: 500, massKg: 500 })]);
    expect(held.map((batch) => batch.batchId).sort()).toEqual(['batch_1', 'batch_2']);
  });

  it('remembers when the batch last moved', () => {
    const held = balances([
      line(),
      line({
        occurredAt: '2025-07-01T09:00:00.000Z',
        movement: 'issue',
        quantity: -10,
        massKg: -10,
      }),
    ]);
    expect(held[0].lastMovementAt).toBe('2025-07-01T09:00:00.000Z');
  });

  it('refuses a batch counted in two units', () => {
    expect(() => balances([line(), line({ unit: 'each' })])).toThrow(/lines in both kg and each/);
  });

  it('reads an empty ledger as nothing held', () => {
    expect(balances([])).toEqual([]);
    expect(netExplosiveQuantityKg([])).toBe(0);
  });
});

describe('netExplosiveQuantityKg', () => {
  it('adds the mass across every batch', () => {
    expect(
      netExplosiveQuantityKg([line(), line({ batchId: 'batch_2', quantity: 500, massKg: 500 })]),
    ).toBe(1500);
  });
});

describe('detonatorCount', () => {
  it('counts only the detonator batches', () => {
    const lines = [line(), line({ batchId: 'batch_det', unit: 'each', quantity: 300, massKg: 12 })];
    expect(detonatorCount(lines, (batchId) => batchId === 'batch_det')).toBe(300);
  });
});

describe('magazineState', () => {
  it('reports what is held and how much room is left', () => {
    const state = magazineState(magazine, [line()]);
    expect(state.netExplosiveKg).toBe(1000);
    expect(state.headroomKg).toBe(1000);
    expect(state.utilisation).toBe(0.5);
    expect(state.valid).toBe(true);
  });

  it('flags a magazine over its licence', () => {
    const state = magazineState(magazine, [line({ quantity: 2500, massKg: 2500 })]);
    expect(state.valid).toBe(false);
    expect(state.violations[0].rule).toBe('magazine.over_licence');
  });

  it('flags a detonator store over its count', () => {
    const store = { ...magazine, detonatorLimit: 500 };
    const lines = [line({ batchId: 'batch_det', unit: 'each', quantity: 700, massKg: 30 })];
    const state = magazineState(store, lines, { batchIsDetonator: () => true });
    expect(state.violations.map((v) => v.rule)).toContain('magazine.over_detonator_limit');
  });

  it('flags a batch that has gone negative', () => {
    const lines = [line(), line({ movement: 'issue', quantity: -1200, massKg: -1200 })];
    expect(magazineState(magazine, lines).violations.map((v) => v.rule)).toContain(
      'magazine.negative_stock',
    );
  });

  it('leaves an emptied batch out of the holdings but counts it', () => {
    const lines = [line(), line({ movement: 'issue', quantity: -1000, massKg: -1000 })];
    const state = magazineState(magazine, lines);
    expect(state.batches).toHaveLength(0);
    expect(state.emptyBatches).toBe(1);
  });
});

describe('canApply', () => {
  const held = [line()];

  it('allows an issue that is covered by stock', () => {
    const result = canApply(
      { movement: 'issue', quantity: 250, batchId: 'batch_1' },
      magazine,
      held,
    );
    expect(result.valid).toBe(true);
    expect(result.quantity).toBe(-250);
  });

  it('refuses an issue of more than is held', () => {
    const result = canApply(
      { movement: 'issue', quantity: 1500, batchId: 'batch_1' },
      magazine,
      held,
    );
    expect(result.valid).toBe(false);
    expect(result.violations[0].rule).toBe('magazine.insufficient_stock');
  });

  it('refuses an issue from a batch that is not there at all', () => {
    const result = canApply(
      { movement: 'issue', quantity: 10, batchId: 'batch_9' },
      magazine,
      held,
    );
    expect(result.valid).toBe(false);
  });

  it('refuses a receipt that would take the magazine over its licence', () => {
    const result = canApply(
      { movement: 'receipt', quantity: 1500, massKg: 1500, batchId: 'batch_2' },
      magazine,
      held,
    );
    expect(result.violations.map((v) => v.rule)).toContain('magazine.would_exceed_licence');
  });

  it('allows a receipt that fits', () => {
    const result = canApply(
      { movement: 'receipt', quantity: 500, massKg: 500, batchId: 'batch_2' },
      magazine,
      held,
    );
    expect(result.valid).toBe(true);
  });

  it('refuses any movement into a suspended magazine', () => {
    const suspended = { ...magazine, status: 'suspended' };
    const result = canApply(
      { movement: 'receipt', quantity: 10, massKg: 10, batchId: 'batch_2' },
      suspended,
      held,
    );
    expect(result.violations.map((v) => v.rule)).toContain('magazine.not_active');
  });
});
