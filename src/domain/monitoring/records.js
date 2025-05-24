/**
 * Seismograph records.
 *
 * A monitor reports three components of ground motion and an airblast channel.
 * The number a limit is judged against is the largest of the three components,
 * not the vector sum: the standards are written on peak particle velocity per
 * component, and reporting the vector sum against a component limit overstates
 * every event by up to seventy percent. The vector sum is kept because some
 * agreements are written on it, but it is a separate field and it is never
 * silently substituted.
 */

import { z } from 'zod';
import { ValidationError } from '../../lib/errors.js';
import { roundTo } from '../../lib/units.js';
import { isInstant } from '../../lib/clock.js';

export const COMPONENTS = ['longitudinal', 'transverse', 'vertical'];

const channel = z.object({
  peakMmPerSecond: z.number().min(0).max(1000),
  frequencyHz: z.number().min(0.5).max(500).nullable().default(null),
});

export const recordSchema = z.object({
  monitorSerial: z.string().min(1).max(40),
  receptorId: z.string().min(1).nullable().default(null),
  blastReference: z.string().max(24).nullable().default(null),
  triggeredAt: z.string().refine(isInstant, 'a record needs a valid trigger time'),
  distanceM: z.number().positive().max(20000).nullable().default(null),
  longitudinal: channel,
  transverse: channel,
  vertical: channel,
  airblastDb: z.number().min(60).max(180).nullable().default(null),
  airblastFrequencyHz: z.number().min(0.1).max(500).nullable().default(null),
  triggerLevelMmPerSecond: z.number().min(0).max(100).nullable().default(null),
  note: z.string().max(500).nullable().default(null),
});

export function parseRecord(input) {
  const parsed = recordSchema.safeParse(input);
  if (!parsed.success) {
    throw ValidationError.fromZod(parsed.error, 'the monitor record is not usable');
  }
  return Object.freeze(enrich(parsed.data));
}

function enrich(record) {
  const components = COMPONENTS.map((name) => ({ name, ...record[name] }));
  const peak = components.reduce((highest, component) =>
    component.peakMmPerSecond > highest.peakMmPerSecond ? component : highest,
  );
  const vectorSum = Math.hypot(
    record.longitudinal.peakMmPerSecond,
    record.transverse.peakMmPerSecond,
    record.vertical.peakMmPerSecond,
  );
  return {
    ...record,
    peakMmPerSecond: roundTo(peak.peakMmPerSecond, 4),
    peakComponent: peak.name,
    peakFrequencyHz: peak.frequencyHz,
    vectorSumMmPerSecond: roundTo(vectorSum, 4),
  };
}

/**
 * A record that never rose above the trigger level is a record of nothing
 * happening, which is worth keeping but must not be fed to a site law fit.
 */
export function isTriggered(record) {
  if (record.triggerLevelMmPerSecond === null || record.triggerLevelMmPerSecond === undefined) {
    return record.peakMmPerSecond > 0;
  }
  return record.peakMmPerSecond >= record.triggerLevelMmPerSecond;
}

/** Records fit to fit a site law with: triggered, at a known distance, from a known shot. */
export function usableForFit(records) {
  return records.filter(
    (record) =>
      isTriggered(record) &&
      record.distanceM !== null &&
      record.distanceM > 0 &&
      record.peakMmPerSecond > 0,
  );
}

/** Match a record to a shot by time, since not every monitor writes the reference. */
export function matchToBlast(record, blasts, toleranceSeconds = 120) {
  const triggered = Date.parse(record.triggeredAt);
  const candidates = blasts
    .map((blast) => ({
      blast,
      gapSeconds: Math.abs(Date.parse(blast.firedAt) - triggered) / 1000,
    }))
    .filter((candidate) => candidate.gapSeconds <= toleranceSeconds)
    .sort((a, b) => a.gapSeconds - b.gapSeconds);
  if (candidates.length === 0) {
    return { matched: false, blast: null, gapSeconds: null, ambiguous: false };
  }
  return {
    matched: true,
    blast: candidates[0].blast,
    gapSeconds: roundTo(candidates[0].gapSeconds, 1),
    ambiguous: candidates.length > 1,
  };
}

export function summariseRecords(records) {
  const triggered = records.filter((record) => isTriggered(record));
  if (triggered.length === 0) {
    return { count: records.length, triggeredCount: 0, highest: null, meanPeak: null };
  }
  const peaks = triggered.map((record) => record.peakMmPerSecond);
  return {
    count: records.length,
    triggeredCount: triggered.length,
    highest: triggered.reduce((best, record) =>
      record.peakMmPerSecond > best.peakMmPerSecond ? record : best,
    ),
    meanPeak: roundTo(peaks.reduce((sum, peak) => sum + peak, 0) / peaks.length, 4),
    highestAirblastDb: triggered.reduce(
      (best, record) =>
        record.airblastDb !== null && record.airblastDb > best ? record.airblastDb : best,
      Number.NEGATIVE_INFINITY,
    ),
  };
}
