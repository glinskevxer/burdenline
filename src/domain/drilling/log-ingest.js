/**
 * Reading the drill log back.
 *
 * The rig writes a row per hole with the depth it actually reached and whatever
 * the operator flagged. What comes back never matches the plan exactly: holes
 * get lost, a few come up short on hard rock, one gets drilled that was never
 * on the plan because the crew added it to catch a toe. All of that has to be
 * visible before anyone starts charging, because a hole that is a metre shallow
 * with the designed charge in it puts the whole column too close to the collar.
 */

import { ValidationError } from '../../lib/errors.js';
import { parseCsvRecords, readNumber } from '../../lib/csv.js';
import { roundTo } from '../../lib/units.js';
import { HOLE_CONDITIONS } from '../geometry/hole.js';

const CONDITION_WORDS = {
  dry: 'dry',
  damp: 'damp',
  moist: 'damp',
  wet: 'wet',
  water: 'wet',
  cavity: 'cavity',
  void: 'cavity',
  collapse: 'collapsed',
  collapsed: 'collapsed',
  caved: 'collapsed',
  lost: 'lost',
  abandoned: 'lost',
};

export const DEFAULT_TOLERANCES = Object.freeze({
  shortM: 0.3,
  longM: 0.5,
  redrillShortM: 1,
});

export function parseDrillLog(text, options = {}) {
  const { records } = parseCsvRecords(text, options);
  if (records.length === 0) {
    throw new ValidationError('the drill log is empty', [
      { path: 'text', message: 'no rows to read', kind: 'missing' },
    ]);
  }
  const seen = new Set();
  return records.map((record, index) => {
    const holeNumber = readNumber(record.hole ?? record.hole_no ?? record.hole_number, {
      field: `row ${index + 1} hole number`,
      allowBlank: false,
    });
    if (!Number.isInteger(holeNumber) || holeNumber < 1) {
      throw new ValidationError(`row ${index + 1} has a hole number of ${holeNumber}`, [
        { path: `row.${index + 1}.hole`, message: 'expected a whole number', kind: 'type' },
      ]);
    }
    if (seen.has(holeNumber)) {
      throw new ValidationError(`hole ${holeNumber} is logged twice`, [
        { path: `row.${index + 1}.hole`, message: 'duplicate hole', kind: 'conflict' },
      ]);
    }
    seen.add(holeNumber);
    const depth = readNumber(record.depth ?? record.drilled_depth ?? record.depth_m, {
      field: `row ${index + 1} depth`,
    });
    return {
      holeNumber,
      drilledDepthM: depth === null ? null : roundTo(depth, 2),
      condition: readCondition(record.condition ?? record.ground ?? record.notes),
      waterDepthM: nullableRounded(record.water ?? record.water_depth),
      penetrationRateMPerMin: nullableRounded(record.penetration_rate ?? record.rate),
      drilledAt: (record.drilled_at ?? record.date ?? '').trim() || null,
      operator: (record.operator ?? record.driller ?? '').trim() || null,
      note: (record.notes ?? '').trim() || null,
    };
  });
}

export function readCondition(value) {
  const text = String(value ?? '')
    .trim()
    .toLowerCase();
  if (text === '') {
    return 'dry';
  }
  for (const [word, condition] of Object.entries(CONDITION_WORDS)) {
    if (text.includes(word)) {
      return condition;
    }
  }
  return 'dry';
}

/**
 * Line the log up against the plan. Every hole ends up in exactly one bucket so
 * that the totals add back to the hole count, which is the check a supervisor
 * does by eye before signing the sheet.
 */
export function reconcileDrilling(designedHoles, loggedRows, options = {}) {
  const tolerances = { ...DEFAULT_TOLERANCES, ...(options.tolerances ?? {}) };
  const logged = new Map(loggedRows.map((row) => [row.holeNumber, row]));
  const holes = [];
  for (const hole of designedHoles) {
    const row = logged.get(hole.holeNumber);
    logged.delete(hole.holeNumber);
    if (!row || row.drilledDepthM === null) {
      holes.push({ holeNumber: hole.holeNumber, outcome: 'not_drilled', varianceM: null });
      continue;
    }
    const variance = roundTo(row.drilledDepthM - hole.designedDepthM, 2);
    holes.push({
      holeNumber: hole.holeNumber,
      outcome: classify(variance, row, tolerances),
      varianceM: variance,
      drilledDepthM: row.drilledDepthM,
      designedDepthM: hole.designedDepthM,
      condition: row.condition,
      waterDepthM: row.waterDepthM,
    });
  }
  const unplanned = [...logged.values()].map((row) => ({
    holeNumber: row.holeNumber,
    outcome: 'not_on_plan',
    drilledDepthM: row.drilledDepthM,
  }));
  return summarise([...holes, ...unplanned], designedHoles.length);
}

function classify(variance, row, tolerances) {
  if (row.condition === 'collapsed' || row.condition === 'lost') {
    return 'lost';
  }
  if (variance <= -tolerances.redrillShortM) {
    return 'redrill';
  }
  if (variance < -tolerances.shortM) {
    return 'short';
  }
  if (variance > tolerances.longM) {
    return 'over';
  }
  return 'on_plan';
}

function summarise(holes, designedCount) {
  const counts = holes.reduce((tally, hole) => {
    tally[hole.outcome] = (tally[hole.outcome] ?? 0) + 1;
    return tally;
  }, {});
  const measured = holes.filter((hole) => typeof hole.varianceM === 'number');
  const drilledMetres = measured.reduce((sum, hole) => sum + (hole.drilledDepthM ?? 0), 0);
  return {
    holes,
    counts,
    designedCount,
    loggedCount: holes.filter((hole) => hole.outcome !== 'not_drilled').length,
    drilledMetres: roundTo(drilledMetres, 2),
    meanVarianceM: measured.length
      ? roundTo(measured.reduce((sum, hole) => sum + hole.varianceM, 0) / measured.length, 3)
      : null,
    worstShortM: measured.length ? roundTo(Math.min(...measured.map((h) => h.varianceM)), 2) : null,
    wetHoles: holes.filter((hole) => hole.condition === 'wet' || hole.condition === 'cavity')
      .length,
    ready:
      (counts.not_drilled ?? 0) === 0 && (counts.redrill ?? 0) === 0 && (counts.lost ?? 0) === 0,
  };
}

function nullableRounded(value) {
  const number = readNumber(value);
  return number === null ? null : roundTo(number, 2);
}

export const conditionVocabulary = HOLE_CONDITIONS;
