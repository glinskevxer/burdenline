import { describe, it, expect } from 'vitest';
import {
  priceOn,
  rateOn,
  explosiveCost,
  drillingCost,
  fixedCost,
  costBlast,
  compareCosts,
  COST_KINDS,
} from '../../../src/domain/costing/blast-cost.js';
import { ValidationError } from '../../../src/lib/errors.js';

const prices = [
  {
    productCode: 'ANFO-80',
    unit: 'kg',
    pricePerUnit: 1.1,
    effectiveFrom: '2025-01-01',
    effectiveTo: '2025-07-01',
  },
  { productCode: 'ANFO-80', unit: 'kg', pricePerUnit: 1.35, effectiveFrom: '2025-07-01' },
  { productCode: 'EM-115', unit: 'kg', pricePerUnit: 2.2, effectiveFrom: '2025-01-01' },
];

const rates = [
  { kind: 'drilling', rate: 6.5, unit: 'metre', effectiveFrom: '2025-01-01' },
  { kind: 'labour', rate: 42, unit: 'hour', effectiveFrom: '2025-01-01' },
  { kind: 'secondary_breaking', rate: 95, unit: 'hour', effectiveFrom: '2025-01-01' },
];

describe('priceOn', () => {
  it('takes the price in force on the day', () => {
    expect(priceOn(prices, 'ANFO-80', '2025-03-01').pricePerUnit).toBe(1.1);
    expect(priceOn(prices, 'ANFO-80', '2025-09-01').pricePerUnit).toBe(1.35);
  });

  it('treats the end date as the first day of the new price', () => {
    expect(priceOn(prices, 'ANFO-80', '2025-07-01').pricePerUnit).toBe(1.35);
  });

  it('has no price before the first one starts', () => {
    expect(priceOn(prices, 'ANFO-80', '2024-06-01')).toBe(null);
  });

  it('has no price for a product nobody priced', () => {
    expect(priceOn(prices, 'BST-400', '2025-09-01')).toBe(null);
  });
});

describe('rateOn', () => {
  it('finds the rate for a kind of work', () => {
    expect(rateOn(rates, 'drilling', '2025-09-01').rate).toBe(6.5);
  });

  it('has nothing for a kind nobody set a rate for', () => {
    expect(rateOn(rates, 'monitoring', '2025-09-01')).toBe(null);
  });
});

describe('explosiveCost', () => {
  it('costs what was consumed at the price on the day', () => {
    const result = explosiveCost({
      consumption: [{ productCode: 'ANFO-80', quantity: 1000, unit: 'kg' }],
      prices,
      onDate: '2025-03-01',
    });
    expect(result.total).toBe(1100);
    expect(result.lines[0].pricePerUnit).toBe(1.1);
  });

  it('costs the same shot differently after a price rise', () => {
    const later = explosiveCost({
      consumption: [{ productCode: 'ANFO-80', quantity: 1000 }],
      prices,
      onDate: '2025-09-01',
    });
    expect(later.total).toBe(1350);
  });

  it('adds several products up', () => {
    const result = explosiveCost({
      consumption: [
        { productCode: 'ANFO-80', quantity: 800 },
        { productCode: 'EM-115', quantity: 200 },
      ],
      prices,
      onDate: '2025-03-01',
    });
    expect(result.total).toBe(1320);
  });

  it('reports what it could not price rather than costing it at nothing', () => {
    const result = explosiveCost({
      consumption: [{ productCode: 'BST-400', quantity: 24 }],
      prices,
      onDate: '2025-03-01',
    });
    expect(result.total).toBe(0);
    expect(result.unpriced).toEqual(['BST-400']);
  });
});

describe('drillingCost', () => {
  it('costs the metres at the rate', () => {
    expect(drillingCost({ metresDrilled: 400, rates, onDate: '2025-09-01' }).total).toBe(2600);
  });

  it('costs nothing and says so when there is no rate', () => {
    const result = drillingCost({ metresDrilled: 400, rates: [], onDate: '2025-09-01' });
    expect(result.total).toBe(0);
    expect(result.priced).toBe(false);
  });

  it('refuses a negative length', () => {
    expect(() => drillingCost({ metresDrilled: -10, rates, onDate: '2025-09-01' })).toThrow(
      ValidationError,
    );
  });
});

describe('fixedCost', () => {
  it('costs hours at the rate for the kind', () => {
    expect(fixedCost({ kind: 'labour', quantity: 8, rates, onDate: '2025-09-01' }).total).toBe(336);
  });

  it('refuses a kind nobody accounts for', () => {
    expect(() => fixedCost({ kind: 'catering', quantity: 1, rates, onDate: '2025-09-01' })).toThrow(
      ValidationError,
    );
  });

  it('lists what it can cost', () => {
    expect(COST_KINDS).toContain('secondary_breaking');
  });
});

describe('costBlast', () => {
  const shot = {
    consumption: [{ productCode: 'ANFO-80', quantity: 1000 }],
    prices,
    rates,
    metresDrilled: 400,
    labourHours: 12,
    tonnes: 6000,
    volumeM3: 2100,
    onDate: '2025-03-01',
  };

  it('adds every part up', () => {
    const cost = costBlast(shot);
    expect(cost.parts.explosive).toBe(1100);
    expect(cost.parts.drilling).toBe(2600);
    expect(cost.parts.labour).toBe(504);
    expect(cost.total).toBe(4204);
  });

  it('reports cost per tonne and per cubic metre', () => {
    const cost = costBlast(shot);
    expect(cost.perTonne).toBeCloseTo(0.7007, 4);
    expect(cost.perCubicMetre).toBeCloseTo(2.0019, 4);
  });

  it('reports what share each part is', () => {
    const cost = costBlast(shot);
    expect(cost.share.drilling).toBeCloseTo(0.6185, 3);
    expect(Object.values(cost.share).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 3);
  });

  it('includes the secondary breaking that a coarse shot needed', () => {
    const withHammer = costBlast({ ...shot, secondaryBreakingHours: 16 });
    expect(withHammer.parts.secondary_breaking).toBe(1520);
    expect(withHammer.total).toBeGreaterThan(costBlast(shot).total);
  });

  it('leaves the per tonne figures unknown when nobody weighed it', () => {
    const cost = costBlast({ ...shot, tonnes: undefined, volumeM3: undefined });
    expect(cost.perTonne).toBe(null);
    expect(cost.perCubicMetre).toBe(null);
  });

  it('refuses to cost a shot with no date', () => {
    expect(() => costBlast({ ...shot, onDate: undefined })).toThrow(ValidationError);
  });
});

describe('compareCosts', () => {
  const base = {
    consumption: [{ productCode: 'ANFO-80', quantity: 1000 }],
    prices,
    rates,
    metresDrilled: 400,
    tonnes: 6000,
    onDate: '2025-03-01',
  };

  it('shows a wider pattern saving drilling', () => {
    const tight = costBlast(base);
    const wide = costBlast({ ...base, metresDrilled: 330, tonnes: 6000 });
    const comparison = compareCosts(tight, wide);
    expect(comparison.cheaper).toBe('second');
    expect(comparison.byKind.drilling).toBeLessThan(0);
  });

  it('shows the hammer wiping that saving out', () => {
    const tight = costBlast(base);
    const wide = costBlast({ ...base, metresDrilled: 330, secondaryBreakingHours: 8 });
    expect(compareCosts(tight, wide).cheaper).toBe('first');
  });

  it('compares per tonne as well as in total', () => {
    const first = costBlast(base);
    const second = costBlast({ ...base, tonnes: 7000 });
    expect(compareCosts(first, second).perTonneDifference).toBeLessThan(0);
  });
});
