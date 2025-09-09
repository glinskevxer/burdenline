/**
 * Predicted fragmentation.
 *
 * The Kuznetsov relation gives the mean fragment size from the rock factor, the
 * volume each hole breaks and the charge in it. The Rosin Rammler distribution
 * then spreads that mean into a size curve, and how tightly it spreads is the
 * uniformity index, which depends almost entirely on the pattern geometry: the
 * ratio of burden to hole diameter, spacing to burden, how much of the hole is
 * charged, and how accurately the holes were drilled. The burden in that ratio
 * is metres and the diameter is millimetres, which looks like a mistake and is
 * not: the constant carries the conversion.
 *
 * This is a prediction and it is worth saying what it is for. Nobody should
 * expect it to match a screened sample. It is for comparing two designs on the
 * same rock, and for telling a designer that pulling the burden out by half a
 * metre will put another few percent over the crusher gape.
 */

import { ValidationError } from '../../lib/errors.js';
import { requirePositive } from '../../lib/guards.js';
import { roundTo } from '../../lib/units.js';

/** Lilly rock factor inputs, which a geologist scores off the face. */
export const ROCK_FACTORS = Object.freeze({
  weathered_soft: 3,
  medium_jointed: 7,
  hard_jointed: 10,
  massive_hard: 13,
});

export function rockFactor({
  jointSpacingM,
  densityKgM3,
  ucsMpa,
  jointOrientation = 'dipping_into_face',
}) {
  requirePositive(densityKgM3, 'densityKgM3');
  const rockMassDescription = jointSpacingM < 0.1 ? 10 : jointSpacingM < 1 ? 20 : 50;
  const jointPlaneSpacing = jointSpacingM < 0.1 ? 10 : jointSpacingM < 1 ? 20 : 50;
  const orientation = {
    horizontal: 10,
    dipping_out_of_face: 20,
    striking_across_face: 30,
    dipping_into_face: 40,
  }[jointOrientation];
  if (orientation === undefined) {
    throw new ValidationError(`${jointOrientation} is not a joint orientation`, [
      { path: 'jointOrientation', message: 'unknown orientation', kind: 'enum' },
    ]);
  }
  const density = (densityKgM3 / 1000) * 25;
  const hardness = ucsMpa ? ucsMpa / 3 : 10;
  return roundTo(
    0.06 * (rockMassDescription + jointPlaneSpacing + orientation + density + hardness),
    2,
  );
}

/**
 * Mean fragment size in centimetres. `volumeM3` is the rock one hole breaks and
 * `chargeKg` the explosive in that hole, both per hole and not per pattern.
 */
export function meanSizeCm({ rockFactorA, volumeM3, chargeKg, relativeWeightStrength = 100 }) {
  requirePositive(rockFactorA, 'rockFactorA');
  requirePositive(volumeM3, 'volumeM3');
  requirePositive(chargeKg, 'chargeKg');
  requirePositive(relativeWeightStrength, 'relativeWeightStrength');
  const size =
    rockFactorA *
    (volumeM3 / chargeKg) ** 0.8 *
    chargeKg ** (1 / 6) *
    (115 / relativeWeightStrength) ** 0.633;
  return roundTo(size, 3);
}

/**
 * Uniformity index. Higher is a tighter size range. Anything under about 0.8 is
 * a pattern that will produce fines and boulders at the same time.
 */
export function uniformityIndex({
  burdenM,
  spacingM,
  diameterMm,
  chargeLengthM,
  benchHeightM,
  drillDeviationM = 0,
  bottomChargeLengthM = null,
  columnChargeLengthM = null,
}) {
  requirePositive(burdenM, 'burdenM');
  requirePositive(spacingM, 'spacingM');
  requirePositive(diameterMm, 'diameterMm');
  requirePositive(chargeLengthM, 'chargeLengthM');
  requirePositive(benchHeightM, 'benchHeightM');
  const base = 2.2 - (14 * burdenM) / diameterMm;
  const spacingTerm = Math.sqrt((1 + spacingM / burdenM) / 2);
  const deviationTerm = 1 - drillDeviationM / burdenM;
  const decking =
    bottomChargeLengthM !== null && columnChargeLengthM !== null
      ? (Math.abs(bottomChargeLengthM - columnChargeLengthM) / chargeLengthM + 0.1) ** 0.1
      : 1;
  const lengthTerm = chargeLengthM / benchHeightM;
  return roundTo(Math.abs(base) * spacingTerm * deviationTerm * decking * lengthTerm, 3);
}

/** Fraction passing a screen of the given size, from the Rosin Rammler curve. */
export function fractionPassing({ sizeCm, meanCm, uniformity }) {
  requirePositive(sizeCm, 'sizeCm');
  requirePositive(meanCm, 'meanCm');
  requirePositive(uniformity, 'uniformity');
  const characteristic = meanCm / 0.693 ** (1 / uniformity);
  return roundTo(1 - Math.exp(-((sizeCm / characteristic) ** uniformity)), 4);
}

export function sizeAtPassing({ fraction, meanCm, uniformity }) {
  if (!(fraction > 0 && fraction < 1)) {
    throw new ValidationError('a passing fraction runs between zero and one', [
      { path: 'fraction', message: 'must be in (0, 1)', kind: 'range' },
    ]);
  }
  const characteristic = meanCm / 0.693 ** (1 / uniformity);
  return roundTo(characteristic * (-Math.log(1 - fraction)) ** (1 / uniformity), 3);
}

/** The whole predicted curve, plus the two numbers a quarry actually watches. */
export function predict(inputs) {
  const meanCm = meanSizeCm(inputs);
  const uniformity = uniformityIndex(inputs);
  const screens = inputs.screensCm ?? [5, 10, 20, 30, 50, 80, 100];
  return {
    meanCm,
    uniformity,
    characteristicCm: roundTo(meanCm / 0.693 ** (1 / uniformity), 3),
    curve: screens.map((sizeCm) => ({
      sizeCm,
      passing: fractionPassing({ sizeCm, meanCm, uniformity }),
    })),
    p20Cm: sizeAtPassing({ fraction: 0.2, meanCm, uniformity }),
    p80Cm: sizeAtPassing({ fraction: 0.8, meanCm, uniformity }),
    oversizeFraction: inputs.oversizeCm
      ? roundTo(1 - fractionPassing({ sizeCm: inputs.oversizeCm, meanCm, uniformity }), 4)
      : null,
    finesFraction: roundTo(fractionPassing({ sizeCm: inputs.finesCm ?? 5, meanCm, uniformity }), 4),
  };
}

/** What a change to the pattern would do, which is the question that gets asked. */
export function compare(baseline, alternative) {
  const first = predict(baseline);
  const second = predict({ ...baseline, ...alternative });
  return {
    baseline: first,
    alternative: second,
    meanChangeCm: roundTo(second.meanCm - first.meanCm, 3),
    oversizeChange:
      first.oversizeFraction === null
        ? null
        : roundTo(second.oversizeFraction - first.oversizeFraction, 4),
    better: second.oversizeFraction !== null && second.oversizeFraction < first.oversizeFraction,
  };
}
