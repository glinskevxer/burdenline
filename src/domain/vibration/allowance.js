/**
 * How much charge a shot is allowed to fire in one window.
 *
 * The site law says what a given charge will do at a given distance. Turned
 * around, it says what charge keeps a receptor under its limit, and that number
 * is the one a designer actually needs, because the timing is built to hit it.
 *
 * There is a wrinkle worth being explicit about. The limit at most receptors
 * depends on the dominant frequency of the event, and nobody knows that before
 * the shot. Design work therefore runs on the frequency the site has historically
 * seen at that receptor, and falls back to the floor of the curve when there is
 * no history. Assuming a comfortable frequency and being wrong is exactly how a
 * site ends up with an exceedance on a shot that was signed off as compliant, so
 * the assumption is carried on the result and printed on the report.
 */

import { roundTo } from '../../lib/units.js';
import { ValidationError } from '../../lib/errors.js';
import {
  predictPeakParticleVelocity,
  chargeForLimit,
  scaledDistance,
  extrapolation,
} from './site-law.js';
import { curveForReceptor, limitAt, lowestLimit, evaluate } from './limits.js';

/** The limit that applies to a receptor for design purposes, and where it came from. */
export function designLimit(receptor, options = {}) {
  const curve = curveForReceptor(receptor);
  if (curve.limitMmPerSecond !== undefined) {
    return { limitMmPerSecond: curve.limitMmPerSecond, basis: 'licence', frequencyHz: null, curve };
  }
  const frequency = options.frequencyHz ?? receptor.typicalFrequencyHz ?? null;
  if (frequency) {
    return {
      limitMmPerSecond: limitAt(curve.name, frequency),
      basis: 'assumed_frequency',
      frequencyHz: frequency,
      curve,
    };
  }
  return {
    limitMmPerSecond: lowestLimit(curve.name),
    basis: 'curve_floor',
    frequencyHz: null,
    curve,
  };
}

/** Charge per window that keeps this receptor at or under its limit. */
export function allowanceForReceptor({ fit, receptor, distanceM, frequencyHz, safetyFactor = 1 }) {
  if (!(safetyFactor > 0 && safetyFactor <= 1)) {
    throw new ValidationError('a safety factor runs above zero and up to one', [
      { path: 'safetyFactor', message: 'must be in (0, 1]', kind: 'range' },
    ]);
  }
  const limit = designLimit(receptor, { frequencyHz });
  const target = roundTo(limit.limitMmPerSecond * safetyFactor, 4);
  const chargeKg = chargeForLimit({
    k: fit.k,
    b: fit.b,
    distanceM,
    limitMmPerSecond: target,
    scaling: fit.scaling,
  });
  return {
    receptorId: receptor.id,
    receptorName: receptor.name,
    distanceM,
    limitMmPerSecond: limit.limitMmPerSecond,
    targetMmPerSecond: target,
    basis: limit.basis,
    frequencyHz: limit.frequencyHz,
    allowanceKg: chargeKg,
  };
}

/** The receptor that pins the shot, which is not always the closest one. */
export function bindingReceptor(allowances) {
  if (allowances.length === 0) {
    return null;
  }
  return allowances.reduce((tightest, candidate) =>
    candidate.allowanceKg < tightest.allowanceKg ? candidate : tightest,
  );
}

export function allowances({ fit, receptorsWithDistance, frequencyHz, safetyFactor = 1 }) {
  const worked = receptorsWithDistance.map((entry) =>
    allowanceForReceptor({
      fit,
      receptor: entry.receptor,
      distanceM: entry.distanceM,
      frequencyHz,
      safetyFactor,
    }),
  );
  worked.sort((a, b) => a.allowanceKg - b.allowanceKg);
  return { allowances: worked, binding: bindingReceptor(worked) };
}

/**
 * Judge a design. Every receptor gets a prediction from the instantaneous charge
 * the timing produces, and the shot is compliant only if all of them pass.
 */
export function assessDesign({ fit, receptorsWithDistance, instantaneousChargeKg, frequencyHz }) {
  if (!(instantaneousChargeKg > 0)) {
    throw new ValidationError('the instantaneous charge has to be positive', [
      { path: 'instantaneousChargeKg', message: 'must be greater than zero', kind: 'range' },
    ]);
  }
  const results = receptorsWithDistance.map((entry) => {
    const limit = designLimit(entry.receptor, { frequencyHz });
    const predicted = predictPeakParticleVelocity({
      k: fit.k,
      b: fit.b,
      distanceM: entry.distanceM,
      chargeKg: instantaneousChargeKg,
      scaling: fit.scaling,
    });
    const sd = scaledDistance({
      distanceM: entry.distanceM,
      chargeKg: instantaneousChargeKg,
      scaling: fit.scaling,
    });
    const judged = evaluate(
      { peakMmPerSecond: predicted, frequencyHz: limit.frequencyHz },
      limit.curve.limitMmPerSecond !== undefined ? limit.curve : { name: limit.curve.name },
    );
    return {
      receptorId: entry.receptor.id,
      receptorName: entry.receptor.name,
      distanceM: entry.distanceM,
      scaledDistance: sd,
      predictedMmPerSecond: predicted,
      limitMmPerSecond: limit.limitMmPerSecond,
      basis: limit.basis,
      ratio: roundTo(predicted / limit.limitMmPerSecond, 4),
      compliant: predicted <= limit.limitMmPerSecond,
      extrapolating: extrapolation(fit, sd).extrapolating,
      judged,
    };
  });
  const failing = results.filter((result) => !result.compliant);
  return {
    instantaneousChargeKg,
    results: results.sort((a, b) => b.ratio - a.ratio),
    compliant: failing.length === 0,
    failing,
    worst: results[0] ?? null,
    extrapolatingCount: results.filter((result) => result.extrapolating).length,
  };
}

/** What a designer is told when the shot does not fit: how far it has to come down. */
export function reduction(assessment, allowanceSet) {
  if (assessment.compliant) {
    return { needed: false, factor: 1, toKg: assessment.instantaneousChargeKg };
  }
  const binding = allowanceSet.binding;
  return {
    needed: true,
    factor: roundTo(binding.allowanceKg / assessment.instantaneousChargeKg, 4),
    toKg: binding.allowanceKg,
    becauseOf: binding.receptorName,
  };
}
