import { describe, it, expect } from 'vitest';
import {
  observedOversizeFraction,
  predictedOversizeFraction,
  fitRockFactor,
  compareToActual,
  DEFAULT_FIT_OPTIONS,
} from '../../../src/domain/postblast/fragmentation-fit.js';
import { ValidationError } from '../../../src/lib/errors.js';

const design = {
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

/** A run of shots generated from a known rock factor, so the fit has an answer. */
function runOfShots(rockFactorA, count = 8) {
  return Array.from({ length: count }, (_unused, index) => {
    const holeCount = 24;
    const fraction = predictedOversizeFraction(design, rockFactorA);
    return {
      blastId: `blast_${index + 1}`,
      design,
      holeCount,
      oversizeCount: Math.round(fraction * holeCount * 4),
    };
  });
}

describe('observedOversizeFraction', () => {
  it('reads a boulder count against the holes that made it', () => {
    expect(observedOversizeFraction({ oversizeCount: 12, holeCount: 24 })).toBeCloseTo(0.125, 4);
  });

  it('caps at everything being oversize', () => {
    expect(observedOversizeFraction({ oversizeCount: 500, holeCount: 24 })).toBe(1);
  });

  it('follows the site own idea of what a boulder is', () => {
    const strict = observedOversizeFraction({
      oversizeCount: 12,
      holeCount: 24,
      bouldersPerHoleAtOne: 2,
    });
    expect(strict).toBeCloseTo(0.25, 4);
  });

  it('refuses a negative count and a shot with no holes', () => {
    expect(() => observedOversizeFraction({ oversizeCount: -1, holeCount: 24 })).toThrow(
      ValidationError,
    );
    expect(() => observedOversizeFraction({ oversizeCount: 1, holeCount: 0 })).toThrow(
      ValidationError,
    );
  });
});

describe('fitRockFactor', () => {
  it('recovers the factor a run of shots was generated from', () => {
    const fit = fitRockFactor(runOfShots(9));
    expect(fit.rockFactorA).toBeGreaterThan(7.5);
    expect(fit.rockFactorA).toBeLessThan(10.5);
    expect(fit.shots).toBe(8);
  });

  it('finds a higher factor for a coarser run', () => {
    const soft = fitRockFactor(runOfShots(8));
    const hard = fitRockFactor(runOfShots(13));
    expect(hard.rockFactorA).toBeGreaterThan(soft.rockFactorA);
  });

  it('calls a consistent run trustworthy', () => {
    expect(fitRockFactor(runOfShots(9)).trustworthy).toBe(true);
  });

  it('refuses a handful of shots', () => {
    expect(() => fitRockFactor(runOfShots(9, 3))).toThrow(/not enough shots/);
  });

  it('refuses a run with no oversize in it at all', () => {
    const clean = runOfShots(9).map((shot) => ({ ...shot, oversizeCount: 0 }));
    expect(() => fitRockFactor(clean)).toThrow(/no oversize at all/);
  });

  it('leaves a shot with no inspection out of the fit', () => {
    const shots = [...runOfShots(9), { blastId: 'blast_x', design, holeCount: 24 }];
    expect(fitRockFactor(shots).shots).toBe(8);
  });

  it('reports what it predicted against what was counted, shot by shot', () => {
    const fit = fitRockFactor(runOfShots(9));
    expect(fit.observed).toHaveLength(8);
    expect(fit.observed[0]).toHaveProperty('residual');
    expect(fit.observed[0].blastId).toBe('blast_1');
  });

  it('follows a wider search range when it is given one', () => {
    const fit = fitRockFactor(runOfShots(9), { ...DEFAULT_FIT_OPTIONS, highestRockFactor: 8 });
    expect(fit.rockFactorA).toBeLessThanOrEqual(8);
  });
});

describe('compareToActual', () => {
  it('calls a shot that came out as predicted as predicted', () => {
    const fraction = predictedOversizeFraction(design, 9);
    const comparison = compareToActual({
      design,
      rockFactorA: 9,
      holeCount: 24,
      oversizeCount: Math.round(fraction * 24 * 4),
    });
    expect(comparison.verdict).toBe('as_predicted');
  });

  it('calls a shot with far more boulders coarser than predicted', () => {
    const comparison = compareToActual({
      design,
      rockFactorA: 5,
      holeCount: 24,
      oversizeCount: 60,
    });
    expect(comparison.verdict).toBe('coarser_than_predicted');
    expect(comparison.difference).toBeGreaterThan(0);
  });

  it('calls a clean muckpile finer than predicted', () => {
    const comparison = compareToActual({
      design,
      rockFactorA: 14,
      holeCount: 24,
      oversizeCount: 0,
    });
    expect(comparison.verdict).toBe('finer_than_predicted');
  });

  it('carries the mean size and the curve reading beside the verdict', () => {
    const comparison = compareToActual({
      design,
      rockFactorA: 9,
      holeCount: 24,
      oversizeCount: 10,
    });
    expect(comparison.meanCm).toBeGreaterThan(0);
    expect(comparison.passingAtOversize).toBeGreaterThan(0.5);
    expect(comparison.uniformity).toBeGreaterThan(0);
  });
});
