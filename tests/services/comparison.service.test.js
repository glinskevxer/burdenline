import { describe, it, expect } from 'vitest';
import { createComparisonService } from '../../src/services/comparison.service.js';
import { parseProduct } from '../../src/domain/charging/products.js';
import { fixedClock } from '../../src/lib/clock.js';
import { ValidationError } from '../../src/lib/errors.js';

const clock = fixedClock('2026-04-07T09:00:00Z');
const service = createComparisonService({ clock });

const catalogue = [
  parseProduct({
    code: 'ANFO-80',
    name: 'Ammonium nitrate fuel oil',
    kind: 'bulk_anfo',
    densityKgM3: 800,
    relativeWeightStrength: 100,
    minimumDiameterMm: 50,
  }),
];

const prices = [
  { productCode: 'ANFO-80', unit: 'kg', pricePerUnit: 1.2, effectiveFrom: '2026-01-01' },
];
const rates = [{ kind: 'drilling', rate: 6.5, unit: 'metre', effectiveFrom: '2026-01-01' }];
const law = { k: 1140, b: 1.6, scaling: 'square_root' };

const base = {
  origin: { easting: 1000, northing: 2000, level: 84 },
  faceBearingDeg: 0,
  layout: 'staggered',
  rowCount: 3,
  holesPerRow: 8,
  burdenM: 3.2,
  spacingM: 3.6,
  benchHeightM: 15,
  subdrillM: 1,
  inclinationDeg: 0,
  diameterMm: 102,
};

const shared = {
  catalogue,
  powderFactorKgM3: 0.55,
  law,
  receptorDistanceM: 400,
  prices,
  rates,
};

describe('evaluateDesign', () => {
  it('works one design out end to end without writing anything', () => {
    const evaluated = service.evaluateDesign({ ...shared, design: base, onDate: '2026-04-07' });
    expect(evaluated.holeCount).toBe(24);
    expect(evaluated.totalChargeKg).toBeGreaterThan(0);
    expect(evaluated.instantaneousChargeKg).toBeGreaterThan(0);
    expect(evaluated.predictedPpvMmPerSecond).toBeGreaterThan(0);
    expect(evaluated.fragmentation.meanCm).toBeGreaterThan(0);
    expect(evaluated.cost.perTonne).toBeGreaterThan(0);
  });

  it('leaves the vibration unknown when there is no law to predict from', () => {
    const evaluated = service.evaluateDesign({
      ...shared,
      law: undefined,
      design: base,
      onDate: '2026-04-07',
    });
    expect(evaluated.predictedPpvMmPerSecond).toBe(null);
  });
});

describe('compare', () => {
  it('shows a tighter pattern breaking finer and costing more to drill', () => {
    const tighter = { ...base, burdenM: 2.8, spacingM: 3.2, holesPerRow: 9 };
    const result = service.compare({ ...shared, base, alternative: tighter });
    expect(result.verdict.finer).toBe('alternative');
    const drilling = result.differences.find((entry) => entry.key === 'drillingMetres');
    expect(drilling.change).toBeGreaterThan(0);
  });

  it('shows a wider pattern the other way round', () => {
    const wider = { ...base, burdenM: 3.8, spacingM: 4.2, holesPerRow: 6 };
    const result = service.compare({ ...shared, base, alternative: wider });
    expect(result.verdict.finer).toBe('base');
  });

  it('reports the change and the percentage for every dimension', () => {
    const result = service.compare({ ...shared, base, alternative: { ...base, holesPerRow: 6 } });
    for (const entry of result.differences) {
      expect(entry).toHaveProperty('from');
      expect(entry).toHaveProperty('to');
    }
    const holes = result.differences.find((entry) => entry.key === 'holeCount');
    expect(holes.change).toBe(-6);
    expect(holes.percent).toBeCloseTo(-25, 1);
  });

  it('calls two identical designs the same on every dimension', () => {
    const result = service.compare({ ...shared, base, alternative: { ...base } });
    expect(Object.values(result.verdict).every((verdict) => verdict === 'the same')).toBe(true);
  });

  it('says unknown rather than guessing when a number is missing', () => {
    const result = service.compare({
      ...shared,
      law: undefined,
      base,
      alternative: { ...base, burdenM: 3 },
    });
    expect(result.verdict.quieter).toBe('unknown');
  });

  it('refuses to compare one design with nothing', () => {
    expect(() => service.compare({ ...shared, base })).toThrow(ValidationError);
  });

  it('never reduces the four dimensions to one score', () => {
    const result = service.compare({ ...shared, base, alternative: { ...base, burdenM: 3 } });
    expect(result).not.toHaveProperty('score');
    expect(Object.keys(result.verdict).sort()).toEqual([
      'cheaper',
      'finer',
      'lessOversize',
      'quieter',
    ]);
  });

  it('takes the date from the clock when the caller gives none', () => {
    const result = service.compare({ ...shared, base, alternative: { ...base, burdenM: 3 } });
    expect(result.base.cost.total).toBeGreaterThan(0);
  });
});
