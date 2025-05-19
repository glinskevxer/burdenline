import { describe, it, expect } from 'vitest';
import {
  scaledDistance,
  predictPeakParticleVelocity,
  chargeForLimit,
  fitSiteLaw,
  upperBound,
  extrapolation,
  SCALING,
} from '../../../src/domain/vibration/site-law.js';
import { ValidationError } from '../../../src/lib/errors.js';

describe('scaledDistance', () => {
  it('divides distance by the square root of the charge', () => {
    expect(scaledDistance({ distanceM: 300, chargeKg: 100 })).toBe(30);
  });

  it('takes the cube root when a site works that way', () => {
    expect(scaledDistance({ distanceM: 300, chargeKg: 125, scaling: 'cube_root' })).toBe(60);
  });

  it('refuses a shot with no charge or no distance', () => {
    expect(() => scaledDistance({ distanceM: 0, chargeKg: 100 })).toThrow(ValidationError);
    expect(() => scaledDistance({ distanceM: 300, chargeKg: 0 })).toThrow(ValidationError);
  });

  it('refuses a scaling convention nobody uses', () => {
    expect(() => scaledDistance({ distanceM: 300, chargeKg: 100, scaling: 'linear' })).toThrow(
      ValidationError,
    );
  });

  it('lists the conventions it knows', () => {
    expect(SCALING).toEqual(['square_root', 'cube_root']);
  });
});

describe('predictPeakParticleVelocity', () => {
  it('follows the power law', () => {
    expect(
      predictPeakParticleVelocity({ k: 1140, b: 1.6, distanceM: 300, chargeKg: 100 }),
    ).toBeCloseTo(1140 * 30 ** -1.6, 3);
  });

  it('falls as the distance grows', () => {
    const near = predictPeakParticleVelocity({ k: 1140, b: 1.6, distanceM: 200, chargeKg: 100 });
    const far = predictPeakParticleVelocity({ k: 1140, b: 1.6, distanceM: 600, chargeKg: 100 });
    expect(far).toBeLessThan(near);
  });

  it('rises with the instantaneous charge', () => {
    const light = predictPeakParticleVelocity({ k: 1140, b: 1.6, distanceM: 300, chargeKg: 50 });
    const heavy = predictPeakParticleVelocity({ k: 1140, b: 1.6, distanceM: 300, chargeKg: 200 });
    expect(heavy).toBeGreaterThan(light);
  });

  it('refuses constants that are not positive', () => {
    expect(() =>
      predictPeakParticleVelocity({ k: 0, b: 1.6, distanceM: 300, chargeKg: 100 }),
    ).toThrow(ValidationError);
  });
});

describe('chargeForLimit', () => {
  it('is the inverse of the prediction', () => {
    const charge = chargeForLimit({ k: 1140, b: 1.6, distanceM: 300, limitMmPerSecond: 6 });
    expect(
      predictPeakParticleVelocity({ k: 1140, b: 1.6, distanceM: 300, chargeKg: charge }),
    ).toBeCloseTo(6, 2);
  });

  it('allows more charge further away', () => {
    const near = chargeForLimit({ k: 1140, b: 1.6, distanceM: 200, limitMmPerSecond: 6 });
    const far = chargeForLimit({ k: 1140, b: 1.6, distanceM: 800, limitMmPerSecond: 6 });
    expect(far).toBeGreaterThan(near);
  });

  it('allows more charge under a looser limit', () => {
    const tight = chargeForLimit({ k: 1140, b: 1.6, distanceM: 300, limitMmPerSecond: 3 });
    const loose = chargeForLimit({ k: 1140, b: 1.6, distanceM: 300, limitMmPerSecond: 12 });
    expect(loose).toBeGreaterThan(tight);
  });

  it('works the cube root convention too', () => {
    const charge = chargeForLimit({
      k: 1140,
      b: 1.6,
      distanceM: 300,
      limitMmPerSecond: 6,
      scaling: 'cube_root',
    });
    expect(
      predictPeakParticleVelocity({
        k: 1140,
        b: 1.6,
        distanceM: 300,
        chargeKg: charge,
        scaling: 'cube_root',
      }),
    ).toBeCloseTo(6, 2);
  });
});

describe('fitSiteLaw', () => {
  /** Records generated from a known law, so the fit has a right answer. */
  function syntheticRecords(k, b, count = 12) {
    return Array.from({ length: count }, (_unused, index) => {
      const distanceM = 150 + index * 60;
      const chargeKg = 40 + index * 12;
      const sd = distanceM / Math.sqrt(chargeKg);
      return { distanceM, chargeKg, peakMmPerSecond: k * sd ** -b };
    });
  }

  it('recovers the constants it was generated from', () => {
    const fit = fitSiteLaw(syntheticRecords(1140, 1.6));
    expect(fit.k).toBeCloseTo(1140, 0);
    expect(fit.b).toBeCloseTo(1.6, 3);
    expect(fit.rSquared).toBeCloseTo(1, 4);
  });

  it('reports how many records it used and the spread behind them', () => {
    const fit = fitSiteLaw(syntheticRecords(1140, 1.6));
    expect(fit.recordCount).toBe(12);
    expect(fit.scaledDistanceRange.low).toBeLessThan(fit.scaledDistanceRange.high);
  });

  it('drops a record with no reading rather than fudging the logarithm', () => {
    const records = [
      ...syntheticRecords(1140, 1.6),
      { distanceM: 400, chargeKg: 80, peakMmPerSecond: 0 },
    ];
    const fit = fitSiteLaw(records);
    expect(fit.droppedRecords).toBe(1);
    expect(fit.recordCount).toBe(12);
  });

  it('refuses to fit from a handful of records', () => {
    expect(() => fitSiteLaw(syntheticRecords(1140, 1.6, 4))).toThrow(/not enough records/);
  });

  it('refuses a set with no spread of scaled distance', () => {
    const flat = Array.from({ length: 8 }, () => ({
      distanceM: 300,
      chargeKg: 100,
      peakMmPerSecond: 4,
    }));
    expect(() => fitSiteLaw(flat)).toThrow(/same scaled distance/);
  });

  it('reports a poorer fit for scattered records', () => {
    const noisy = syntheticRecords(1140, 1.6).map((record, index) => ({
      ...record,
      peakMmPerSecond: record.peakMmPerSecond * (index % 2 === 0 ? 1.8 : 0.55),
    }));
    const fit = fitSiteLaw(noisy);
    expect(fit.rSquared).toBeLessThan(0.9);
    expect(fit.residualStandardError).toBeGreaterThan(0);
  });

  it('takes a site that works in cube root scaling', () => {
    const fit = fitSiteLaw(syntheticRecords(1140, 1.6), { scaling: 'cube_root' });
    expect(fit.scaling).toBe('cube_root');
  });
});

describe('upperBound', () => {
  const scattered = Array.from({ length: 14 }, (_unused, index) => {
    const distanceM = 150 + index * 50;
    const chargeKg = 50 + index * 10;
    const sd = distanceM / Math.sqrt(chargeKg);
    return {
      distanceM,
      chargeKg,
      peakMmPerSecond: 1140 * sd ** -1.6 * (index % 2 === 0 ? 1.5 : 0.7),
    };
  });

  it('lifts the constant above the mean line', () => {
    const fit = fitSiteLaw(scattered);
    expect(upperBound(fit).k).toBeGreaterThan(fit.k);
  });

  it('lifts it further at higher confidence', () => {
    const fit = fitSiteLaw(scattered);
    expect(upperBound(fit, 0.99).k).toBeGreaterThan(upperBound(fit, 0.9).k);
  });

  it('leaves the mean alone at fifty percent', () => {
    const fit = fitSiteLaw(scattered);
    expect(upperBound(fit, 0.5).k).toBe(fit.k);
  });

  it('keeps the exponent, which the scatter does not move', () => {
    const fit = fitSiteLaw(scattered);
    expect(upperBound(fit).b).toBe(fit.b);
    expect(upperBound(fit).isUpperBound).toBe(true);
  });

  it('refuses a confidence it has no factor for', () => {
    expect(() => upperBound(fitSiteLaw(scattered), 0.975)).toThrow(ValidationError);
  });
});

describe('extrapolation', () => {
  const fit = { scaledDistanceRange: { low: 20, high: 80 } };

  it('says nothing about a prediction inside the data', () => {
    expect(extrapolation(fit, 40)).toEqual({ extrapolating: false, factor: 1 });
  });

  it('reports how far past the near end it is reaching', () => {
    expect(extrapolation(fit, 10)).toEqual({ extrapolating: true, factor: 2 });
  });

  it('reports how far past the far end it is reaching', () => {
    expect(extrapolation(fit, 160)).toEqual({ extrapolating: true, factor: 2 });
  });

  it('says nothing when the law was handed over without its data range', () => {
    expect(extrapolation({ k: 1140, b: 1.6 }, 40)).toEqual({
      extrapolating: false,
      factor: 1,
      unknown: true,
    });
  });
});
