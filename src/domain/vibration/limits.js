/**
 * Vibration limits.
 *
 * A single number for peak particle velocity is the exception rather than the
 * rule. Both of the standards used around here make the limit depend on the
 * dominant frequency of the event, because a slow wave moves a wall much further
 * than a fast one at the same velocity, and cosmetic cracking follows the
 * movement rather than the velocity. So a limit is a curve, held here as control
 * points that are interpolated between.
 *
 * The curves below are this site's written reading of the two standards, agreed
 * with the regulator and reproduced in the blasting procedure. They are data,
 * not law: a licence condition that says a flat six millimetres per second
 * overrides all of it and is expressed with `fixedLimit`.
 */

import { ValidationError } from '../../lib/errors.js';
import { roundTo } from '../../lib/units.js';

const curve = (name, standard, interpolation, points, description) =>
  Object.freeze({ name, standard, interpolation, points: Object.freeze(points), description });

export const CURVES = Object.freeze({
  usbm_drywall: curve(
    'usbm_drywall',
    'USBM RI8507',
    'log',
    [
      [1, 5.1],
      [4, 19.1],
      [15, 19.1],
      [40, 50.8],
      [100, 50.8],
    ],
    'modern housing with plasterboard walls',
  ),
  usbm_plaster: curve(
    'usbm_plaster',
    'USBM RI8507',
    'log',
    [
      [1, 3.4],
      [4, 12.7],
      [15, 12.7],
      [40, 50.8],
      [100, 50.8],
    ],
    'older housing with lath and plaster',
  ),
  din_sensitive: curve(
    'din_sensitive',
    'DIN 4150-3 line 3',
    'linear',
    [
      [1, 3],
      [10, 3],
      [50, 8],
      [100, 10],
    ],
    'listed or otherwise sensitive structures',
  ),
  din_residential: curve(
    'din_residential',
    'DIN 4150-3 line 2',
    'linear',
    [
      [1, 5],
      [10, 5],
      [50, 15],
      [100, 20],
    ],
    'dwellings',
  ),
  din_commercial: curve(
    'din_commercial',
    'DIN 4150-3 line 1',
    'linear',
    [
      [1, 20],
      [10, 20],
      [50, 40],
      [100, 50],
    ],
    'industrial and commercial buildings',
  ),
});

export function curveNames() {
  return Object.keys(CURVES);
}

export function getCurve(name) {
  const found = CURVES[name];
  if (!found) {
    throw new ValidationError(`${name} is not a limit curve`, [
      { path: 'curve', message: `expected one of ${curveNames().join(', ')}`, kind: 'enum' },
    ]);
  }
  return found;
}

/**
 * The limit at a frequency. Below the first control point and above the last the
 * curve is held flat, which is the conservative reading: a very low frequency
 * event does not get a lower limit than the standard's own floor, and a very
 * high frequency one does not get an unbounded allowance.
 */
export function limitAt(curveName, frequencyHz) {
  const definition = getCurve(curveName);
  if (!(frequencyHz > 0)) {
    throw new ValidationError('a frequency has to be positive', [
      { path: 'frequencyHz', message: 'must be greater than zero', kind: 'range' },
    ]);
  }
  const points = definition.points;
  if (frequencyHz <= points[0][0]) {
    return points[0][1];
  }
  if (frequencyHz >= points.at(-1)[0]) {
    return points.at(-1)[1];
  }
  for (let index = 0; index < points.length - 1; index += 1) {
    const [lowHz, lowLimit] = points[index];
    const [highHz, highLimit] = points[index + 1];
    if (frequencyHz >= lowHz && frequencyHz <= highHz) {
      if (definition.interpolation === 'log') {
        const t =
          (Math.log10(frequencyHz) - Math.log10(lowHz)) / (Math.log10(highHz) - Math.log10(lowHz));
        return roundTo(
          10 ** (Math.log10(lowLimit) + t * (Math.log10(highLimit) - Math.log10(lowLimit))),
          3,
        );
      }
      const t = (frequencyHz - lowHz) / (highHz - lowHz);
      return roundTo(lowLimit + t * (highLimit - lowLimit), 3);
    }
  }
  throw new ValidationError('the curve has no point covering that frequency', [
    { path: 'frequencyHz', message: 'outside the curve', kind: 'range' },
  ]);
}

/** A flat limit from a licence condition, which overrides any curve. */
export function fixedLimit(millimetresPerSecond) {
  if (!(millimetresPerSecond > 0)) {
    throw new ValidationError('a fixed limit has to be positive', [
      { path: 'limit', message: 'must be greater than zero', kind: 'range' },
    ]);
  }
  return Object.freeze({
    name: 'fixed',
    standard: 'licence condition',
    limitMmPerSecond: millimetresPerSecond,
  });
}

/**
 * Judge one reading. A reading with no frequency is judged against the lowest
 * point on the curve, because without a frequency there is no way to earn the
 * higher allowance and giving it away is how an exceedance gets missed.
 */
export function evaluate(reading, limit) {
  const allowed =
    limit.limitMmPerSecond !== undefined
      ? limit.limitMmPerSecond
      : reading.frequencyHz
        ? limitAt(limit.name ?? limit, reading.frequencyHz)
        : lowestLimit(limit.name ?? limit);
  const ratio = roundTo(reading.peakMmPerSecond / allowed, 4);
  return {
    peakMmPerSecond: reading.peakMmPerSecond,
    frequencyHz: reading.frequencyHz ?? null,
    limitMmPerSecond: allowed,
    ratio,
    compliant: reading.peakMmPerSecond <= allowed,
    marginMmPerSecond: roundTo(allowed - reading.peakMmPerSecond, 4),
    assumedWorstFrequency: !reading.frequencyHz && limit.limitMmPerSecond === undefined,
  };
}

export function lowestLimit(curveName) {
  return Math.min(...getCurve(curveName).points.map(([, limit]) => limit));
}

/** The curve a receptor is judged against, from what kind of building it is. */
export function curveForReceptor(receptor) {
  if (receptor.limitMmPerSecond) {
    return fixedLimit(receptor.limitMmPerSecond);
  }
  const byClass = {
    listed: 'din_sensitive',
    heritage: 'din_sensitive',
    dwelling: 'usbm_drywall',
    older_dwelling: 'usbm_plaster',
    commercial: 'din_commercial',
    industrial: 'din_commercial',
  };
  const name = byClass[receptor.structureClass];
  if (!name) {
    throw new ValidationError(`no limit curve is set for a ${receptor.structureClass}`, [
      { path: 'structureClass', message: 'unknown structure class', kind: 'enum' },
    ]);
  }
  return getCurve(name);
}
