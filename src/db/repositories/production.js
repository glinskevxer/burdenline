/**
 * Surveys, digging and secondary breaking.
 *
 * Everything here hangs off a shot and is written after it, which changes what
 * the repository has to enforce. A survey of a shot that has not been fired is a
 * mistake, and so is a dig record against one nobody has inspected: the muckpile
 * is not supposed to be touched until it has been walked, and recording tonnes
 * off it says it was.
 */

import { ConflictError, ValidationError } from '../../lib/errors.js';
import { getById, listWhere, rowsToObjects, createRecord } from '../repository.js';
import { newId } from '../../lib/ids.js';
import { insertRow } from '../repository.js';
import { roundTo } from '../../lib/units.js';
import {
  SURVEY_METHODS,
  preferredSurvey,
  digRate,
  yieldOf,
} from '../../domain/production/survey.js';
import { findInspection } from './postblast.js';

const FIRED_STATES = ['fired', 'misfired', 'made_safe', 'inspected', 'closed'];

function firedBlast(db, blastId) {
  const blast = getById(db, 'blast', blastId, { kind: 'blast' });
  if (!FIRED_STATES.includes(blast.state)) {
    throw new ConflictError(`a shot that is ${blast.state} has not been fired`, {
      blastId,
      state: blast.state,
    });
  }
  return blast;
}

export function recordSurvey(db, input, { clock, actorId = null }) {
  const blast = firedBlast(db, input.blastId);
  if (!SURVEY_METHODS.includes(input.method)) {
    throw new ValidationError(`${input.method} is not a survey method`, [
      { path: 'method', message: `expected one of ${SURVEY_METHODS.join(', ')}`, kind: 'enum' },
    ]);
  }
  const surveyedAt = input.surveyedAt ?? clock.now();
  const densityKgM3 = input.densityKgM3 ?? 2700;
  const record = {
    id: newId('rep'),
    blastId: blast.id,
    surveyedAt,
    surveyedBy: input.surveyedBy ?? actorId ?? null,
    method: input.method,
    volumeM3: input.volumeM3,
    tonnes: input.tonnes ?? roundTo((input.volumeM3 * densityKgM3) / 1000, 2),
    densityKgM3,
    overbreakM3: blast.volumeM3 ? roundTo(input.volumeM3 - blast.volumeM3, 2) : null,
    note: input.note ?? null,
    createdAt: clock.now(),
  };
  insertRow(db, 'survey', record);
  return record;
}

export function listSurveys(db, blastId) {
  return listWhere(db, 'survey', { blastId }, { orderBy: 'surveyed_at DESC' });
}

export function bestSurvey(db, blastId) {
  return preferredSurvey(listSurveys(db, blastId));
}

export function recordDig(db, input, { clock }) {
  firedBlast(db, input.blastId);
  if (!findInspection(db, input.blastId)) {
    throw new ConflictError('nobody has walked that muckpile yet', { blastId: input.blastId });
  }
  return createRecord(
    db,
    {
      table: 'dig_record',
      prefix: 'rep',
      timestamps: ['createdAt'],
      defaults: { loader: null, buckets: null, delayMinutes: 0, delayReason: null },
    },
    {
      blastId: input.blastId,
      recordedOn: input.recordedOn ?? clock.date(),
      loader: input.loader,
      buckets: input.buckets,
      tonnes: input.tonnes,
      hours: input.hours,
      delayMinutes: input.delayMinutes,
      delayReason: input.delayReason,
    },
    { clock },
  );
}

export function listDigRecords(db, blastId) {
  return listWhere(db, 'dig_record', { blastId }, { orderBy: 'recorded_on' });
}

export function diggingFor(db, blastId) {
  return digRate(listDigRecords(db, blastId));
}

export function recordSecondaryBreaking(db, input, { clock, actorId = null }) {
  firedBlast(db, input.blastId);
  return createRecord(
    db,
    {
      table: 'secondary_breaking',
      prefix: 'rep',
      timestamps: ['createdAt'],
      defaults: { boulderCount: 0, hours: 0, explosiveUsedKg: null, note: null },
    },
    {
      blastId: input.blastId,
      carriedOutOn: input.carriedOutOn ?? clock.date(),
      method: input.method,
      boulderCount: input.boulderCount,
      hours: input.hours,
      explosiveUsedKg: input.explosiveUsedKg,
      carriedOutBy: input.carriedOutBy ?? actorId,
      note: input.note,
    },
    { clock },
  );
}

export function listSecondaryBreaking(db, blastId) {
  return listWhere(db, 'secondary_breaking', { blastId }, { orderBy: 'carried_out_on' });
}

export function secondaryBreakingHours(db, blastId) {
  return roundTo(
    listSecondaryBreaking(db, blastId).reduce((sum, record) => sum + record.hours, 0),
    2,
  );
}

/** The whole yield picture for one shot. */
export function yieldFor(db, blastId, { truckedTonnes = null, densityKgM3 = 2700 } = {}) {
  const blast = getById(db, 'blast', blastId, { kind: 'blast' });
  return yieldOf({
    designedM3: blast.volumeM3 ?? undefined,
    surveys: listSurveys(db, blastId),
    digRecords: listDigRecords(db, blastId),
    densityKgM3,
    truckedTonnes,
  });
}

/** Everything surveyed in a period, for the month end reconciliation. */
export function surveysInPeriod(db, siteId, { from, to }) {
  const rows = db
    .prepare(
      `SELECT s.*, b.reference FROM survey s
       JOIN blast b ON b.id = s.blast_id
       WHERE b.site_id = @siteId AND s.surveyed_at >= @from AND s.surveyed_at <= @to
       ORDER BY s.surveyed_at`,
    )
    .all({ siteId, from, to });
  return rowsToObjects(rows);
}
