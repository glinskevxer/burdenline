/**
 * What the scatter does to the instantaneous charge.
 *
 * The maximum instantaneous charge worked out from the nominal times is the best
 * case. A pyrotechnic in-hole delay quoted at 500 ms with three percent scatter
 * fires somewhere in a thirty millisecond window, so holes designed twenty five
 * milliseconds apart can and do arrive together. Two readings are produced here
 * and they answer different questions. The bound is the worst that is physically
 * possible and it is what a licence condition should be checked against. The
 * simulation says how likely anything near that is, which is what a designer
 * needs when the bound says the shot is impossible and the shot has been fired
 * that way for years.
 */

import { ValidationError } from '../../lib/errors.js';
import { roundTo } from '../../lib/units.js';
import { createRandom, percentile } from '../../lib/random.js';
import { maximumInstantaneousCharge, DEFAULT_WINDOW_MS } from './windows.js';

/** Put a firing window around every charge event from its detonator scatter. */
export function withScatter(events, scatterFor) {
  return events.map((event) => {
    const scatter = scatterFor(event);
    if (!(scatter >= 0)) {
      throw new ValidationError(`hole ${event.holeNumber} has no scatter figure`, [
        { path: 'scatter', message: 'expected a scatter in milliseconds', kind: 'missing' },
      ]);
    }
    return {
      ...event,
      scatterMs: roundTo(scatter, 3),
      earliestMs: roundTo(event.firingTimeMs - scatter, 3),
      latestMs: roundTo(event.firingTimeMs + scatter, 3),
    };
  });
}

/** Scatter as a percentage of the in-hole delay, which is how pyrotechnics are quoted. */
export function percentageScatter(percent) {
  return (event) => ((event.inHoleDelayMs ?? event.firingTimeMs) * percent) / 100;
}

export function fixedScatter(milliseconds) {
  return () => milliseconds;
}

/**
 * The heaviest charge that could arrive inside one window if every element
 * fired at the worst moment for us. Every event window start is a candidate,
 * because the worst case always begins at the edge of some event's window.
 */
export function worstCaseCharge(scattered, windowMs = DEFAULT_WINDOW_MS) {
  if (scattered.length === 0) {
    return { massKg: 0, atMs: null, events: [] };
  }
  const candidates = new Set();
  for (const event of scattered) {
    candidates.add(event.earliestMs);
    candidates.add(roundTo(event.latestMs - windowMs, 3));
  }
  let best = { massKg: 0, atMs: null, events: [] };
  for (const start of candidates) {
    const end = roundTo(start + windowMs, 3);
    const inside = scattered.filter((event) => event.earliestMs < end && event.latestMs >= start);
    const massKg = roundTo(
      inside.reduce((sum, event) => sum + event.massKg, 0),
      3,
    );
    if (massKg > best.massKg) {
      best = { massKg, atMs: start, events: inside };
    }
  }
  return best;
}

/**
 * Fire the shot a few thousand times on paper. Each element is drawn uniformly
 * inside its own window, which is how the manufacturers describe the spread, and
 * the instantaneous charge is measured each time.
 */
export function simulateCharge(scattered, options = {}) {
  const runs = options.runs ?? 2000;
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  if (!Number.isInteger(runs) || runs < 1 || runs > 200000) {
    throw new ValidationError('the number of runs is out of range', [
      { path: 'runs', message: 'expected between 1 and 200000', kind: 'range' },
    ]);
  }
  const random = createRandom(options.seed ?? 20250424);
  const results = [];
  for (let run = 0; run < runs; run += 1) {
    const drawn = scattered.map((event) => ({
      ...event,
      firingTimeMs: random.between(event.earliestMs, event.latestMs),
    }));
    results.push(maximumInstantaneousCharge(drawn, windowMs).massKg);
  }
  return {
    runs,
    windowMs,
    meanKg: roundTo(results.reduce((sum, value) => sum + value, 0) / runs, 3),
    medianKg: roundTo(percentile(results, 0.5), 3),
    p95Kg: roundTo(percentile(results, 0.95), 3),
    p99Kg: roundTo(percentile(results, 0.99), 3),
    maximumKg: roundTo(Math.max(...results), 3),
    minimumKg: roundTo(Math.min(...results), 3),
  };
}

/** The three readings side by side, which is what the timing report prints. */
export function chargeExposure(events, scatterFor, options = {}) {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const scattered = withScatter(events, scatterFor);
  const nominal = maximumInstantaneousCharge(events, windowMs);
  const bound = worstCaseCharge(scattered, windowMs);
  const simulated = simulateCharge(scattered, { ...options, windowMs });
  return {
    windowMs,
    nominalKg: nominal.massKg,
    boundKg: bound.massKg,
    simulated,
    boundExceedsNominalBy: roundTo(bound.massKg - nominal.massKg, 3),
    likelyKg: simulated.p95Kg,
  };
}
