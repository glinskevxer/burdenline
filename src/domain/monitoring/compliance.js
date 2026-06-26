/**
 * Judging what the monitors recorded.
 *
 * A record on its own is a number. Compliance is that number against the limit
 * that applies to that receptor at that frequency, and then the same question
 * asked of the airblast channel, which fails independently and more often. An
 * event that breaches either is an exceedance and it has to be reported whether
 * or not anybody complained.
 *
 * The severity bands are the site's own escalation, not a legal grading: a
 * reading over the limit is reported to the regulator, a reading over ninety
 * percent of it stops the next shot until the design is looked at again.
 */

import { roundTo } from '../../lib/units.js';
import { ValidationError } from '../../lib/errors.js';
import { curveForReceptor, evaluate } from '../vibration/limits.js';
import { assessAirblast } from '../vibration/airblast.js';
import { isTriggered } from './records.js';

export const SEVERITIES = ['none', 'watch', 'approaching', 'exceedance'];

export const DEFAULT_THRESHOLDS = Object.freeze({
  watch: 0.75,
  approaching: 0.9,
});

export function severityFor(ratio, thresholds = DEFAULT_THRESHOLDS) {
  if (ratio > 1) {
    return 'exceedance';
  }
  if (ratio >= thresholds.approaching) {
    return 'approaching';
  }
  if (ratio >= thresholds.watch) {
    return 'watch';
  }
  return 'none';
}

/** One record against one receptor, on both channels. */
export function evaluateRecord(record, receptor, options = {}) {
  if (!receptor) {
    throw new ValidationError('a record cannot be judged without a receptor', [
      { path: 'receptor', message: 'no receptor given', kind: 'missing' },
    ]);
  }
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds ?? {}) };
  const curve = curveForReceptor(receptor);
  const ground = evaluate(
    { peakMmPerSecond: record.peakMmPerSecond, frequencyHz: record.peakFrequencyHz },
    curve,
  );
  const air =
    record.airblastDb === null || record.airblastDb === undefined
      ? null
      : assessAirblast({ predictedDb: record.airblastDb, receptor });
  const groundSeverity = severityFor(ground.ratio, thresholds);
  const airRatio = air ? roundTo(air.predictedDb / air.limitDb, 4) : 0;
  const airSeverity = air && !air.compliant ? 'exceedance' : 'none';

  return {
    receptorId: receptor.id,
    monitorSerial: record.monitorSerial,
    triggeredAt: record.triggeredAt,
    triggered: isTriggered(record),
    ground,
    air,
    airRatio,
    severity: worst(groundSeverity, airSeverity),
    groundSeverity,
    airSeverity,
    exceedance: groundSeverity === 'exceedance' || airSeverity === 'exceedance',
    channels: [
      ...(groundSeverity === 'exceedance' ? ['ground'] : []),
      ...(airSeverity === 'exceedance' ? ['airblast'] : []),
    ],
  };
}

export function evaluateAll(records, receptorsById, options = {}) {
  const results = [];
  const unmatched = [];
  for (const record of records) {
    const receptor = receptorsById.get(record.receptorId);
    if (!receptor) {
      unmatched.push(record);
      continue;
    }
    results.push(evaluateRecord(record, receptor, options));
  }
  return { results, unmatched };
}

export function exceedances(evaluations) {
  return evaluations.filter((evaluation) => evaluation.exceedance);
}

/**
 * A receptor that goes over more than once in a rolling period is a different
 * problem from one that went over once, and the escalation is written against
 * that rather than against the single event.
 */
export function repeatExceedances(evaluations, { withinDays = 90, minimumCount = 2 } = {}) {
  const byReceptor = new Map();
  for (const evaluation of exceedances(evaluations)) {
    const list = byReceptor.get(evaluation.receptorId) ?? [];
    list.push(evaluation);
    byReceptor.set(evaluation.receptorId, list);
  }
  const windowMs = withinDays * 24 * 60 * 60 * 1000;
  const repeats = [];
  for (const [receptorId, list] of byReceptor) {
    const sorted = list.sort((a, b) => Date.parse(a.triggeredAt) - Date.parse(b.triggeredAt));
    for (let index = minimumCount - 1; index < sorted.length; index += 1) {
      const first = Date.parse(sorted[index - (minimumCount - 1)].triggeredAt);
      const last = Date.parse(sorted[index].triggeredAt);
      if (last - first <= windowMs) {
        repeats.push({
          receptorId,
          count: minimumCount,
          from: sorted[index - (minimumCount - 1)].triggeredAt,
          to: sorted[index].triggeredAt,
        });
        break;
      }
    }
  }
  return repeats;
}

export function complianceSummary(evaluations) {
  const counts = evaluations.reduce((tally, evaluation) => {
    tally[evaluation.severity] = (tally[evaluation.severity] ?? 0) + 1;
    return tally;
  }, {});
  const ratios = evaluations.map((evaluation) => evaluation.ground.ratio);
  return {
    recordCount: evaluations.length,
    counts,
    exceedanceCount: counts.exceedance ?? 0,
    worstRatio: ratios.length ? roundTo(Math.max(...ratios), 4) : null,
    compliant: (counts.exceedance ?? 0) === 0,
    channelsBreached: [...new Set(evaluations.flatMap((evaluation) => evaluation.channels))],
  };
}

/** The number the regulator wants: highest reading, its limit and when it happened. */
export function highestReading(evaluations) {
  if (evaluations.length === 0) {
    return null;
  }
  return evaluations.reduce((highest, candidate) =>
    candidate.ground.peakMmPerSecond > highest.ground.peakMmPerSecond ? candidate : highest,
  );
}

function worst(...severities) {
  return severities.reduce((highest, candidate) =>
    SEVERITIES.indexOf(candidate) > SEVERITIES.indexOf(highest) ? candidate : highest,
  );
}
