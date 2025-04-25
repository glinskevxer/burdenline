import { describe, it, expect } from 'vitest';
import {
  withScatter,
  percentageScatter,
  fixedScatter,
  worstCaseCharge,
  simulateCharge,
  chargeExposure,
} from '../../../src/domain/initiation/scatter.js';
import { maximumInstantaneousCharge } from '../../../src/domain/initiation/windows.js';
import { ValidationError } from '../../../src/lib/errors.js';

/** Five holes twenty five milliseconds apart, eighty kilograms in each. */
const events = Array.from({ length: 5 }, (_unused, index) => ({
  holeNumber: index + 1,
  deck: 1,
  firingTimeMs: 500 + index * 25,
  inHoleDelayMs: 500,
  massKg: 80,
}));

describe('withScatter', () => {
  it('puts a window around each event', () => {
    const scattered = withScatter(events, fixedScatter(15));
    expect(scattered[0]).toMatchObject({ earliestMs: 485, latestMs: 515, scatterMs: 15 });
  });

  it('reads a percentage against the in hole delay', () => {
    const scattered = withScatter(events, percentageScatter(3));
    expect(scattered[0].scatterMs).toBe(15);
    expect(scattered[4].scatterMs).toBe(15);
  });

  it('falls back to the firing time when there is no in hole delay', () => {
    const scattered = withScatter(
      [{ holeNumber: 1, firingTimeMs: 200, massKg: 10 }],
      percentageScatter(5),
    );
    expect(scattered[0].scatterMs).toBe(10);
  });

  it('refuses an event with no scatter figure', () => {
    expect(() => withScatter(events, () => undefined)).toThrow(ValidationError);
  });
});

describe('worstCaseCharge', () => {
  it('matches the nominal charge when nothing scatters', () => {
    const scattered = withScatter(events, fixedScatter(0));
    expect(worstCaseCharge(scattered).massKg).toBe(maximumInstantaneousCharge(events).massKg);
  });

  it('gathers holes whose windows can overlap', () => {
    const scattered = withScatter(events, fixedScatter(15));
    expect(worstCaseCharge(scattered).massKg).toBeGreaterThan(80);
  });

  it('grows with the scatter', () => {
    const light = worstCaseCharge(withScatter(events, fixedScatter(5))).massKg;
    const heavy = worstCaseCharge(withScatter(events, fixedScatter(40))).massKg;
    expect(heavy).toBeGreaterThan(light);
  });

  it('can put the whole shot in one window when the scatter is wide enough', () => {
    const scattered = withScatter(events, fixedScatter(200));
    expect(worstCaseCharge(scattered).massKg).toBe(400);
  });

  it('names when the worst window starts and what is in it', () => {
    const worst = worstCaseCharge(withScatter(events, fixedScatter(15)));
    expect(typeof worst.atMs).toBe('number');
    expect(worst.events.length).toBeGreaterThan(1);
  });

  it('reads an empty shot as nothing', () => {
    expect(worstCaseCharge([])).toEqual({ massKg: 0, atMs: null, events: [] });
  });
});

describe('simulateCharge', () => {
  const scattered = withScatter(events, fixedScatter(15));

  it('repeats exactly for a given seed', () => {
    const first = simulateCharge(scattered, { runs: 300, seed: 42 });
    const second = simulateCharge(scattered, { runs: 300, seed: 42 });
    expect(first).toEqual(second);
  });

  it('moves when the seed does', () => {
    const first = simulateCharge(scattered, { runs: 300, seed: 42 });
    const second = simulateCharge(scattered, { runs: 300, seed: 43 });
    expect(first.meanKg).not.toBe(second.meanKg);
  });

  it('never exceeds the bound', () => {
    const bound = worstCaseCharge(scattered).massKg;
    expect(simulateCharge(scattered, { runs: 500 }).maximumKg).toBeLessThanOrEqual(bound);
  });

  it('is never below the charge of a single hole', () => {
    expect(simulateCharge(scattered, { runs: 200 }).minimumKg).toBeGreaterThanOrEqual(80);
  });

  it('orders its percentiles', () => {
    const result = simulateCharge(scattered, { runs: 1000 });
    expect(result.medianKg).toBeLessThanOrEqual(result.p95Kg);
    expect(result.p95Kg).toBeLessThanOrEqual(result.p99Kg);
    expect(result.p99Kg).toBeLessThanOrEqual(result.maximumKg);
  });

  it('refuses a silly number of runs', () => {
    expect(() => simulateCharge(scattered, { runs: 0 })).toThrow(ValidationError);
    expect(() => simulateCharge(scattered, { runs: 1e6 })).toThrow(ValidationError);
  });
});

describe('chargeExposure', () => {
  it('puts the three readings side by side', () => {
    const exposure = chargeExposure(events, percentageScatter(3), { runs: 400 });
    expect(exposure.nominalKg).toBe(80);
    expect(exposure.boundKg).toBeGreaterThanOrEqual(exposure.nominalKg);
    expect(exposure.likelyKg).toBeLessThanOrEqual(exposure.boundKg);
    expect(exposure.boundExceedsNominalBy).toBe(exposure.boundKg - exposure.nominalKg);
  });

  it('shows electronic detonators leaving the nominal charge alone', () => {
    const exposure = chargeExposure(events, fixedScatter(1), { runs: 400 });
    expect(exposure.boundKg).toBe(80);
    expect(exposure.simulated.maximumKg).toBe(80);
  });
});
