/**
 * Airblast.
 *
 * The pressure wave a shot puts into the air is what neighbours actually
 * complain about: it rattles windows and it carries much further than the ground
 * wave on the wrong day. It scales on the cube root of the charge rather than the
 * square root, because it spreads spherically through air, and unlike ground
 * vibration it is strongly affected by the weather. A temperature inversion can
 * bend the wave back down miles away, and a downwind receptor hears several
 * decibels more than an upwind one at the same distance.
 *
 * Everything here works in the linear decibel scale the monitors report, which
 * is unweighted. A dB(A) figure from a sound meter is a different measurement and
 * is not interchangeable with it.
 */

import { ValidationError } from '../../lib/errors.js';
import { requirePositive } from '../../lib/guards.js';
import { roundTo, pascalsToDecibels } from '../../lib/units.js';
import { bearingDifference } from '../geometry/points.js';

export const DEFAULT_AIRBLAST_LAW = Object.freeze({ a: 165, b: 24 });

export const AIRBLAST_LIMITS = Object.freeze({
  routine: 120,
  regulatory: 133,
  windowDamageRisk: 140,
});

/** Cube root scaled distance, which is what airblast is quoted against. */
export function cubeRootScaledDistance({ distanceM, chargeKg }) {
  requirePositive(distanceM, 'distanceM');
  requirePositive(chargeKg, 'chargeKg');
  return roundTo(distanceM / Math.cbrt(chargeKg), 4);
}

export function predictAirblastDb({ distanceM, chargeKg, law = DEFAULT_AIRBLAST_LAW }) {
  const sd = cubeRootScaledDistance({ distanceM, chargeKg });
  return roundTo(law.a - law.b * Math.log10(sd), 2);
}

/**
 * Weather correction in decibels.
 *
 * Wind adds where it blows toward the receptor and takes away where it blows
 * from it, tapering off across the intervening bearings. An inversion adds
 * everywhere, which is why shots are held until it lifts rather than moved.
 */
export function weatherCorrectionDb({
  windSpeedMs = 0,
  windBearingDeg = 0,
  receptorBearingDeg = 0,
  inversion = false,
  cloudBase = null,
}) {
  if (windSpeedMs < 0) {
    throw new ValidationError('a wind speed cannot be negative', [
      { path: 'windSpeedMs', message: 'must be zero or more', kind: 'range' },
    ]);
  }
  const offAxis = Math.abs(bearingDifference(windBearingDeg, receptorBearingDeg));
  const alignment = Math.cos((offAxis * Math.PI) / 180);
  const wind = roundTo(0.6 * windSpeedMs * alignment, 2);
  const inversionDb = inversion ? 6 : 0;
  const lowCloud = cloudBase !== null && cloudBase < 300 ? 2 : 0;
  return {
    windDb: wind,
    inversionDb,
    lowCloudDb: lowCloud,
    totalDb: roundTo(wind + inversionDb + lowCloud, 2),
    alignment: roundTo(alignment, 3),
  };
}

export function predictWithWeather({ distanceM, chargeKg, law, weather = {} }) {
  const base = predictAirblastDb({ distanceM, chargeKg, law });
  const correction = weatherCorrectionDb(weather);
  return {
    baseDb: base,
    correctionDb: correction.totalDb,
    predictedDb: roundTo(base + correction.totalDb, 2),
    correction,
  };
}

/** Confinement matters as much as charge: an exposed hole is far louder. */
export function confinementPenaltyDb({
  stemmingRatio = 1,
  exposedCharge = false,
  detonatingCordOnSurface = false,
}) {
  let penalty = 0;
  if (exposedCharge) {
    penalty += 20;
  }
  if (detonatingCordOnSurface) {
    penalty += 8;
  }
  if (stemmingRatio < 1) {
    penalty += roundTo((1 - Math.max(stemmingRatio, 0)) * 12, 2);
  }
  return roundTo(penalty, 2);
}

export function assessAirblast({ predictedDb, receptor }) {
  const limit = receptor?.airblastLimitDb ?? AIRBLAST_LIMITS.regulatory;
  return {
    predictedDb,
    limitDb: limit,
    marginDb: roundTo(limit - predictedDb, 2),
    compliant: predictedDb <= limit,
    aboveRoutine: predictedDb > AIRBLAST_LIMITS.routine,
    windowRisk: predictedDb > AIRBLAST_LIMITS.windowDamageRisk,
  };
}

/** The charge that keeps a receptor under its airblast limit. */
export function chargeForAirblastLimit({
  distanceM,
  limitDb,
  law = DEFAULT_AIRBLAST_LAW,
  correctionDb = 0,
}) {
  requirePositive(distanceM, 'distanceM');
  const target = limitDb - correctionDb;
  const sd = 10 ** ((law.a - target) / law.b);
  return roundTo((distanceM / sd) ** 3, 3);
}

/** Overpressure in pascals, which is what an old monitor sometimes reports. */
export function decibelsFromPascals(pascals) {
  return roundTo(pascalsToDecibels(pascals), 2);
}
