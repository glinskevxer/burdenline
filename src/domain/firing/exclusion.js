/**
 * The exclusion zone.
 *
 * How far back everybody stands, and who has to stand where to keep them there.
 * The zone is the larger of two things: the site's statutory minimum, which is
 * written into the planning permission and never goes down, and a throw estimate
 * from the hole diameter and how well the shot is confined. Confinement is the
 * part that actually varies, because a hole with the designed stemming in it
 * throws a fraction of what a hole with a thin collar throws, and the crew know
 * which holes those are before the shot goes off.
 *
 * The distance is rounded up to the next twenty five metres. Nobody paces out
 * three hundred and seventeen metres.
 */

import { ValidationError } from '../../lib/errors.js';
import { roundTo, ceilToStep } from '../../lib/units.js';
import { planDistance, bearingBetween, point } from '../geometry/points.js';
import { collector } from '../violations.js';

export const DEFAULT_EXCLUSION_RULES = Object.freeze({
  statutoryMinimumM: 300,
  throwCoefficient: 143,
  roundingStepM: 25,
  personnelFactor: 1,
  plantFactor: 0.5,
  publicRoadFactor: 1.2,
});

/**
 * Estimated maximum throw from a well confined hole, in metres, from the hole
 * diameter. The coefficient is the site's own, back calculated from the worst
 * throw it has actually recorded, and it is deliberately a setting.
 */
export function throwDistanceM(diameterMm, rules = DEFAULT_EXCLUSION_RULES) {
  if (!(diameterMm > 0)) {
    throw new ValidationError('a hole diameter is needed to estimate throw', [
      { path: 'diameterMm', message: 'must be greater than zero', kind: 'range' },
    ]);
  }
  return roundTo(rules.throwCoefficient * (diameterMm / 1000) ** (2 / 3), 1);
}

/** Confinement multiplies the estimate. A blown out collar is the bad case. */
export function confinementFactor({
  stemmingRatio = 1,
  cavitiesPresent = false,
  faceBurdenThin = false,
}) {
  let factor = 1;
  if (stemmingRatio < 1) {
    factor += (1 - Math.max(stemmingRatio, 0)) * 1.5;
  }
  if (cavitiesPresent) {
    factor += 0.4;
  }
  if (faceBurdenThin) {
    factor += 0.6;
  }
  return roundTo(factor, 3);
}

export function exclusionRadiusM({
  diameterMm,
  confinement = {},
  rules = DEFAULT_EXCLUSION_RULES,
}) {
  const base = throwDistanceM(diameterMm, rules) * confinementFactor(confinement);
  const chosen = Math.max(base, rules.statutoryMinimumM);
  return {
    estimatedThrowM: roundTo(base, 1),
    statutoryMinimumM: rules.statutoryMinimumM,
    radiusM: ceilToStep(chosen, rules.roundingStepM),
    governedBy: base > rules.statutoryMinimumM ? 'throw_estimate' : 'statutory_minimum',
  };
}

/**
 * The zone is not always a circle. Plant may stand closer than people, and a
 * public road has to be held further back than the site boundary, so each kind
 * of thing to be cleared gets its own radius off the same base.
 */
export function radiiFor(baseRadiusM, rules = DEFAULT_EXCLUSION_RULES) {
  return {
    personnelM: ceilToStep(baseRadiusM * rules.personnelFactor, rules.roundingStepM),
    plantM: ceilToStep(baseRadiusM * rules.plantFactor, rules.roundingStepM),
    publicRoadM: ceilToStep(baseRadiusM * rules.publicRoadFactor, rules.roundingStepM),
  };
}

/** Which sentry covers which approach, and whether every approach has one. */
export function checkSentryCover({ approaches, sentries, radiusM }) {
  const found = collector();
  if (!Array.isArray(approaches) || approaches.length === 0) {
    throw new ValidationError('an exclusion zone needs its approaches listed', [
      { path: 'approaches', message: 'no approaches given', kind: 'missing' },
    ]);
  }
  const covered = new Map();
  for (const approach of approaches) {
    const posted = sentries.filter((sentry) => sentry.covers?.includes(approach.id));
    covered.set(approach.id, posted);
    if (posted.length === 0) {
      found.add('clearance.approach_uncovered', `nothing covers the ${approach.name} approach`, {
        approachId: approach.id,
      });
    }
    for (const sentry of posted) {
      const distance = roundTo(
        planDistance(
          point(sentry.easting, sentry.northing),
          point(approach.easting, approach.northing),
        ),
        1,
      );
      if (distance > (approach.sightLineM ?? 150)) {
        found.add(
          'clearance.sentry_too_far',
          `${sentry.name} is ${distance} m from the ${approach.name} approach`,
          {
            approachId: approach.id,
            sentryId: sentry.id,
            actual: distance,
          },
        );
      }
    }
  }
  for (const sentry of sentries) {
    if (sentry.distanceFromShotM !== undefined && sentry.distanceFromShotM < radiusM) {
      found.add(
        'clearance.sentry_inside_zone',
        `${sentry.name} is standing inside the exclusion zone`,
        {
          sentryId: sentry.id,
          actual: sentry.distanceFromShotM,
          required: radiusM,
        },
      );
    }
    if (!sentry.hasRadio) {
      found.add('clearance.sentry_no_radio', `${sentry.name} has no radio`, {
        sentryId: sentry.id,
      });
    }
  }
  return found.result({
    covered: [...covered.entries()].map(([id, posted]) => ({
      approachId: id,
      sentries: posted.length,
    })),
  });
}

/** Anything inside the zone that should not be, from the last sweep. */
export function occupantsInside({ occupants, shotCentre, radii }) {
  return occupants
    .map((occupant) => {
      const distance = roundTo(
        planDistance(
          point(shotCentre.easting, shotCentre.northing),
          point(occupant.easting, occupant.northing),
        ),
        1,
      );
      const limit =
        occupant.kind === 'plant'
          ? radii.plantM
          : occupant.kind === 'public_road'
            ? radii.publicRoadM
            : radii.personnelM;
      return {
        ...occupant,
        distanceM: distance,
        limitM: limit,
        bearingDeg: roundTo(
          bearingBetween(
            point(shotCentre.easting, shotCentre.northing),
            point(occupant.easting, occupant.northing),
          ),
          1,
        ),
        inside: distance < limit,
      };
    })
    .filter((occupant) => occupant.inside);
}
