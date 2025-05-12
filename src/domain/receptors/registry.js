/**
 * Sensitive receptors.
 *
 * Everything the shot has to be kept off: houses, the water treatment works, the
 * gas main crossing the access road, the church with the plasterwork. Each one
 * carries where it is, what kind of structure it is, and whatever limit its own
 * agreement or the planning permission puts on it. Distances are measured from
 * the nearest charged hole, not from the middle of the pattern, because a shot
 * two hundred metres long changes the answer by more than the safety margin.
 */

import { z } from 'zod';
import { ValidationError } from '../../lib/errors.js';
import { roundTo } from '../../lib/units.js';
import { planDistance, point } from '../geometry/points.js';

export const STRUCTURE_CLASSES = [
  'dwelling',
  'older_dwelling',
  'listed',
  'heritage',
  'commercial',
  'industrial',
  'buried_service',
  'water_feature',
];

export const receptorSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(2).max(120),
  structureClass: z.enum([
    'dwelling',
    'older_dwelling',
    'listed',
    'heritage',
    'commercial',
    'industrial',
    'buried_service',
    'water_feature',
  ]),
  easting: z.number().finite(),
  northing: z.number().finite(),
  level: z.number().finite().default(0),
  occupied: z.boolean().default(true),
  limitMmPerSecond: z.number().positive().max(200).nullable().default(null),
  airblastLimitDb: z.number().min(90).max(160).nullable().default(null),
  monitored: z.boolean().default(false),
  notifiable: z.boolean().default(false),
  note: z.string().max(500).nullable().default(null),
});

export function parseReceptor(input) {
  const parsed = receptorSchema.safeParse(input);
  if (!parsed.success) {
    throw ValidationError.fromZod(parsed.error, 'the receptor is not usable');
  }
  return Object.freeze(parsed.data);
}

/** Distance from a receptor to the nearest charged hole in the pattern. */
export function distanceToPattern(receptor, holes) {
  if (!Array.isArray(holes) || holes.length === 0) {
    throw new ValidationError('there are no holes to measure from', [
      { path: 'holes', message: 'the pattern is empty', kind: 'missing' },
    ]);
  }
  const target = point(receptor.easting, receptor.northing, receptor.level ?? 0);
  let nearest = { distanceM: Infinity, holeNumber: null };
  for (const hole of holes) {
    const collar = point(hole.easting, hole.northing, hole.collarLevelM ?? 0);
    const distance = planDistance(target, collar);
    if (distance < nearest.distanceM) {
      nearest = { distanceM: roundTo(distance, 2), holeNumber: hole.holeNumber };
    }
  }
  return nearest;
}

export function withDistances(receptors, holes) {
  return receptors
    .map((receptor) => {
      const nearest = distanceToPattern(receptor, holes);
      return {
        receptor,
        distanceM: nearest.distanceM,
        nearestHoleNumber: nearest.holeNumber,
      };
    })
    .sort((a, b) => a.distanceM - b.distanceM);
}

export function nearest(receptors, holes, count = 5) {
  if (!Number.isInteger(count) || count < 1) {
    throw new ValidationError('ask for at least one receptor', [
      { path: 'count', message: 'must be a positive whole number', kind: 'range' },
    ]);
  }
  return withDistances(receptors, holes).slice(0, count);
}

export function within(receptors, holes, radiusM) {
  if (!(radiusM > 0)) {
    throw new ValidationError('a radius has to be positive', [
      { path: 'radiusM', message: 'must be greater than zero', kind: 'range' },
    ]);
  }
  return withDistances(receptors, holes).filter((entry) => entry.distanceM <= radiusM);
}

/** Everyone who has to be told before the shot goes off. */
export function notifiable(receptors, holes, radiusM) {
  return within(receptors, holes, radiusM).filter(
    (entry) => entry.receptor.notifiable || entry.receptor.occupied,
  );
}

/** A quick count of what sits around the pattern, for the design sheet. */
export function summarise(receptors, holes, radiusM = 1000) {
  const inRange = within(receptors, holes, radiusM);
  const byClass = inRange.reduce((tally, entry) => {
    tally[entry.receptor.structureClass] = (tally[entry.receptor.structureClass] ?? 0) + 1;
    return tally;
  }, {});
  return {
    radiusM,
    count: inRange.length,
    byClass,
    nearest: inRange[0] ?? null,
    monitoredCount: inRange.filter((entry) => entry.receptor.monitored).length,
    occupiedCount: inRange.filter((entry) => entry.receptor.occupied).length,
  };
}
