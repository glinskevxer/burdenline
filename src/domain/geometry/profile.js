/**
 * Face profiling.
 *
 * The burden written on a design is nominal. What matters is the rock actually
 * standing in front of each hole, and the only way to know it is to scan the
 * face. The profiler gives back a cloud of grid points on the face. For a hole
 * we walk down its axis, and at each level take the shortest horizontal distance
 * to the face points near that level. The smallest of those is what the crew
 * calls the real burden, and it is nearly always at the toe, which is where a
 * thin burden throws rock and a thick one leaves a toe standing.
 */

import { ValidationError } from '../../lib/errors.js';
import { roundTo } from '../../lib/units.js';
import { point, planDistance, offsetBy, toRadians } from './points.js';

const DEFAULT_BAND_M = 0.5;
const DEFAULT_STEP_M = 1;

/** Where the hole axis is when it has dropped to a given level. */
export function axisPointAtLevel(geometry, level) {
  const collar = geometry.collar;
  if (level > collar.level) {
    throw new ValidationError('that level is above the collar', [
      { path: 'level', message: 'a hole does not go up', kind: 'range' },
    ]);
  }
  const drop = collar.level - level;
  const inclination = toRadians(geometry.inclinationDeg ?? 0);
  const offset = drop * Math.tan(inclination);
  const moved = offsetBy(
    point(collar.easting, collar.northing, collar.level),
    geometry.bearingDeg ?? 0,
    offset,
  );
  return point(moved.easting, moved.northing, level);
}

export function faceSlice(facePoints, level, bandM = DEFAULT_BAND_M) {
  assertFace(facePoints);
  if (!(bandM > 0)) {
    throw new ValidationError('the band around a level has to be positive', [
      { path: 'bandM', message: 'must be greater than zero', kind: 'range' },
    ]);
  }
  return facePoints.filter((candidate) => Math.abs(candidate.level - level) <= bandM);
}

/**
 * Shortest horizontal distance from the hole axis to the face at one level.
 * Returns null when the scan has nothing near that level, which happens at the
 * very top and bottom of a face and must not be read as a burden of zero.
 */
export function burdenAtLevel(geometry, facePoints, level, options = {}) {
  const band = options.bandM ?? DEFAULT_BAND_M;
  const slice = faceSlice(facePoints, level, band);
  if (slice.length === 0) {
    return null;
  }
  const axis = axisPointAtLevel(geometry, level);
  let nearest = Infinity;
  for (const candidate of slice) {
    const distance = planDistance(axis, candidate);
    if (distance < nearest) {
      nearest = distance;
    }
  }
  return roundTo(nearest, 3);
}

/** Walk the hole from collar to toe and measure the burden all the way down. */
export function burdenProfile(geometry, facePoints, options = {}) {
  const step = options.stepM ?? DEFAULT_STEP_M;
  if (!(step > 0)) {
    throw new ValidationError('the profile step has to be positive', [
      { path: 'stepM', message: 'must be greater than zero', kind: 'range' },
    ]);
  }
  const toeLevel = options.toeLevelM ?? geometry.collar.level - (geometry.benchHeightM ?? 0);
  const readings = [];
  for (let level = geometry.collar.level; level >= toeLevel - 1e-9; level -= step) {
    const burden = burdenAtLevel(geometry, facePoints, roundTo(level, 3), options);
    readings.push({ levelM: roundTo(level, 3), burdenM: burden });
  }
  const last = readings.at(-1);
  if (Math.abs(last.levelM - toeLevel) > 1e-6) {
    readings.push({
      levelM: roundTo(toeLevel, 3),
      burdenM: burdenAtLevel(geometry, facePoints, roundTo(toeLevel, 3), options),
    });
  }
  return readings;
}

export function minimumBurden(readings) {
  const measured = readings.filter((reading) => reading.burdenM !== null);
  if (measured.length === 0) {
    return null;
  }
  return measured.reduce((lowest, reading) =>
    reading.burdenM < lowest.burdenM ? reading : lowest,
  );
}

export function maximumBurden(readings) {
  const measured = readings.filter((reading) => reading.burdenM !== null);
  if (measured.length === 0) {
    return null;
  }
  return measured.reduce((highest, reading) =>
    reading.burdenM > highest.burdenM ? reading : highest,
  );
}

/**
 * The whole burden picture for a hole. `coverage` says how much of the hole the
 * scan actually reached, and a designer should distrust anything under about
 * three quarters.
 */
export function describeBurden(geometry, facePoints, options = {}) {
  const readings = burdenProfile(geometry, facePoints, options);
  const measured = readings.filter((reading) => reading.burdenM !== null);
  const minimum = minimumBurden(readings);
  const maximum = maximumBurden(readings);
  return {
    readings,
    coverage: roundTo(measured.length / readings.length, 3),
    minimumBurdenM: minimum ? minimum.burdenM : null,
    minimumAtLevelM: minimum ? minimum.levelM : null,
    maximumBurdenM: maximum ? maximum.burdenM : null,
    meanBurdenM: measured.length
      ? roundTo(measured.reduce((sum, item) => sum + item.burdenM, 0) / measured.length, 3)
      : null,
  };
}

/**
 * How far the face leans back, in degrees from vertical. A face that overhangs
 * comes back negative, and that is a stability problem before it is a blasting
 * one.
 */
export function faceAngle(facePoints) {
  assertFace(facePoints);
  const top = facePoints.reduce((best, item) => (item.level > best.level ? item : best));
  const bottom = facePoints.reduce((best, item) => (item.level < best.level ? item : best));
  const rise = top.level - bottom.level;
  if (rise <= 0) {
    return null;
  }
  const run = planDistance(top, bottom);
  const leanTowardTop = run === 0 ? 0 : Math.atan(run / rise);
  const sign = isOverhanging(top, bottom) ? -1 : 1;
  return roundTo((sign * leanTowardTop * 180) / Math.PI, 2);
}

function isOverhanging(top, bottom) {
  return top.overhang === true || bottom.overhang === true;
}

function assertFace(facePoints) {
  if (!Array.isArray(facePoints) || facePoints.length === 0) {
    throw new ValidationError('a face scan needs at least one point', [
      { path: 'facePoints', message: 'the scan is empty', kind: 'missing' },
    ]);
  }
}

export const profileDefaults = { DEFAULT_BAND_M, DEFAULT_STEP_M };
