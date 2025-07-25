/**
 * Weather on the day.
 *
 * Three things stop a shot. Lightning within striking distance is absolute and
 * has nothing to do with the design: an electric storm near loaded holes clears
 * the bench whatever else is true. A temperature inversion bends the airblast
 * back down at distance, which is how a quarry that has fired the same shot for
 * years suddenly gets complaints from a village four kilometres away. And wind
 * blowing hard toward an occupied receptor carries both the airblast and the
 * fume.
 *
 * Fume matters as much as noise. A shot in wet ground makes orange nitrous fume
 * and it has to blow away from the road and the houses, so the wind direction
 * check is against the receptors rather than against a fixed compass sector.
 */

import { z } from 'zod';
import { ValidationError } from '../../lib/errors.js';
import { roundTo } from '../../lib/units.js';
import { bearingDifference } from '../geometry/points.js';
import { collector } from '../violations.js';

export const DEFAULT_WEATHER_RULES = Object.freeze({
  maximumWindSpeedMs: 12,
  downwindSectorDeg: 45,
  downwindWindSpeedMs: 6,
  lightningDistanceKm: 15,
  minimumVisibilityM: 200,
  inversionBlocks: true,
  fumeRiskWindMinimumMs: 2,
});

export const observationSchema = z.object({
  observedAt: z.string().min(1),
  windSpeedMs: z.number().min(0).max(60),
  windBearingDeg: z.number().min(0).lt(360),
  temperatureC: z.number().min(-40).max(55),
  temperatureAt10mC: z.number().min(-40).max(55).nullable().default(null),
  visibilityM: z.number().min(0).max(50000).nullable().default(null),
  cloudBaseM: z.number().min(0).max(10000).nullable().default(null),
  lightningDistanceKm: z.number().min(0).max(200).nullable().default(null),
  rainfallMmPerHour: z.number().min(0).max(200).default(0),
  observedBy: z.string().max(80).nullable().default(null),
});

export function parseObservation(input) {
  const parsed = observationSchema.safeParse(input);
  if (!parsed.success) {
    throw ValidationError.fromZod(parsed.error, 'the weather observation is not usable');
  }
  return Object.freeze(parsed.data);
}

/**
 * An inversion is warmer air sitting on colder air. Measured by the difference
 * between the temperature at ground level and at ten metres: if it is warmer up
 * there, the air is stable and sound refracts back down.
 */
export function inversionPresent(observation, thresholdC = 0.5) {
  if (observation.temperatureAt10mC === null) {
    return null;
  }
  return observation.temperatureAt10mC - observation.temperatureC >= thresholdC;
}

/** Is a receptor downwind, and by how much is it off the wind axis? */
export function downwindStatus(observation, receptorBearingDeg, rules = DEFAULT_WEATHER_RULES) {
  const offAxis = Math.abs(bearingDifference(observation.windBearingDeg, receptorBearingDeg));
  return {
    offAxisDeg: roundTo(offAxis, 1),
    downwind: offAxis <= rules.downwindSectorDeg,
    crosswind: offAxis > rules.downwindSectorDeg && offAxis < 135,
    upwind: offAxis >= 135,
  };
}

/**
 * Judge the conditions. Receptors are given with their bearing from the shot so
 * that the wind rules can be applied to the ones that would actually get it.
 */
export function checkConditions({
  observation,
  receptors = [],
  rules = DEFAULT_WEATHER_RULES,
  wetHoles = false,
}) {
  const found = collector();
  const inversion = inversionPresent(observation);

  if (
    observation.lightningDistanceKm !== null &&
    observation.lightningDistanceKm <= rules.lightningDistanceKm
  ) {
    found.add('weather.lightning', `lightning ${observation.lightningDistanceKm} km away`, {
      actual: observation.lightningDistanceKm,
      required: rules.lightningDistanceKm,
    });
  }
  found.atMost(
    observation.windSpeedMs,
    rules.maximumWindSpeedMs,
    'weather.wind_too_strong',
    `wind of ${observation.windSpeedMs} metres a second`,
  );
  if (inversion && rules.inversionBlocks) {
    found.add('weather.inversion', 'a temperature inversion is sitting over the site', {
      actual: observation.temperatureAt10mC - observation.temperatureC,
    });
  }
  if (observation.visibilityM !== null && observation.visibilityM < rules.minimumVisibilityM) {
    found.add('weather.visibility', `visibility is down to ${observation.visibilityM} m`, {
      actual: observation.visibilityM,
      required: rules.minimumVisibilityM,
    });
  }

  const downwind = [];
  for (const receptor of receptors) {
    const status = downwindStatus(observation, receptor.bearingDeg, rules);
    if (!status.downwind) {
      continue;
    }
    downwind.push({ receptorId: receptor.id, ...status });
    if (observation.windSpeedMs >= rules.downwindWindSpeedMs && receptor.occupied) {
      found.add(
        'weather.downwind_receptor',
        `${receptor.name} is downwind in a ${observation.windSpeedMs} metre a second wind`,
        {
          receptorId: receptor.id,
          actual: observation.windSpeedMs,
          required: rules.downwindWindSpeedMs,
        },
      );
    }
    if (wetHoles && observation.windSpeedMs < rules.fumeRiskWindMinimumMs) {
      found.add('weather.fume_risk', `wet holes and no wind to clear fume from ${receptor.name}`, {
        receptorId: receptor.id,
      });
    }
  }

  return found.result({
    observedAt: observation.observedAt,
    inversion,
    downwind,
    windSpeedMs: observation.windSpeedMs,
    firable: found.length === 0,
  });
}

/** How long the crew should wait after firing before going back in, for fume. */
export function reentryDelayMinutes({
  observation,
  wetHoles = false,
  rules = DEFAULT_WEATHER_RULES,
}) {
  let minutes = 5;
  if (wetHoles) {
    minutes += 10;
  }
  if (observation.windSpeedMs < rules.fumeRiskWindMinimumMs) {
    minutes += 15;
  }
  if (inversionPresent(observation)) {
    minutes += 10;
  }
  if (observation.rainfallMmPerHour > 2) {
    minutes += 5;
  }
  return minutes;
}
