import { describe, it, expect } from 'vitest';
import {
  cubeRootScaledDistance,
  predictAirblastDb,
  weatherCorrectionDb,
  predictWithWeather,
  confinementPenaltyDb,
  assessAirblast,
  chargeForAirblastLimit,
  decibelsFromPascals,
  AIRBLAST_LIMITS,
  DEFAULT_AIRBLAST_LAW,
} from '../../../src/domain/vibration/airblast.js';
import { ValidationError } from '../../../src/lib/errors.js';

describe('cubeRootScaledDistance', () => {
  it('divides distance by the cube root of the charge', () => {
    expect(cubeRootScaledDistance({ distanceM: 400, chargeKg: 125 })).toBe(80);
  });

  it('refuses a shot with no charge', () => {
    expect(() => cubeRootScaledDistance({ distanceM: 400, chargeKg: 0 })).toThrow(ValidationError);
  });
});

describe('predictAirblastDb', () => {
  it('falls with the scaled distance', () => {
    const near = predictAirblastDb({ distanceM: 200, chargeKg: 100 });
    const far = predictAirblastDb({ distanceM: 800, chargeKg: 100 });
    expect(far).toBeLessThan(near);
  });

  it('rises with the charge', () => {
    const light = predictAirblastDb({ distanceM: 400, chargeKg: 50 });
    const heavy = predictAirblastDb({ distanceM: 400, chargeKg: 500 });
    expect(heavy).toBeGreaterThan(light);
  });

  it('follows the law it is given', () => {
    const steeper = predictAirblastDb({ distanceM: 400, chargeKg: 100, law: { a: 165, b: 30 } });
    expect(steeper).toBeLessThan(predictAirblastDb({ distanceM: 400, chargeKg: 100 }));
  });

  it('publishes the law it defaults to', () => {
    expect(DEFAULT_AIRBLAST_LAW).toEqual({ a: 165, b: 24 });
    expect(Object.isFrozen(DEFAULT_AIRBLAST_LAW)).toBe(true);
  });
});

describe('weatherCorrectionDb', () => {
  it('adds nothing on a still clear day', () => {
    expect(weatherCorrectionDb({}).totalDb).toBe(0);
  });

  it('adds for a receptor straight downwind', () => {
    const correction = weatherCorrectionDb({
      windSpeedMs: 8,
      windBearingDeg: 90,
      receptorBearingDeg: 90,
    });
    expect(correction.windDb).toBeCloseTo(4.8, 2);
    expect(correction.alignment).toBe(1);
  });

  it('takes away for a receptor upwind', () => {
    const correction = weatherCorrectionDb({
      windSpeedMs: 8,
      windBearingDeg: 90,
      receptorBearingDeg: 270,
    });
    expect(correction.windDb).toBeCloseTo(-4.8, 2);
  });

  it('does almost nothing across the wind', () => {
    const correction = weatherCorrectionDb({
      windSpeedMs: 8,
      windBearingDeg: 90,
      receptorBearingDeg: 180,
    });
    expect(Math.abs(correction.windDb)).toBeLessThan(0.01);
  });

  it('adds a fixed penalty under an inversion', () => {
    expect(weatherCorrectionDb({ inversion: true }).inversionDb).toBe(6);
  });

  it('adds a little under low cloud', () => {
    expect(weatherCorrectionDb({ cloudBase: 150 }).lowCloudDb).toBe(2);
    expect(weatherCorrectionDb({ cloudBase: 900 }).lowCloudDb).toBe(0);
  });

  it('stacks the corrections', () => {
    const correction = weatherCorrectionDb({
      windSpeedMs: 5,
      windBearingDeg: 0,
      receptorBearingDeg: 0,
      inversion: true,
      cloudBase: 200,
    });
    expect(correction.totalDb).toBeCloseTo(3 + 6 + 2, 2);
  });

  it('refuses a negative wind speed', () => {
    expect(() => weatherCorrectionDb({ windSpeedMs: -3 })).toThrow(ValidationError);
  });
});

describe('predictWithWeather', () => {
  it('adds the correction to the base prediction', () => {
    const result = predictWithWeather({
      distanceM: 400,
      chargeKg: 100,
      weather: { inversion: true },
    });
    expect(result.predictedDb).toBeCloseTo(result.baseDb + 6, 2);
    expect(result.correction.inversionDb).toBe(6);
  });
});

describe('confinementPenaltyDb', () => {
  it('is nothing for a properly stemmed hole', () => {
    expect(confinementPenaltyDb({ stemmingRatio: 1 })).toBe(0);
  });

  it('is large for an exposed charge', () => {
    expect(confinementPenaltyDb({ exposedCharge: true })).toBe(20);
  });

  it('penalises cord left on the surface', () => {
    expect(confinementPenaltyDb({ detonatingCordOnSurface: true })).toBe(8);
  });

  it('grows as the stemming is cut back', () => {
    expect(confinementPenaltyDb({ stemmingRatio: 0.5 })).toBe(6);
    expect(confinementPenaltyDb({ stemmingRatio: 0 })).toBe(12);
  });

  it('adds the reasons together', () => {
    expect(confinementPenaltyDb({ stemmingRatio: 0.5, detonatingCordOnSurface: true })).toBe(14);
  });
});

describe('assessAirblast', () => {
  it('passes a quiet shot against the regulatory limit', () => {
    const result = assessAirblast({ predictedDb: 115, receptor: {} });
    expect(result.compliant).toBe(true);
    expect(result.limitDb).toBe(AIRBLAST_LIMITS.regulatory);
    expect(result.aboveRoutine).toBe(false);
  });

  it('flags a shot above the routine level but still legal', () => {
    const result = assessAirblast({ predictedDb: 128, receptor: {} });
    expect(result.compliant).toBe(true);
    expect(result.aboveRoutine).toBe(true);
  });

  it('fails a shot over a receptor own limit', () => {
    const result = assessAirblast({ predictedDb: 122, receptor: { airblastLimitDb: 120 } });
    expect(result.compliant).toBe(false);
    expect(result.marginDb).toBe(-2);
  });

  it('flags the level at which windows start to go', () => {
    expect(assessAirblast({ predictedDb: 145, receptor: {} }).windowRisk).toBe(true);
  });
});

describe('chargeForAirblastLimit', () => {
  it('is the inverse of the prediction', () => {
    const charge = chargeForAirblastLimit({ distanceM: 400, limitDb: 120 });
    expect(predictAirblastDb({ distanceM: 400, chargeKg: charge })).toBeCloseTo(120, 1);
  });

  it('allows less charge once the weather is against you', () => {
    const still = chargeForAirblastLimit({ distanceM: 400, limitDb: 120 });
    const windy = chargeForAirblastLimit({ distanceM: 400, limitDb: 120, correctionDb: 6 });
    expect(windy).toBeLessThan(still);
  });

  it('refuses a distance of zero', () => {
    expect(() => chargeForAirblastLimit({ distanceM: 0, limitDb: 120 })).toThrow(ValidationError);
  });
});

describe('decibelsFromPascals', () => {
  it('reads an old monitor in pascals', () => {
    expect(decibelsFromPascals(20)).toBeCloseTo(120, 1);
  });
});
