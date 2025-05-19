import { describe, it, expect } from 'vitest';
import {
  designLimit,
  allowanceForReceptor,
  bindingReceptor,
  allowances,
  assessDesign,
  reduction,
} from '../../../src/domain/vibration/allowance.js';
import { parseReceptor } from '../../../src/domain/receptors/registry.js';
import { ValidationError } from '../../../src/lib/errors.js';

const fit = { k: 1140, b: 1.6, scaling: 'square_root' };

const cottage = parseReceptor({
  id: 'rec_1',
  name: 'Keeper cottage',
  structureClass: 'older_dwelling',
  easting: 1200,
  northing: 2000,
});

const church = parseReceptor({
  id: 'rec_2',
  name: 'Saint Brendan church',
  structureClass: 'listed',
  easting: 1600,
  northing: 2000,
});

const depot = parseReceptor({
  id: 'rec_3',
  name: 'Council depot',
  structureClass: 'commercial',
  easting: 1300,
  northing: 2000,
  limitMmPerSecond: 20,
});

describe('designLimit', () => {
  it('takes a licence limit as read', () => {
    const limit = designLimit(depot);
    expect(limit).toMatchObject({ limitMmPerSecond: 20, basis: 'licence' });
  });

  it('reads the curve at the frequency the site usually sees', () => {
    const limit = designLimit(cottage, { frequencyHz: 20 });
    expect(limit.basis).toBe('assumed_frequency');
    expect(limit.limitMmPerSecond).toBeGreaterThan(12.7);
  });

  it('falls back to the floor of the curve when nothing is known', () => {
    const limit = designLimit(cottage);
    expect(limit.basis).toBe('curve_floor');
    expect(limit.limitMmPerSecond).toBe(3.4);
  });

  it('takes a frequency carried on the receptor itself', () => {
    const limit = designLimit({ ...cottage, typicalFrequencyHz: 12 });
    expect(limit.basis).toBe('assumed_frequency');
    expect(limit.frequencyHz).toBe(12);
  });
});

describe('allowanceForReceptor', () => {
  it('works the charge back from the limit', () => {
    const allowance = allowanceForReceptor({
      fit,
      receptor: cottage,
      distanceM: 300,
      frequencyHz: 20,
    });
    expect(allowance.allowanceKg).toBeGreaterThan(0);
    expect(allowance.receptorId).toBe('rec_1');
  });

  it('allows more charge further away', () => {
    const near = allowanceForReceptor({ fit, receptor: cottage, distanceM: 200, frequencyHz: 20 });
    const far = allowanceForReceptor({ fit, receptor: cottage, distanceM: 800, frequencyHz: 20 });
    expect(far.allowanceKg).toBeGreaterThan(near.allowanceKg);
  });

  it('allows less under a tighter limit', () => {
    const listed = allowanceForReceptor({ fit, receptor: church, distanceM: 300, frequencyHz: 20 });
    const dwelling = allowanceForReceptor({
      fit,
      receptor: cottage,
      distanceM: 300,
      frequencyHz: 20,
    });
    expect(listed.allowanceKg).toBeLessThan(dwelling.allowanceKg);
  });

  it('cuts the allowance by a safety factor', () => {
    const full = allowanceForReceptor({ fit, receptor: cottage, distanceM: 300, frequencyHz: 20 });
    const held = allowanceForReceptor({
      fit,
      receptor: cottage,
      distanceM: 300,
      frequencyHz: 20,
      safetyFactor: 0.75,
    });
    expect(held.allowanceKg).toBeLessThan(full.allowanceKg);
    expect(held.targetMmPerSecond).toBeCloseTo(full.limitMmPerSecond * 0.75, 4);
  });

  it('refuses a safety factor above one', () => {
    expect(() =>
      allowanceForReceptor({ fit, receptor: cottage, distanceM: 300, safetyFactor: 1.2 }),
    ).toThrow(ValidationError);
  });
});

describe('bindingReceptor', () => {
  const receptorsWithDistance = [
    { receptor: cottage, distanceM: 300 },
    { receptor: church, distanceM: 600 },
    { receptor: depot, distanceM: 320 },
  ];

  it('finds the tightest allowance in the set', () => {
    const set = allowances({ fit, receptorsWithDistance, frequencyHz: 20 });
    expect(set.binding.receptorId).toBe(set.allowances[0].receptorId);
  });

  it('is not always the closest receptor', () => {
    const set = allowances({ fit, receptorsWithDistance, frequencyHz: 20 });
    expect(set.binding.receptorId).toBe('rec_2');
  });

  it('has no answer for an empty set', () => {
    expect(bindingReceptor([])).toBe(null);
  });

  it('sorts the allowances from tightest out', () => {
    const set = allowances({ fit, receptorsWithDistance, frequencyHz: 20 });
    const values = set.allowances.map((allowance) => allowance.allowanceKg);
    expect([...values].sort((a, b) => a - b)).toEqual(values);
  });
});

describe('assessDesign', () => {
  const receptorsWithDistance = [
    { receptor: cottage, distanceM: 400 },
    { receptor: church, distanceM: 900 },
  ];

  it('passes a light shot', () => {
    const assessment = assessDesign({
      fit,
      receptorsWithDistance,
      instantaneousChargeKg: 20,
      frequencyHz: 25,
    });
    expect(assessment.compliant).toBe(true);
    expect(assessment.failing).toEqual([]);
  });

  it('fails a heavy one and names who it failed at', () => {
    const assessment = assessDesign({
      fit,
      receptorsWithDistance,
      instantaneousChargeKg: 2500,
      frequencyHz: 25,
    });
    expect(assessment.compliant).toBe(false);
    expect(assessment.failing).toHaveLength(2);
    expect(assessment.worst.ratio).toBeGreaterThan(1);
  });

  it('sorts the results by how close they are to the limit', () => {
    const assessment = assessDesign({
      fit,
      receptorsWithDistance,
      instantaneousChargeKg: 100,
      frequencyHz: 25,
    });
    expect(assessment.results[0].ratio).toBeGreaterThanOrEqual(assessment.results[1].ratio);
  });

  it('carries the scaled distance and the basis of every limit', () => {
    const assessment = assessDesign({
      fit,
      receptorsWithDistance,
      instantaneousChargeKg: 100,
    });
    expect(assessment.results[0].scaledDistance).toBeGreaterThan(0);
    expect(assessment.results[0].basis).toBe('curve_floor');
  });

  it('flags a prediction made outside the data the law was fitted to', () => {
    const narrow = { ...fit, scaledDistanceRange: { low: 20, high: 30 } };
    const assessment = assessDesign({
      fit: narrow,
      receptorsWithDistance,
      instantaneousChargeKg: 5,
      frequencyHz: 25,
    });
    expect(assessment.extrapolatingCount).toBeGreaterThan(0);
  });

  it('refuses a shot with no charge in it', () => {
    expect(() => assessDesign({ fit, receptorsWithDistance, instantaneousChargeKg: 0 })).toThrow(
      ValidationError,
    );
  });
});

describe('reduction', () => {
  const receptorsWithDistance = [{ receptor: cottage, distanceM: 400 }];

  it('says nothing has to change when the shot fits', () => {
    const assessment = assessDesign({
      fit,
      receptorsWithDistance,
      instantaneousChargeKg: 20,
      frequencyHz: 25,
    });
    const set = allowances({ fit, receptorsWithDistance, frequencyHz: 25 });
    expect(reduction(assessment, set)).toMatchObject({ needed: false, factor: 1 });
  });

  it('says how far the charge has to come down and why', () => {
    const assessment = assessDesign({
      fit,
      receptorsWithDistance,
      instantaneousChargeKg: 3000,
      frequencyHz: 25,
    });
    const set = allowances({ fit, receptorsWithDistance, frequencyHz: 25 });
    const cut = reduction(assessment, set);
    expect(cut.needed).toBe(true);
    expect(cut.factor).toBeLessThan(1);
    expect(cut.becauseOf).toBe('Keeper cottage');
  });
});
