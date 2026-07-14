/**
 * Correcting the fragmentation prediction against what actually came out.
 *
 * The Kuznetsov relation has one free parameter that is not measurable: the rock
 * factor. Every site guesses it once and then quotes predictions against that
 * guess for years. What is measurable is the oversize count off a muckpile, and
 * a run of those is enough to back out the rock factor that would have predicted
 * them.
 *
 * The fit is deliberately conservative. It refuses on a handful of shots, it
 * refuses when the counts are all zero, and it reports the spread so a designer
 * can see whether the site is consistent enough for the number to mean anything.
 */

import { roundTo } from '../../lib/units.js';
import { ValidationError } from '../../lib/errors.js';
import { requirePositive } from '../../lib/guards.js';
import { predict, meanSizeCm, uniformityIndex, fractionPassing } from './fragmentation.js';

export const DEFAULT_FIT_OPTIONS = Object.freeze({
  minimumShots: 6,
  lowestRockFactor: 2,
  highestRockFactor: 16,
  step: 0.1,
});

/** Oversize as a fraction of the holes, which is what an inspection counts. */
export function observedOversizeFraction({ oversizeCount, holeCount, bouldersPerHoleAtOne = 4 }) {
  requirePositive(holeCount, 'holeCount');
  if (oversizeCount < 0) {
    throw new ValidationError('an oversize count cannot be negative', [
      { path: 'oversizeCount', message: 'must be zero or more', kind: 'range' },
    ]);
  }
  // A muckpile is counted in boulders, not in tonnes. The conversion is the
  // site's own and it is a setting, because a boulder on one site is a rock a
  // loader can pick up on another.
  return roundTo(Math.min(oversizeCount / (holeCount * bouldersPerHoleAtOne), 1), 4);
}

export function predictedOversizeFraction(design, rockFactorA) {
  const prediction = predict({ ...design, rockFactorA });
  return prediction.oversizeFraction ?? 0;
}

/**
 * The rock factor that best explains the run of shots, found by walking the
 * range rather than by anything cleverer: the range is small, the function is
 * monotonic in it, and a closed form would be harder to read than the loop.
 */
export function fitRockFactor(shots, options = {}) {
  const settings = { ...DEFAULT_FIT_OPTIONS, ...options };
  const usable = shots.filter(
    (shot) => shot.holeCount > 0 && shot.design && typeof shot.oversizeCount === 'number',
  );
  if (usable.length < settings.minimumShots) {
    throw new ValidationError('there are not enough shots to fit a rock factor', [
      {
        path: 'shots',
        message: `${usable.length} usable, ${settings.minimumShots} needed`,
        kind: 'insufficient',
      },
    ]);
  }
  const observed = usable.map((shot) => ({
    shot,
    fraction: observedOversizeFraction({
      oversizeCount: shot.oversizeCount,
      holeCount: shot.holeCount,
      bouldersPerHoleAtOne: settings.bouldersPerHoleAtOne,
    }),
  }));
  if (observed.every((entry) => entry.fraction === 0)) {
    throw new ValidationError('every shot in the run had no oversize at all', [
      { path: 'shots', message: 'nothing to fit against', kind: 'degenerate' },
    ]);
  }

  let best = null;
  for (
    let factor = settings.lowestRockFactor;
    factor <= settings.highestRockFactor;
    factor += settings.step
  ) {
    const rockFactorA = roundTo(factor, 2);
    const error = observed.reduce((sum, entry) => {
      const predicted = predictedOversizeFraction(entry.shot.design, rockFactorA);
      return sum + (predicted - entry.fraction) ** 2;
    }, 0);
    if (!best || error < best.error) {
      best = { rockFactorA, error };
    }
  }

  const residuals = observed.map((entry) =>
    roundTo(predictedOversizeFraction(entry.shot.design, best.rockFactorA) - entry.fraction, 4),
  );
  const mean = residuals.reduce((sum, value) => sum + value, 0) / residuals.length;
  const spread = Math.sqrt(
    residuals.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
      Math.max(residuals.length - 1, 1),
  );

  return {
    rockFactorA: best.rockFactorA,
    shots: observed.length,
    meanResidual: roundTo(mean, 4),
    residualSpread: roundTo(spread, 4),
    // A spread wider than the average oversize fraction means the site is not
    // consistent enough for one number to describe it.
    trustworthy: spread < Math.max(mean === 0 ? 0.05 : Math.abs(mean), 0.05) * 3,
    observed: observed.map((entry, index) => ({
      blastId: entry.shot.blastId ?? null,
      observed: entry.fraction,
      predicted: roundTo(predictedOversizeFraction(entry.shot.design, best.rockFactorA), 4),
      residual: residuals[index],
    })),
  };
}

/** One shot: what was predicted, what came out, and how far apart they are. */
export function compareToActual({
  design,
  rockFactorA,
  oversizeCount,
  holeCount,
  bouldersPerHoleAtOne,
}) {
  const predictedFraction = predictedOversizeFraction(design, rockFactorA);
  const observedFraction = observedOversizeFraction({
    oversizeCount,
    holeCount,
    bouldersPerHoleAtOne,
  });
  return {
    meanCm: meanSizeCm({ ...design, rockFactorA }),
    uniformity: uniformityIndex(design),
    predictedOversizeFraction: roundTo(predictedFraction, 4),
    observedOversizeFraction: observedFraction,
    difference: roundTo(observedFraction - predictedFraction, 4),
    verdict:
      Math.abs(observedFraction - predictedFraction) < 0.02
        ? 'as_predicted'
        : observedFraction > predictedFraction
          ? 'coarser_than_predicted'
          : 'finer_than_predicted',
    passingAtOversize: roundTo(
      fractionPassing({
        sizeCm: design.oversizeCm ?? 80,
        meanCm: meanSizeCm({ ...design, rockFactorA }),
        uniformity: uniformityIndex(design),
      }),
      4,
    ),
  };
}
