/**
 * What the shot actually did.
 *
 * The inspection is walked as soon as the fume has cleared and re-entry time is
 * up. It records five things that between them explain most of what goes wrong
 * on the next shot: how far the muckpile threw and how loose it is, whether the
 * toe came out, how far the crest broke back behind the last row, how many
 * boulders are in it, and whether anything failed to go off.
 *
 * A misfire is not a grading. It stops the muckpile being dug and it is recorded
 * separately with the holes named, because those holes have to be accounted for
 * before anybody works the face.
 */

import { z } from 'zod';
import { ValidationError } from '../../lib/errors.js';
import { roundTo } from '../../lib/units.js';
import { collector } from '../violations.js';

export const MUCKPILE_SHAPES = ['tight', 'moderate', 'loose', 'cast'];
export const TOE_GRADES = ['none', 'slight', 'moderate', 'severe'];

export const inspectionSchema = z.object({
  blastId: z.string().min(1),
  inspectedAt: z.string().min(1),
  inspectedBy: z.string().min(1),
  muckpileShape: z.enum(['tight', 'moderate', 'loose', 'cast']),
  throwM: z.number().min(0).max(200),
  muckpileHeightM: z.number().min(0).max(60).nullable().default(null),
  toeGrade: z.enum(['none', 'slight', 'moderate', 'severe']),
  toeLengthM: z.number().min(0).max(500).default(0),
  backbreakM: z.number().min(0).max(30).default(0),
  oversizeCount: z.number().int().min(0).max(5000).default(0),
  faceStable: z.boolean().default(true),
  flyrockObserved: z.boolean().default(false),
  fumeGrade: z.number().int().min(0).max(5).default(0),
  note: z.string().max(1000).nullable().default(null),
});

export function parseInspection(input) {
  const parsed = inspectionSchema.safeParse(input);
  if (!parsed.success) {
    throw ValidationError.fromZod(parsed.error, 'the inspection is not usable');
  }
  return Object.freeze(parsed.data);
}

export const misfireSchema = z.object({
  blastId: z.string().min(1),
  holeNumbers: z.array(z.number().int().positive()).min(1),
  kind: z.enum(['unfired_hole', 'partial_detonation', 'cut_off', 'unaccounted_explosive']),
  discoveredAt: z.string().min(1),
  discoveredBy: z.string().min(1),
  explosiveEstimateKg: z.number().min(0).max(10000).nullable().default(null),
  description: z.string().min(10).max(2000),
  reportedToRegulator: z.boolean().default(false),
});

export function parseMisfire(input) {
  const parsed = misfireSchema.safeParse(input);
  if (!parsed.success) {
    throw ValidationError.fromZod(parsed.error, 'the misfire record is not usable');
  }
  return Object.freeze(parsed.data);
}

/**
 * Score the shot out of a hundred. The weights are the site's and they are
 * arguable; what is not arguable is that the score is never used on its own,
 * because a shot that threw rock over the boundary can score well on everything
 * else.
 */
export function score(inspection, options = {}) {
  const weights = {
    fragmentation: 30,
    toe: 25,
    backbreak: 20,
    throw: 15,
    muckpile: 10,
    ...(options.weights ?? {}),
  };
  const holeCount = options.holeCount ?? 1;
  const oversizePerHole = inspection.oversizeCount / holeCount;
  const parts = {
    fragmentation: clampScore(1 - oversizePerHole / (options.oversizeTolerancePerHole ?? 1)),
    toe: { none: 1, slight: 0.75, moderate: 0.4, severe: 0 }[inspection.toeGrade],
    backbreak: clampScore(1 - inspection.backbreakM / (options.backbreakToleranceM ?? 3)),
    throw: clampScore(1 - inspection.throwM / (options.throwToleranceM ?? 40)),
    muckpile: { tight: 0.5, moderate: 1, loose: 0.9, cast: 0.7 }[inspection.muckpileShape],
  };
  const total = Object.entries(weights).reduce(
    (sum, [key, weight]) => sum + parts[key] * weight,
    0,
  );
  return {
    parts: Object.fromEntries(
      Object.entries(parts).map(([key, value]) => [key, roundTo(value, 3)]),
    ),
    weights,
    total: roundTo(total, 1),
    grade: total >= 80 ? 'good' : total >= 60 ? 'acceptable' : 'poor',
  };
}

/** What has to happen before the muckpile can be dug. */
export function actionsRequired(inspection, misfires = []) {
  const found = collector();
  if (misfires.length > 0) {
    found.add('postblast.misfire', 'the shot has a misfire recorded against it', {
      holes: misfires.flatMap((misfire) => misfire.holeNumbers),
    });
  }
  if (!inspection.faceStable) {
    found.add('postblast.face_unstable', 'the face was left unstable', {});
  }
  if (inspection.flyrockObserved) {
    found.add('postblast.flyrock', 'flyrock was observed and has to be investigated', {});
  }
  if (inspection.fumeGrade >= 3) {
    found.add('postblast.fume', `fume was graded ${inspection.fumeGrade}`, {
      actual: inspection.fumeGrade,
      required: 2,
    });
  }
  if (inspection.toeGrade === 'severe') {
    found.add('postblast.toe', 'severe toe needs secondary breaking before digging', {});
  }
  return found.result({
    diggable: found.length === 0,
    blastId: inspection.blastId,
  });
}

/** Rolled up over a run of shots, which is what the monthly review reads. */
export function trend(inspections, options = {}) {
  if (inspections.length === 0) {
    return { count: 0, meanScore: null, worst: null, toeRate: null, flyrockCount: 0 };
  }
  const scored = inspections.map((inspection) => ({
    inspection,
    score: score(inspection, options),
  }));
  const totals = scored.map((entry) => entry.score.total);
  return {
    count: inspections.length,
    meanScore: roundTo(totals.reduce((sum, value) => sum + value, 0) / totals.length, 1),
    best: scored.reduce((best, entry) => (entry.score.total > best.score.total ? entry : best))
      .inspection.blastId,
    worst: scored.reduce((worst, entry) => (entry.score.total < worst.score.total ? entry : worst))
      .inspection.blastId,
    toeRate: roundTo(
      inspections.filter((inspection) => ['moderate', 'severe'].includes(inspection.toeGrade))
        .length / inspections.length,
      3,
    ),
    flyrockCount: inspections.filter((inspection) => inspection.flyrockObserved).length,
    meanBackbreakM: roundTo(
      inspections.reduce((sum, inspection) => sum + inspection.backbreakM, 0) / inspections.length,
      2,
    ),
  };
}

function clampScore(value) {
  return Math.min(Math.max(value, 0), 1);
}
