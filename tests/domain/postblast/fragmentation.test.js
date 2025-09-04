import { describe, it, expect } from 'vitest';
import {
  rockFactor,
  meanSizeCm,
  uniformityIndex,
  fractionPassing,
  sizeAtPassing,
  predict,
  compare,
  ROCK_FACTORS,
} from '../../../src/domain/postblast/fragmentation.js';
import { ValidationError } from '../../../src/lib/errors.js';

const design = {
  rockFactorA: 7,
  volumeM3: 157.5,
  chargeKg: 86.6,
  relativeWeightStrength: 100,
  burdenM: 3,
  spacingM: 3.5,
  diameterMm: 102,
  chargeLengthM: 13,
  benchHeightM: 15,
  oversizeCm: 80,
};

describe('rockFactor', () => {
  it('scores a jointed medium rock in the usual range', () => {
    const factor = rockFactor({ jointSpacingM: 0.5, densityKgM3: 2700, ucsMpa: 120 });
    expect(factor).toBeGreaterThan(4);
    expect(factor).toBeLessThan(14);
  });

  it('scores massive rock higher than closely jointed rock', () => {
    const massive = rockFactor({ jointSpacingM: 2, densityKgM3: 2900, ucsMpa: 200 });
    const jointed = rockFactor({ jointSpacingM: 0.05, densityKgM3: 2900, ucsMpa: 200 });
    expect(massive).toBeGreaterThan(jointed);
  });

  it('scores joints dipping into the face worst', () => {
    const into = rockFactor({
      jointSpacingM: 0.5,
      densityKgM3: 2700,
      jointOrientation: 'dipping_into_face',
    });
    const flat = rockFactor({
      jointSpacingM: 0.5,
      densityKgM3: 2700,
      jointOrientation: 'horizontal',
    });
    expect(into).toBeGreaterThan(flat);
  });

  it('refuses an orientation nobody logs', () => {
    expect(() =>
      rockFactor({ jointSpacingM: 1, densityKgM3: 2700, jointOrientation: 'sideways' }),
    ).toThrow(ValidationError);
  });

  it('publishes the typical factors for a quick estimate', () => {
    expect(ROCK_FACTORS.massive_hard).toBeGreaterThan(ROCK_FACTORS.weathered_soft);
  });
});

describe('meanSizeCm', () => {
  it('gives a mean size in the tens of centimetres for a production pattern', () => {
    const mean = meanSizeCm(design);
    expect(mean).toBeGreaterThan(5);
    expect(mean).toBeLessThan(80);
  });

  it('gets coarser in harder rock', () => {
    expect(meanSizeCm({ ...design, rockFactorA: 13 })).toBeGreaterThan(meanSizeCm(design));
  });

  it('gets finer with more charge in the same rock', () => {
    expect(meanSizeCm({ ...design, chargeKg: 130 })).toBeLessThan(meanSizeCm(design));
  });

  it('gets finer with a stronger explosive', () => {
    expect(meanSizeCm({ ...design, relativeWeightStrength: 140 })).toBeLessThan(meanSizeCm(design));
  });

  it('refuses a pattern with no charge in it', () => {
    expect(() => meanSizeCm({ ...design, chargeKg: 0 })).toThrow(ValidationError);
  });
});

describe('uniformityIndex', () => {
  it('lands in the range a production pattern gives', () => {
    const index = uniformityIndex(design);
    expect(index).toBeGreaterThan(0.5);
    expect(index).toBeLessThan(2.5);
  });

  it('falls as the drilling gets worse', () => {
    expect(uniformityIndex({ ...design, drillDeviationM: 0.5 })).toBeLessThan(
      uniformityIndex(design),
    );
  });

  it('rises with a wider spacing to burden ratio', () => {
    expect(uniformityIndex({ ...design, spacingM: 4.5 })).toBeGreaterThan(uniformityIndex(design));
  });

  it('falls when less of the hole is charged', () => {
    expect(uniformityIndex({ ...design, chargeLengthM: 8 })).toBeLessThan(uniformityIndex(design));
  });

  it('refuses a hole with no diameter', () => {
    expect(() => uniformityIndex({ ...design, diameterMm: 0 })).toThrow(ValidationError);
  });
});

describe('the size curve', () => {
  const meanCm = 30;
  const uniformity = 1.2;

  it('passes about half at the mean size', () => {
    expect(fractionPassing({ sizeCm: meanCm, meanCm, uniformity })).toBeCloseTo(0.5, 2);
  });

  it('passes more at a bigger screen', () => {
    expect(fractionPassing({ sizeCm: 60, meanCm, uniformity })).toBeGreaterThan(
      fractionPassing({ sizeCm: 20, meanCm, uniformity }),
    );
  });

  it('inverts back to the size', () => {
    const size = sizeAtPassing({ fraction: 0.8, meanCm, uniformity });
    expect(fractionPassing({ sizeCm: size, meanCm, uniformity })).toBeCloseTo(0.8, 3);
  });

  it('refuses a fraction outside the curve', () => {
    expect(() => sizeAtPassing({ fraction: 0, meanCm, uniformity })).toThrow(ValidationError);
    expect(() => sizeAtPassing({ fraction: 1, meanCm, uniformity })).toThrow(ValidationError);
  });

  it('spreads wider at a low uniformity', () => {
    const loose = sizeAtPassing({ fraction: 0.9, meanCm, uniformity: 0.7 });
    const tight = sizeAtPassing({ fraction: 0.9, meanCm, uniformity: 2 });
    expect(loose).toBeGreaterThan(tight);
  });
});

describe('predict', () => {
  it('gives a curve and the numbers a quarry watches', () => {
    const prediction = predict(design);
    expect(prediction.curve).toHaveLength(7);
    expect(prediction.p20Cm).toBeLessThan(prediction.p80Cm);
    expect(prediction.oversizeFraction).toBeGreaterThanOrEqual(0);
    expect(prediction.finesFraction).toBeGreaterThan(0);
  });

  it('rises monotonically through the screens', () => {
    const passing = predict(design).curve.map((point) => point.passing);
    for (let index = 1; index < passing.length; index += 1) {
      expect(passing[index]).toBeGreaterThanOrEqual(passing[index - 1]);
    }
  });

  it('has no oversize number when nobody said what oversize is', () => {
    expect(predict({ ...design, oversizeCm: null }).oversizeFraction).toBe(null);
  });
});

describe('compare', () => {
  it('shows a tighter pattern making less oversize', () => {
    const result = compare(design, { burdenM: 2.6, volumeM3: 136.5 });
    expect(result.better).toBe(true);
    expect(result.oversizeChange).toBeLessThan(0);
  });

  it('shows a looser pattern making more', () => {
    const result = compare(design, { burdenM: 3.6, volumeM3: 189 });
    expect(result.better).toBe(false);
    expect(result.meanChangeCm).toBeGreaterThan(0);
  });
});
