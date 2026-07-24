/**
 * Designing a shot.
 *
 * This is where the geometry, the charging, the timing and the vibration work
 * meet. Nothing here computes anything itself: it reads the bench and the holes,
 * hands them to the domain in the right order, and writes back the totals and
 * the load sheet. The order matters and it is the order a designer works in.
 * The pattern is laid out, the holes are charged against the burden that was
 * actually measured, the timing is built over the charged holes, the
 * instantaneous charge falls out of the timing, and only then can the vibration
 * be judged. Doing the vibration first, against a guess at the instantaneous
 * charge, is the mistake that produces a design nobody can fire.
 */

import { newId } from '../lib/ids.js';
import { roundTo } from '../lib/units.js';
import { ValidationError } from '../lib/errors.js';
import { layoutPattern, summarisePattern } from '../domain/geometry/pattern.js';
import { planPattern, loadSheet } from '../domain/charging/charge-plan.js';
import { checkPattern } from '../domain/charging/rules.js';
import { resolveFiringTimes } from '../domain/initiation/tie-in.js';
import { summariseTiming } from '../domain/initiation/windows.js';
import {
  checkTiming,
  checkRowRelief,
  checkWindowCrowding,
} from '../domain/initiation/timing-checks.js';
import { withDistances } from '../domain/receptors/registry.js';
import { assessDesign, allowances, reduction } from '../domain/vibration/allowance.js';
import { merge } from '../domain/violations.js';
import * as patterns from '../db/repositories/patterns.js';
import * as sites from '../db/repositories/sites.js';
import * as monitoring from '../db/repositories/monitoring.js';
import { rulesFor } from '../db/repositories/site-rules.js';

export function createDesignService({ db, clock, logger }) {
  const context = { clock };

  /** Lay a pattern out on a bench and write it with its holes. */
  function layOut({ benchId, reference, design: shape }) {
    const bench = sites.getBench(db, benchId);
    const benchHeightM = shape.benchHeightM ?? sites.benchHeightM(bench);
    const laid = layoutPattern({ ...shape, benchHeightM });
    const pattern = patterns.createPattern(
      db,
      {
        benchId,
        reference,
        layout: shape.layout ?? 'staggered',
        holeDiameterMm: shape.diameterMm,
        nominalBurdenM: shape.burdenM,
        nominalSpacingM: shape.spacingM,
        rowCount: shape.rowCount,
        holesPerRow: shape.holesPerRow,
        benchHeightM,
        subdrillM: shape.subdrillM ?? 0,
        inclinationDeg: shape.inclinationDeg ?? 0,
        bearingDeg: shape.faceBearingDeg,
        designedBy: shape.designedBy ?? null,
      },
      context,
    );
    patterns.replaceHoles(db, pattern.id, laid.holes, context);
    logger?.info?.({ patternId: pattern.id, holes: laid.holes.length }, 'pattern laid out');
    return {
      pattern,
      holes: patterns.listHoles(db, pattern.id),
      summary: summarisePattern({ ...shape, benchHeightM }, laid.holes),
    };
  }

  /** The rules in force at the site this pattern is on, unless the caller set them. */
  function rulesForPattern(patternId, ruleSet, given) {
    if (given) {
      return given;
    }
    const pattern = patterns.getPattern(db, patternId);
    const bench = sites.getBench(db, pattern.benchId);
    return rulesFor(db, bench.siteId, ruleSet).values;
  }

  /** Charge every drilled hole in a pattern to a target powder factor. */
  function planCharges({ patternId, catalogue, powderFactorKgM3, stemmingM, rules: given }) {
    const rules = rulesForPattern(patternId, 'charge', given);
    const pattern = patterns.getPattern(db, patternId);
    const holes = patterns.listHoles(db, patternId).map((hole) => ({
      ...hole,
      measuredBurdenM: hole.measuredBurdenM ?? pattern.nominalBurdenM,
      nominalBurdenM: pattern.nominalBurdenM,
    }));
    if (holes.length === 0) {
      throw new ValidationError('that pattern has no holes in it', [
        { path: 'patternId', message: 'lay the pattern out first', kind: 'missing' },
      ]);
    }
    const plan = planPattern(holes, {
      catalogue,
      burdenM: pattern.nominalBurdenM,
      spacingM: pattern.nominalSpacingM,
      benchHeightM: pattern.benchHeightM,
      powderFactorKgM3,
      stemmingM,
      rules,
    });
    const loaded = plan.holes.map((item) => ({
      hole: holes.find((hole) => hole.holeNumber === item.holeNumber),
      column: item.column,
    }));
    return { pattern, plan, sheet: loadSheet(plan), checks: checkPattern(loaded, rules) };
  }

  /** Resolve the tie-in and work out what the timing does to the charge. */
  function planTiming({ patternId, plan, tieIn, windowMs = 8, rules: given }) {
    const rules = rulesForPattern(patternId, 'timing', given);
    const holes = patterns.listHoles(db, patternId);
    const resolved = resolveFiringTimes(tieIn);
    const massByHole = new Map(plan.holes.map((item) => [item.holeNumber, item.loadedMassKg]));
    const timing = summariseTiming(resolved, massByHole, windowMs);
    const positions = holes.map((hole) => ({
      holeNumber: hole.holeNumber,
      rowNumber: hole.rowNumber,
      easting: hole.eastingM,
      northing: hole.northingM,
    }));
    const checks = merge(
      checkTiming(resolved, positions, { rules }),
      checkRowRelief(resolved, positions, {
        rules,
        burdenM: patterns.getPattern(db, patternId).nominalBurdenM,
      }),
      checkWindowCrowding(timing.heaviestWindow ? [timing.heaviestWindow] : [], { rules }),
    );
    return { resolved, timing, checks };
  }

  /** Judge the design against every receptor around the site. */
  function assessVibration({
    siteId,
    patternId,
    instantaneousChargeKg,
    frequencyHz,
    safetyFactor,
  }) {
    const law = monitoring.currentSiteLaw(db, siteId);
    if (!law) {
      throw new ValidationError('this site has no fitted vibration law', [
        {
          path: 'siteId',
          message: 'fit a site law from the monitor records first',
          kind: 'missing',
        },
      ]);
    }
    const holes = patterns.listHoles(db, patternId).map((hole) => ({
      holeNumber: hole.holeNumber,
      easting: hole.eastingM,
      northing: hole.northingM,
      collarLevelM: hole.collarLevelM,
    }));
    const receptors = monitoring.listReceptors(db, siteId);
    const withDistance = withDistances(receptors, holes);
    const assessment = assessDesign({
      fit: law,
      receptorsWithDistance: withDistance,
      instantaneousChargeKg,
      frequencyHz,
    });
    const allowanceSet = allowances({
      fit: law,
      receptorsWithDistance: withDistance,
      frequencyHz,
      safetyFactor,
    });
    return {
      law,
      assessment,
      allowances: allowanceSet,
      reduction: reduction(assessment, allowanceSet),
      receptorCount: withDistance.length,
    };
  }

  /** The whole design in one call, which is what the design screen asks for. */
  function design({
    siteId,
    patternId,
    catalogue,
    powderFactorKgM3,
    stemmingM,
    tieIn,
    frequencyHz,
    rules,
  }) {
    const charging = planCharges({ patternId, catalogue, powderFactorKgM3, stemmingM, rules });
    const timing = planTiming({ patternId, plan: charging.plan, tieIn, rules });
    const vibration = assessVibration({
      siteId,
      patternId,
      instantaneousChargeKg: timing.timing.maximumInstantaneousChargeKg,
      frequencyHz,
    });
    return {
      id: newId('plan'),
      patternId,
      charging,
      timing,
      vibration,
      totals: {
        holeCount: charging.plan.holes.length,
        totalChargeKg: charging.plan.totalMassKg,
        instantaneousChargeKg: timing.timing.maximumInstantaneousChargeKg,
        volumeM3: charging.plan.volumeM3,
        powderFactorKgM3: charging.plan.achievedPowderFactorKgM3,
        durationMs: timing.timing.durationMs,
        worstReceptorRatio: roundTo(vibration.assessment.worst?.ratio ?? 0, 4),
      },
      violations: [
        ...charging.checks.violations,
        ...timing.checks.violations,
        ...(vibration.assessment.compliant
          ? []
          : vibration.assessment.failing.map((failure) => ({
              rule: 'vibration.over_limit',
              message: `${failure.receptorName} is predicted at ${failure.predictedMmPerSecond} against a limit of ${failure.limitMmPerSecond}`,
              receptorId: failure.receptorId,
            }))),
      ],
    };
  }

  return { layOut, planCharges, planTiming, assessVibration, design, rulesForPattern };
}
