/**
 * Whether the timing will actually work on the bench.
 *
 * Two holes going off too close together do not break rock, they shake the
 * ground and throw. The rule of thumb the industry runs on is a few milliseconds
 * per metre of burden between neighbours, more between rows than along a row,
 * because a row has to have somewhere to move before the row behind it pushes.
 * These checks read the resolved firing times together with where the holes
 * actually are, so a tie-in that looks neat on paper but puts two neighbours in
 * the same window is caught before the crew leaves the bench.
 */

import { roundTo } from '../../lib/units.js';
import { planDistance } from '../geometry/points.js';

export const DEFAULT_TIMING_RULES = Object.freeze({
  minimumInterHoleMsPerMetre: 3,
  minimumInterRowMsPerMetre: 8,
  neighbourRadiusM: 6,
  minimumAbsoluteGapMs: 4,
  maximumShotDurationMs: 5000,
  maximumHolesPerWindow: 4,
});

export function timingRules(overrides = {}) {
  return Object.freeze({ ...DEFAULT_TIMING_RULES, ...overrides });
}

/** Neighbours are holes close enough that the timing between them matters. */
export function findNeighbours(holes, radiusM) {
  const pairs = [];
  for (let i = 0; i < holes.length; i += 1) {
    for (let j = i + 1; j < holes.length; j += 1) {
      const distance = planDistance(holes[i], holes[j]);
      if (distance <= radiusM) {
        pairs.push({
          a: holes[i],
          b: holes[j],
          distanceM: roundTo(distance, 3),
          sameRow: holes[i].rowNumber === holes[j].rowNumber,
        });
      }
    }
  }
  return pairs;
}

export function checkTiming(resolved, holes, options = {}) {
  const rules = { ...DEFAULT_TIMING_RULES, ...(options.rules ?? {}) };
  const timeByHole = new Map(resolved.holes.map((hole) => [hole.holeNumber, hole.firingTimeMs]));
  const positioned = holes
    .filter((hole) => timeByHole.has(hole.holeNumber))
    .map((hole) => ({ ...hole, firingTimeMs: timeByHole.get(hole.holeNumber) }));

  const violations = [];
  for (const pair of findNeighbours(positioned, rules.neighbourRadiusM)) {
    const gap = roundTo(Math.abs(pair.a.firingTimeMs - pair.b.firingTimeMs), 3);
    const perMetre = pair.sameRow
      ? rules.minimumInterHoleMsPerMetre
      : rules.minimumInterRowMsPerMetre;
    const required = roundTo(Math.max(perMetre * pair.distanceM, rules.minimumAbsoluteGapMs), 3);
    if (gap < required) {
      violations.push({
        rule: pair.sameRow ? 'timing.inter_hole' : 'timing.inter_row',
        holes: [pair.a.holeNumber, pair.b.holeNumber],
        message: `holes ${pair.a.holeNumber} and ${pair.b.holeNumber} are ${pair.distanceM} m apart and only ${gap} ms apart`,
        actual: gap,
        required,
      });
    }
  }

  for (const holeNumber of resolved.unreachable) {
    violations.push({
      rule: 'timing.unreachable',
      holes: [holeNumber],
      message: `hole ${holeNumber} is not tied into the shot`,
    });
  }
  for (const loop of resolved.loops) {
    violations.push({
      rule: 'timing.loop',
      holes: loop,
      message: `the tie-in loops through holes ${loop.join(' to ')}`,
    });
  }
  if (resolved.durationMs !== null && resolved.durationMs > rules.maximumShotDurationMs) {
    violations.push({
      rule: 'timing.too_long',
      holes: [],
      message: `the shot runs for ${resolved.durationMs} ms`,
      actual: resolved.durationMs,
      required: rules.maximumShotDurationMs,
    });
  }

  return { valid: violations.length === 0, violations, rules };
}

/**
 * Does each row get out of the way before the one behind pushes into it? The
 * check is on the earliest hole in each row against the latest in the row in
 * front, because one late hole in the front row is what actually causes a
 * back row to fire into standing rock.
 */
export function checkRowRelief(resolved, holes, options = {}) {
  const rules = { ...DEFAULT_TIMING_RULES, ...(options.rules ?? {}) };
  const burdenM = options.burdenM ?? 3;
  const timeByHole = new Map(resolved.holes.map((hole) => [hole.holeNumber, hole.firingTimeMs]));
  const rows = new Map();
  for (const hole of holes) {
    const time = timeByHole.get(hole.holeNumber);
    if (time === undefined) {
      continue;
    }
    const current = rows.get(hole.rowNumber) ?? {
      rowNumber: hole.rowNumber,
      earliest: time,
      latest: time,
    };
    current.earliest = Math.min(current.earliest, time);
    current.latest = Math.max(current.latest, time);
    rows.set(hole.rowNumber, current);
  }
  const ordered = [...rows.values()].sort((a, b) => a.rowNumber - b.rowNumber);
  const violations = [];
  const required = roundTo(rules.minimumInterRowMsPerMetre * burdenM, 3);
  for (let index = 1; index < ordered.length; index += 1) {
    const behind = ordered[index];
    const front = ordered[index - 1];
    const gap = roundTo(behind.earliest - front.latest, 3);
    if (gap < required) {
      violations.push({
        rule: 'timing.row_relief',
        holes: [],
        message: `row ${behind.rowNumber} starts ${gap} ms after row ${front.rowNumber} finishes`,
        actual: gap,
        required,
      });
    }
  }
  return { valid: violations.length === 0, violations, rows: ordered };
}

/** Too many holes in one window is a vibration problem before it is a rock one. */
export function checkWindowCrowding(windows, options = {}) {
  const rules = { ...DEFAULT_TIMING_RULES, ...(options.rules ?? {}) };
  return windows
    .filter((window) => window.holeCount > rules.maximumHolesPerWindow)
    .map((window) => ({
      rule: 'timing.window_crowded',
      holes: [],
      message: `${window.holeCount} holes fire in the window starting at ${window.startMs} ms`,
      actual: window.holeCount,
      required: rules.maximumHolesPerWindow,
    }));
}
