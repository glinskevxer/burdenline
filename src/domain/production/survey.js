/**
 * What the shot actually yielded.
 *
 * Three numbers describe the same rock and they never agree. The design volume
 * is burden times spacing times bench height times holes. The surveyed volume is
 * what the scanner measured between the before and after surfaces. The trucked
 * tonnage is what the weighbridge counted. The differences are not noise: the
 * first gap is overbreak or a face that was not where the plan said it was, and
 * the second is moisture, spillage and material left in the muckpile.
 *
 * Reporting a single volume hides all of that, so this keeps all three and
 * reports the differences as their own numbers.
 */

import { roundTo } from '../../lib/units.js';
import { requirePositive, requireNonNegative } from '../../lib/guards.js';
import { ValidationError } from '../../lib/errors.js';

export const SURVEY_METHODS = [
  'laser_scan',
  'drone_photogrammetry',
  'total_station',
  'truck_count',
  'weighbridge',
];

/** How much a method can be trusted, which decides which one wins a disagreement. */
export const METHOD_CONFIDENCE = Object.freeze({
  laser_scan: 0.98,
  drone_photogrammetry: 0.95,
  total_station: 0.9,
  weighbridge: 0.92,
  truck_count: 0.75,
});

export function tonnesFrom({ volumeM3, densityKgM3 }) {
  requirePositive(volumeM3, 'volumeM3');
  requirePositive(densityKgM3, 'densityKgM3');
  return roundTo((volumeM3 * densityKgM3) / 1000, 2);
}

export function volumeFrom({ tonnes, densityKgM3 }) {
  requirePositive(tonnes, 'tonnes');
  requirePositive(densityKgM3, 'densityKgM3');
  return roundTo((tonnes * 1000) / densityKgM3, 2);
}

/** The design against the survey. Positive overbreak means more rock came out. */
export function reconcileVolume({ designedM3, surveyedM3, toleranceFraction = 0.1 }) {
  requirePositive(designedM3, 'designedM3');
  requirePositive(surveyedM3, 'surveyedM3');
  const difference = roundTo(surveyedM3 - designedM3, 2);
  const fraction = roundTo(difference / designedM3, 4);
  return {
    designedM3,
    surveyedM3,
    overbreakM3: difference,
    overbreakFraction: fraction,
    withinTolerance: Math.abs(fraction) <= toleranceFraction,
    verdict:
      fraction > toleranceFraction
        ? 'overbreak'
        : fraction < -toleranceFraction
          ? 'underbreak'
          : 'as_designed',
  };
}

/** The survey against the weighbridge. */
export function reconcileTonnage({
  surveyedM3,
  densityKgM3,
  truckedTonnes,
  toleranceFraction = 0.05,
}) {
  const expected = tonnesFrom({ volumeM3: surveyedM3, densityKgM3 });
  requireNonNegative(truckedTonnes, 'truckedTonnes');
  const difference = roundTo(truckedTonnes - expected, 2);
  const fraction = expected === 0 ? 0 : roundTo(difference / expected, 4);
  return {
    expectedTonnes: expected,
    truckedTonnes,
    differenceTonnes: difference,
    differenceFraction: fraction,
    withinTolerance: Math.abs(fraction) <= toleranceFraction,
  };
}

/** Pick the survey to report on when there is more than one. */
export function preferredSurvey(surveys) {
  if (!Array.isArray(surveys) || surveys.length === 0) {
    return null;
  }
  return surveys.slice().sort((a, b) => {
    const confidence = (METHOD_CONFIDENCE[b.method] ?? 0) - (METHOD_CONFIDENCE[a.method] ?? 0);
    return confidence !== 0 ? confidence : b.surveyedAt.localeCompare(a.surveyedAt);
  })[0];
}

/** Loading productivity, which is the other half of what a shot was worth. */
export function digRate(records) {
  if (!Array.isArray(records) || records.length === 0) {
    return {
      tonnes: 0,
      hours: 0,
      tonnesPerHour: null,
      delayMinutes: 0,
      availability: null,
      days: 0,
    };
  }
  const tonnes = roundTo(
    records.reduce((sum, record) => sum + record.tonnes, 0),
    2,
  );
  const hours = roundTo(
    records.reduce((sum, record) => sum + record.hours, 0),
    2,
  );
  const delayMinutes = roundTo(
    records.reduce((sum, record) => sum + (record.delayMinutes ?? 0), 0),
    1,
  );
  const scheduled = hours + delayMinutes / 60;
  return {
    tonnes,
    hours,
    delayMinutes,
    days: new Set(records.map((record) => record.recordedOn)).size,
    tonnesPerHour: hours > 0 ? roundTo(tonnes / hours, 2) : null,
    availability: scheduled > 0 ? roundTo(hours / scheduled, 4) : null,
    delaysByReason: records
      .filter((record) => (record.delayMinutes ?? 0) > 0)
      .reduce((tally, record) => {
        const reason = record.delayReason ?? 'not recorded';
        tally[reason] = roundTo((tally[reason] ?? 0) + record.delayMinutes, 1);
        return tally;
      }, {}),
  };
}

/**
 * Everything about the yield of one shot, which is what goes on the report
 * beside the cost.
 */
export function yieldOf({
  designedM3,
  surveys = [],
  digRecords = [],
  densityKgM3 = 2700,
  truckedTonnes = null,
}) {
  const survey = preferredSurvey(surveys);
  if (!survey && designedM3 === undefined) {
    throw new ValidationError('there is nothing to work a yield out from', [
      { path: 'surveys', message: 'no survey and no design volume', kind: 'missing' },
    ]);
  }
  const digging = digRate(digRecords);
  const surveyedM3 = survey?.volumeM3 ?? null;
  return {
    designedM3: designedM3 ?? null,
    survey,
    surveyedM3,
    volume: surveyedM3 && designedM3 ? reconcileVolume({ designedM3, surveyedM3 }) : null,
    tonnage:
      surveyedM3 && truckedTonnes !== null
        ? reconcileTonnage({ surveyedM3, densityKgM3, truckedTonnes })
        : null,
    tonnes: surveyedM3 ? tonnesFrom({ volumeM3: surveyedM3, densityKgM3 }) : null,
    digging,
  };
}
