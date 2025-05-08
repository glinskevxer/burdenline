/**
 * The site law.
 *
 * Ground vibration from a blast falls off with distance and grows with the
 * charge that arrives in one pulse. The relationship every regulator and every
 * consultant works to is a power law in the scaled distance, which is the
 * distance divided by the square root of the instantaneous charge:
 *
 *     ppv = k * scaledDistance ^ -b
 *
 * Both constants are properties of the ground between this quarry and this
 * receptor, so they are fitted from the site's own monitor records rather than
 * taken from a textbook. Fitting is a straight least squares on the logarithms,
 * which is what makes the power law convenient, and the fit is only worth having
 * with a decent spread of scaled distances behind it: twenty records all taken
 * from the same monitor at the same distance will fit beautifully and predict
 * nothing.
 */

import { ValidationError } from '../../lib/errors.js';
import { roundTo } from '../../lib/units.js';

export const SCALING = ['square_root', 'cube_root'];

/** Distance divided by the root of the charge. Square root is the usual convention. */
export function scaledDistance({ distanceM, chargeKg, scaling = 'square_root' }) {
  requirePositive(distanceM, 'distanceM');
  requirePositive(chargeKg, 'chargeKg');
  if (!SCALING.includes(scaling)) {
    throw new ValidationError(`${scaling} is not a scaling convention`, [
      { path: 'scaling', message: `expected one of ${SCALING.join(', ')}`, kind: 'enum' },
    ]);
  }
  const root = scaling === 'cube_root' ? Math.cbrt(chargeKg) : Math.sqrt(chargeKg);
  return roundTo(distanceM / root, 4);
}

export function predictPeakParticleVelocity({
  k,
  b,
  distanceM,
  chargeKg,
  scaling = 'square_root',
}) {
  requirePositive(k, 'k');
  requirePositive(b, 'b');
  const sd = scaledDistance({ distanceM, chargeKg, scaling });
  return roundTo(k * sd ** -b, 4);
}

/** The charge that keeps the prediction at or under a limit, at a given distance. */
export function chargeForLimit({ k, b, distanceM, limitMmPerSecond, scaling = 'square_root' }) {
  requirePositive(k, 'k');
  requirePositive(b, 'b');
  requirePositive(distanceM, 'distanceM');
  requirePositive(limitMmPerSecond, 'limitMmPerSecond');
  const sd = (limitMmPerSecond / k) ** (-1 / b);
  const root = distanceM / sd;
  return roundTo(scaling === 'cube_root' ? root ** 3 : root ** 2, 3);
}

/**
 * Least squares fit of log(ppv) against log(scaled distance).
 *
 * The records are the site's own monitor readings, each with the distance to the
 * monitor and the instantaneous charge of the shot it recorded. A record with a
 * peak of zero is dropped rather than fudged, because the logarithm of zero is
 * where a fit quietly turns into nonsense.
 */
export function fitSiteLaw(records, options = {}) {
  const scaling = options.scaling ?? 'square_root';
  const usable = records.filter(
    (record) => record.peakMmPerSecond > 0 && record.distanceM > 0 && record.chargeKg > 0,
  );
  if (usable.length < (options.minimumRecords ?? 6)) {
    throw new ValidationError('there are not enough records to fit a site law', [
      {
        path: 'records',
        message: `${usable.length} usable records, at least ${options.minimumRecords ?? 6} needed`,
        kind: 'insufficient',
      },
    ]);
  }
  const points = usable.map((record) => ({
    x: Math.log10(
      scaledDistance({ distanceM: record.distanceM, chargeKg: record.chargeKg, scaling }),
    ),
    y: Math.log10(record.peakMmPerSecond),
  }));
  const n = points.length;
  const meanX = points.reduce((sum, p) => sum + p.x, 0) / n;
  const meanY = points.reduce((sum, p) => sum + p.y, 0) / n;
  const sxx = points.reduce((sum, p) => sum + (p.x - meanX) ** 2, 0);
  const sxy = points.reduce((sum, p) => sum + (p.x - meanX) * (p.y - meanY), 0);
  if (sxx === 0) {
    throw new ValidationError('every record is at the same scaled distance', [
      {
        path: 'records',
        message: 'the fit needs a spread of scaled distances',
        kind: 'degenerate',
      },
    ]);
  }
  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;
  const residuals = points.map((p) => p.y - (intercept + slope * p.x));
  const sse = residuals.reduce((sum, residual) => sum + residual ** 2, 0);
  const sst = points.reduce((sum, p) => sum + (p.y - meanY) ** 2, 0);
  const standardError = n > 2 ? Math.sqrt(sse / (n - 2)) : 0;

  return {
    k: roundTo(10 ** intercept, 4),
    b: roundTo(-slope, 4),
    scaling,
    recordCount: n,
    rSquared: sst === 0 ? 1 : roundTo(1 - sse / sst, 4),
    residualStandardError: roundTo(standardError, 4),
    scaledDistanceRange: {
      low: roundTo(10 ** Math.min(...points.map((p) => p.x)), 3),
      high: roundTo(10 ** Math.max(...points.map((p) => p.x)), 3),
    },
    droppedRecords: records.length - n,
  };
}

/**
 * A one sided upper bound on the fit. Predictions from the mean line are
 * exceeded half the time by construction, which is not a basis for a compliance
 * case, so design work uses this instead.
 */
export function upperBound(fit, confidence = 0.95) {
  const factors = { 0.5: 0, 0.8: 0.842, 0.9: 1.282, 0.95: 1.645, 0.99: 2.326 };
  const z = factors[confidence];
  if (z === undefined) {
    throw new ValidationError(`there is no factor for a confidence of ${confidence}`, [
      {
        path: 'confidence',
        message: `expected one of ${Object.keys(factors).join(', ')}`,
        kind: 'enum',
      },
    ]);
  }
  return {
    ...fit,
    confidence,
    k: roundTo(fit.k * 10 ** (z * fit.residualStandardError), 4),
    isUpperBound: true,
  };
}

/** How far outside its own data a prediction is being asked to reach. */
export function extrapolation(fit, sd) {
  if (sd >= fit.scaledDistanceRange.low && sd <= fit.scaledDistanceRange.high) {
    return { extrapolating: false, factor: 1 };
  }
  const factor =
    sd < fit.scaledDistanceRange.low
      ? fit.scaledDistanceRange.low / sd
      : sd / fit.scaledDistanceRange.high;
  return { extrapolating: true, factor: roundTo(factor, 3) };
}

function requirePositive(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new ValidationError(`${name} has to be positive`, [
      { path: name, message: 'must be greater than zero', kind: 'range' },
    ]);
  }
}
