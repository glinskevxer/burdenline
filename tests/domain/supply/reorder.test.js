import { describe, it, expect } from 'vitest';
import {
  consumptionProfile,
  reorderPoint,
  assessStock,
  reviewStore,
  DEFAULT_SUPPLY_RULES,
} from '../../../src/domain/supply/reorder.js';
import { ValidationError } from '../../../src/lib/errors.js';

/** Six weeks of a site that fires about twice a week. */
const usage = [
  { on: '2026-01-05', quantity: 900 },
  { on: '2026-01-08', quantity: 1100 },
  { on: '2026-01-13', quantity: 1000 },
  { on: '2026-01-19', quantity: 800 },
  { on: '2026-01-27', quantity: 1200 },
  { on: '2026-02-03', quantity: 950 },
  { on: '2026-02-10', quantity: 1050 },
  { on: '2026-02-15', quantity: 1000 },
];

describe('consumptionProfile', () => {
  it('works the daily rate out over the span of the history', () => {
    const profile = consumptionProfile(usage);
    expect(profile.days).toBe(42);
    expect(profile.total).toBe(8000);
    expect(profile.perDay).toBeCloseTo(190.48, 2);
  });

  it('takes a span the caller knows better than the data does', () => {
    expect(consumptionProfile(usage, { days: 60 }).perDay).toBeCloseTo(133.33, 2);
  });

  it('measures how much the daily figure varies', () => {
    expect(consumptionProfile(usage).deviation).toBeGreaterThan(0);
    expect(consumptionProfile([{ on: '2026-01-05', quantity: 900 }]).deviation).toBe(0);
  });

  it('reports the busiest single day', () => {
    expect(consumptionProfile(usage).busiestDay).toBe(1200);
  });

  it('reads no history as nothing used', () => {
    expect(consumptionProfile([])).toMatchObject({ total: 0, perDay: 0, entries: 0 });
  });

  it('adds up two draws on the same day', () => {
    const profile = consumptionProfile([
      { on: '2026-01-05', quantity: 400 },
      { on: '2026-01-05', quantity: 600 },
    ]);
    expect(profile.busiestDay).toBe(1000);
    expect(profile.days).toBe(1);
  });
});

describe('reorderPoint', () => {
  const profile = consumptionProfile(usage);

  it('covers the lead time plus a buffer for the variation', () => {
    const point = reorderPoint({ profile });
    expect(point.duringLeadTime).toBeCloseTo(1333.36, 1);
    expect(point.buffer).toBeGreaterThan(0);
    expect(point.reorderAt).toBeGreaterThan(point.duringLeadTime);
  });

  it('asks for more cover on a site whose use jumps about', () => {
    const steady = reorderPoint({ profile: { perDay: 190, deviation: 10 } });
    const lumpy = reorderPoint({ profile: { perDay: 190, deviation: 400 } });
    expect(lumpy.reorderAt).toBeGreaterThan(steady.reorderAt);
  });

  it('follows a longer lead time', () => {
    const slow = reorderPoint({ profile, rules: { ...DEFAULT_SUPPLY_RULES, leadTimeDays: 21 } });
    expect(slow.reorderAt).toBeGreaterThan(reorderPoint({ profile }).reorderAt);
  });
});

describe('assessStock', () => {
  const profile = consumptionProfile(usage);

  it('says nothing needs doing when the store is full', () => {
    const result = assessStock({ productCode: 'ANFO-80', held: 6000, profile });
    expect(result.action).toBe('none');
    expect(result.suggestedQuantity).toBe(0);
  });

  it('says order when the level drops through the reorder point', () => {
    const result = assessStock({ productCode: 'ANFO-80', held: 1800, profile });
    expect(result.action).toBe('order');
    expect(result.suggestedQuantity).toBeGreaterThan(0);
  });

  it('says urgent when what is left will not last the lead time', () => {
    expect(assessStock({ productCode: 'ANFO-80', held: 900, profile }).action).toBe('urgent');
  });

  it('counts what is already on order', () => {
    const alone = assessStock({ productCode: 'ANFO-80', held: 900, profile });
    const covered = assessStock({ productCode: 'ANFO-80', held: 900, onOrder: 4000, profile });
    expect(alone.action).toBe('urgent');
    expect(covered.action).toBe('none');
  });

  it('reports how many days of cover there is', () => {
    expect(assessStock({ productCode: 'ANFO-80', held: 1904.8, profile }).daysOfCover).toBeCloseTo(
      10,
      0,
    );
  });

  it('warns when there is barely any history behind the number', () => {
    const thin = consumptionProfile([{ on: '2026-02-14', quantity: 900 }]);
    expect(assessStock({ productCode: 'ANFO-80', held: 100, profile: thin }).note).toContain(
      'guess',
    );
  });

  it('refuses a negative holding', () => {
    expect(() => assessStock({ productCode: 'ANFO-80', held: -1, profile })).toThrow(
      ValidationError,
    );
  });
});

describe('reviewStore', () => {
  const profile = consumptionProfile(usage);

  it('puts the urgent ones first', () => {
    const review = reviewStore({
      items: [
        { productCode: 'ANFO-80', held: 6000, profile },
        { productCode: 'EM-115', held: 400, profile },
        { productCode: 'BST-400', held: 1800, profile },
      ],
    });
    expect(review.items[0].productCode).toBe('EM-115');
    expect(review.urgent).toBe(1);
    expect(review.toOrder).toHaveLength(2);
  });

  it('works a profile out from raw usage when it is handed one', () => {
    const review = reviewStore({ items: [{ productCode: 'ANFO-80', held: 500, usage }] });
    expect(review.items[0].action).toBe('urgent');
  });

  it('has nothing to order from a full store', () => {
    const review = reviewStore({ items: [{ productCode: 'ANFO-80', held: 20000, profile }] });
    expect(review.toOrder).toEqual([]);
  });

  it('refuses a review with no items', () => {
    expect(() => reviewStore({ items: undefined })).toThrow(ValidationError);
  });
});

describe('a product nothing has ever been drawn of', () => {
  const nothing = consumptionProfile([]);

  it('is not urgent just because the shelf is empty', () => {
    const result = assessStock({ productCode: 'BST-400', held: 0, profile: nothing });
    expect(result.action).toBe('none');
    expect(result.suggestedQuantity).toBe(0);
  });

  it('has no days of cover to report', () => {
    expect(assessStock({ productCode: 'BST-400', held: 0, profile: nothing }).daysOfCover).toBe(
      null,
    );
  });

  it('stays out of the ordering list', () => {
    const review = reviewStore({
      items: [
        { productCode: 'BST-400', held: 0, profile: nothing },
        { productCode: 'ANFO-80', held: 100, usage },
      ],
    });
    expect(review.toOrder.map((item) => item.productCode)).toEqual(['ANFO-80']);
  });

  it('starts being counted the moment it is used once', () => {
    const once = consumptionProfile([{ on: '2026-02-14', quantity: 40 }]);
    expect(assessStock({ productCode: 'BST-400', held: 0, profile: once }).action).toBe('urgent');
  });
});
