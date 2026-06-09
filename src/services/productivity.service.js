/**
 * How the site is actually going.
 *
 * Drilling metres per hour, tonnes per digging hour, and the two ratios that
 * connect them to the blasting: metres drilled per tonne broken, and explosive
 * per tonne. Those two are what move when a designer changes a pattern, and they
 * are the numbers a quarry manager can act on without knowing what a powder
 * factor is.
 *
 * Everything here is read from records that were written for another reason.
 * Nothing asks anybody to fill in a form for the sake of a report, because a
 * report fed by its own form is a report that stops being true in about a month.
 */

import { roundTo } from '../lib/units.js';
import { ValidationError } from '../lib/errors.js';
import { listRigs, rigProductivity } from '../db/repositories/rigs.js';
import { listBlasts } from '../db/repositories/blasts.js';
import {
  listDigRecords,
  listSurveys,
  secondaryBreakingHours,
} from '../db/repositories/production.js';
import { preferredSurvey, digRate } from '../domain/production/survey.js';
import { metresDrilled, totalExplosiveKg } from '../db/repositories/blast-facts.js';

export function createProductivityService({ db, clock }) {
  function period({ siteId, from, to }) {
    if (!from || !to) {
      throw new ValidationError('a productivity report needs a period', [
        { path: 'from', message: 'give a from and a to', kind: 'missing' },
      ]);
    }
    const fired = listBlasts(db, siteId, { pageSize: 200 }).filter(
      (blast) => blast.firedAt && blast.firedAt >= from && blast.firedAt <= to,
    );

    const shots = fired.map((blast) => {
      const surveys = listSurveys(db, blast.id);
      const survey = preferredSurvey(surveys);
      const digging = digRate(listDigRecords(db, blast.id));
      const metres = metresDrilled(db, blast.patternId);
      const explosiveKg = totalExplosiveKg(db, blast.id);
      const tonnes = survey?.tonnes ?? (blast.volumeM3 ? roundTo(blast.volumeM3 * 2.7, 2) : null);
      return {
        blastId: blast.id,
        reference: blast.reference,
        firedAt: blast.firedAt,
        metresDrilled: metres,
        explosiveKg,
        tonnes,
        surveyed: Boolean(survey),
        digging,
        secondaryBreakingHours: secondaryBreakingHours(db, blast.id),
        metresPerTonne: tonnes ? roundTo(metres / tonnes, 5) : null,
        explosivePerTonne: tonnes ? roundTo(explosiveKg / tonnes, 5) : null,
      };
    });

    const tonnes = roundTo(
      shots.reduce((sum, shot) => sum + (shot.tonnes ?? 0), 0),
      2,
    );
    const metres = roundTo(
      shots.reduce((sum, shot) => sum + shot.metresDrilled, 0),
      2,
    );
    const explosiveKg = roundTo(
      shots.reduce((sum, shot) => sum + shot.explosiveKg, 0),
      2,
    );
    const diggingHours = roundTo(
      shots.reduce((sum, shot) => sum + shot.digging.hours, 0),
      2,
    );
    const hammerHours = roundTo(
      shots.reduce((sum, shot) => sum + shot.secondaryBreakingHours, 0),
      2,
    );

    return {
      siteId,
      from,
      to,
      shots,
      blastCount: shots.length,
      tonnes,
      metresDrilled: metres,
      explosiveKg,
      diggingHours,
      secondaryBreakingHours: hammerHours,
      metresPerTonne: tonnes > 0 ? roundTo(metres / tonnes, 5) : null,
      explosivePerTonne: tonnes > 0 ? roundTo(explosiveKg / tonnes, 5) : null,
      tonnesPerDiggingHour: diggingHours > 0 ? roundTo(tonnes / diggingHours, 2) : null,
      hammerHoursPerThousandTonnes: tonnes > 0 ? roundTo((hammerHours / tonnes) * 1000, 4) : null,
      surveyedShots: shots.filter((shot) => shot.surveyed).length,
    };
  }

  /** The rigs, side by side, over the same period. */
  function rigs({ siteId, from, to }) {
    // Sorted before the working set is taken, because sort works in place and
    // taking the filtered list first leaves it in the old order: the fastest rig
    // read as the first one added rather than the first one in the list.
    const fleet = listRigs(db, siteId)
      .map((rig) => ({ rig, productivity: rigProductivity(db, rig.id, { from, to }) }))
      .sort((a, b) => (b.productivity.metresPerHour ?? -1) - (a.productivity.metresPerHour ?? -1));
    const working = fleet.filter((entry) => entry.productivity.shifts > 0);
    return {
      siteId,
      from,
      to,
      rigs: fleet,
      workingCount: working.length,
      totalMetres: roundTo(
        working.reduce((sum, entry) => sum + entry.productivity.metres, 0),
        2,
      ),
      bestMetresPerHour: working.length > 0 ? working[0].productivity.metresPerHour : null,
      downtimeMinutes: roundTo(
        working.reduce((sum, entry) => sum + (entry.productivity.downtimeMinutes ?? 0), 0),
        1,
      ),
    };
  }

  /** Two periods against each other, which is the only way a trend reads. */
  function trend({ siteId, current, previous }) {
    const now = period({ siteId, ...current });
    const before = period({ siteId, ...previous });
    const change = (key) => {
      const from = before[key];
      const to = now[key];
      if (from === null || to === null || from === 0) {
        return { from, to, percent: null };
      }
      return { from, to, percent: roundTo(((to - from) / from) * 100, 2) };
    };
    return {
      current: now,
      previous: before,
      generatedAt: clock.now(),
      changes: {
        tonnes: change('tonnes'),
        metresPerTonne: change('metresPerTonne'),
        explosivePerTonne: change('explosivePerTonne'),
        tonnesPerDiggingHour: change('tonnesPerDiggingHour'),
        hammerHoursPerThousandTonnes: change('hammerHoursPerThousandTonnes'),
      },
    };
  }

  return { period, rigs, trend };
}
