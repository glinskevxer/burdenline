import { describe, it, expect } from 'vitest';
import {
  chooseProduct,
  targetMassKg,
  planHole,
  planPattern,
  loadSheet,
} from '../../../src/domain/charging/charge-plan.js';
import { parseProduct } from '../../../src/domain/charging/products.js';
import { ValidationError, RuleViolationError } from '../../../src/lib/errors.js';

const anfo = parseProduct({
  code: 'ANFO-80',
  name: 'Ammonium nitrate fuel oil',
  kind: 'bulk_anfo',
  densityKgM3: 800,
  relativeWeightStrength: 100,
  waterResistance: 'none',
  minimumDiameterMm: 50,
});

const emulsion = parseProduct({
  code: 'EM-115',
  name: 'Pumped emulsion',
  kind: 'bulk_emulsion',
  densityKgM3: 1150,
  relativeWeightStrength: 82,
  waterResistance: 'excellent',
  minimumDiameterMm: 76,
});

const catalogue = [anfo, emulsion];

const options = {
  catalogue,
  burdenM: 3,
  spacingM: 3.5,
  benchHeightM: 15,
  powderFactorKgM3: 0.55,
};

const dryHole = {
  holeNumber: 1,
  diameterMm: 102,
  drilledDepthM: 16,
  condition: 'dry',
  nominalBurdenM: 3,
  measuredBurdenM: 3,
};

describe('chooseProduct', () => {
  it('takes the emulsion for a wet hole', () => {
    expect(chooseProduct({ ...dryHole, condition: 'wet' }, catalogue).code).toBe('EM-115');
  });

  it('refuses when nothing in the catalogue fits', () => {
    expect(() =>
      chooseProduct({ ...dryHole, diameterMm: 38, condition: 'wet' }, catalogue),
    ).toThrow(RuleViolationError);
  });

  it('names the hole in the violation', () => {
    try {
      chooseProduct({ ...dryHole, holeNumber: 12, condition: 'lost' }, catalogue);
      throw new Error('should have thrown');
    } catch (error) {
      expect(error.violations[0].holeNumber).toBe(12);
      expect(error.violations[0].rule).toBe('product.none_suitable');
    }
  });
});

describe('targetMassKg', () => {
  it('works the charge out from the powder factor', () => {
    expect(
      targetMassKg({ burdenM: 3, spacingM: 3.5, benchHeightM: 15, powderFactorKgM3: 0.55 }),
    ).toBe(86.625);
  });

  it('refuses a missing dimension', () => {
    expect(() =>
      targetMassKg({ burdenM: 3, spacingM: 0, benchHeightM: 15, powderFactorKgM3: 0.5 }),
    ).toThrow(ValidationError);
  });
});

describe('planHole', () => {
  it('loads a dry hole with anfo to the target', () => {
    const planned = planHole(dryHole, options);
    expect(planned.productCode).toBe('ANFO-80');
    expect(planned.loadedMassKg).toBeCloseTo(86.625, 1);
    expect(planned.shortfallKg).toBe(0);
    expect(planned.violations).toEqual([]);
  });

  it('takes the stemming from the rules when none is given', () => {
    expect(planHole(dryHole, options).stemmingM).toBe(2.1);
  });

  it('honours a stemming length the designer set', () => {
    expect(planHole(dryHole, { ...options, stemmingM: 3 }).stemmingM).toBe(3);
  });

  it('switches to emulsion in a wet hole and gets there in less column', () => {
    const wet = planHole({ ...dryHole, condition: 'wet' }, options);
    const dry = planHole(dryHole, options);
    expect(wet.productCode).toBe('EM-115');
    expect(wet.column.chargeLengthM).toBeLessThan(dry.column.chargeLengthM);
  });

  it('loads the hole it was drilled to, not the one it was designed to', () => {
    const short = planHole({ ...dryHole, drilledDepthM: 14, designedDepthM: 16 }, options);
    expect(short.column.holeLengthM).toBe(14);
  });

  it('cuts the column back rather than eating the stemming', () => {
    const shallow = planHole(
      { ...dryHole, drilledDepthM: 8 },
      { ...options, powderFactorKgM3: 1.2 },
    );
    expect(shallow.column.stemmingM).toBe(2.1);
    expect(shallow.shortfallKg).toBeGreaterThan(0);
    expect(shallow.loadedMassKg).toBeLessThan(shallow.wantedMassKg);
  });

  it('refuses a hole with no room under the stemming at all', () => {
    expect(() => planHole({ ...dryHole, drilledDepthM: 2 }, options)).toThrow(RuleViolationError);
  });

  it('refuses a hole nobody has drilled', () => {
    expect(() =>
      planHole({ ...dryHole, drilledDepthM: null, designedDepthM: null }, options),
    ).toThrow(/no depth to load/);
  });

  it('refuses to fill a column with a booster', () => {
    const booster = parseProduct({
      code: 'BST-400',
      name: 'Cast booster',
      kind: 'booster',
      unitMassKg: 0.4,
    });
    expect(() => planHole(dryHole, { ...options, product: booster })).toThrow(
      /cannot fill a column/,
    );
  });

  it('takes a mass the designer set instead of a powder factor', () => {
    const planned = planHole(dryHole, { ...options, massKg: 60 });
    expect(planned.wantedMassKg).toBe(60);
    expect(planned.loadedMassKg).toBeCloseTo(60, 1);
  });
});

describe('planPattern', () => {
  const holes = [1, 2, 3, 4].map((holeNumber) => ({ ...dryHole, holeNumber }));

  it('plans every hole', () => {
    const plan = planPattern(holes, options);
    expect(plan.holes).toHaveLength(4);
    expect(plan.valid).toBe(true);
  });

  it('adds the charge up and reports the powder factor it achieved', () => {
    const plan = planPattern(holes, options);
    expect(plan.totalMassKg).toBeCloseTo(346.5, 0);
    expect(plan.achievedPowderFactorKgM3).toBeCloseTo(0.55, 2);
  });

  it('groups the total by product', () => {
    const mixed = [holes[0], { ...holes[1], condition: 'wet' }];
    const plan = planPattern(mixed, options);
    expect(Object.keys(plan.byProduct).sort()).toEqual(['ANFO-80', 'EM-115']);
  });

  it('skips a collapsed hole instead of failing the whole pattern', () => {
    const plan = planPattern([holes[0], { ...holes[1], condition: 'collapsed' }], options);
    expect(plan.holes).toHaveLength(1);
    expect(plan.skipped).toEqual([{ holeNumber: 2, reason: 'collapsed' }]);
  });

  it('carries the violations up from the holes', () => {
    const plan = planPattern(holes, { ...options, stemmingM: 1 });
    expect(plan.valid).toBe(false);
    expect(plan.violations.length).toBe(4);
  });

  it('refuses an empty pattern', () => {
    expect(() => planPattern([], options)).toThrow(/no holes to load/);
  });
});

describe('loadSheet', () => {
  it('writes a line per hole for the crew', () => {
    const plan = planPattern([dryHole], options);
    expect(loadSheet(plan)[0]).toMatchObject({
      hole: 1,
      product: 'ANFO-80',
      stemming_m: 2.1,
      boosters: 1,
    });
  });
});
