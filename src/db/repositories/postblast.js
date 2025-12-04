/**
 * Inspections and misfires.
 *
 * One inspection per shot, enforced in the schema, because two people walking
 * the same muckpile and writing down different things is a conversation to have
 * on the bench rather than two rows to reconcile afterwards. A misfire is not
 * limited that way: a second one found the next morning is a second record.
 */

import { newId } from '../../lib/ids.js';
import { ConflictError } from '../../lib/errors.js';
import { inTransaction } from '../connection.js';
import { insertRow, updateRow, getById, findById, rowsToObjects } from '../repository.js';
import {
  parseInspection,
  parseMisfire,
  score,
  actionsRequired,
} from '../../domain/postblast/inspection.js';
import { recordChange } from '../audit.js';

export function recordInspection(db, input, { clock, actorId = null, holeCount = 1 }) {
  const blast = getById(db, 'blast', input.blastId, { kind: 'blast' });
  if (!['fired', 'made_safe', 'misfired', 'inspected'].includes(blast.state)) {
    throw new ConflictError(`a shot that is ${blast.state} has not been fired yet`, {
      blastId: blast.id,
      state: blast.state,
    });
  }
  if (findInspection(db, blast.id)) {
    throw new ConflictError('that shot has already been inspected', { blastId: blast.id });
  }
  const inspection = parseInspection({
    ...input,
    inspectedBy: input.inspectedBy ?? actorId ?? 'unknown',
  });
  const graded = score(inspection, { holeCount: holeCount || blast.holeCount || 1 });
  const now = clock.now();
  return inTransaction(db, () => {
    const row = {
      id: newId('rep'),
      blastId: blast.id,
      inspectedAt: inspection.inspectedAt,
      inspectedBy: input.inspectedBy ?? actorId ?? null,
      muckpileShape: inspection.muckpileShape,
      throwM: inspection.throwM,
      muckpileHeightM: inspection.muckpileHeightM,
      toeGrade: inspection.toeGrade,
      toeLengthM: inspection.toeLengthM,
      backbreakM: inspection.backbreakM,
      oversizeCount: inspection.oversizeCount,
      faceStable: inspection.faceStable ? 1 : 0,
      flyrockObserved: inspection.flyrockObserved ? 1 : 0,
      fumeGrade: inspection.fumeGrade,
      score: graded.total,
      note: inspection.note,
      createdAt: now,
    };
    insertRow(db, 'blast_inspection', row);
    recordChange(
      db,
      {
        actorId,
        action: 'blast.inspected',
        entityKind: 'blast',
        entityId: blast.id,
        before: null,
        after: { score: graded.total, toeGrade: row.toeGrade, flyrock: row.flyrockObserved },
        force: true,
      },
      { clock },
    );
    return { inspection: row, score: graded };
  });
}

export function findInspection(db, blastId) {
  const row = db.prepare('SELECT * FROM blast_inspection WHERE blast_id = ?').get(blastId);
  return row ? rowsToObjects([row])[0] : null;
}

export function listInspections(db, siteId, { from, to, limit = 200 } = {}) {
  const rows = db
    .prepare(
      `SELECT i.* FROM blast_inspection i
       JOIN blast b ON b.id = i.blast_id
       WHERE b.site_id = @siteId
         AND (@from IS NULL OR i.inspected_at >= @from)
         AND (@to IS NULL OR i.inspected_at <= @to)
       ORDER BY i.inspected_at DESC
       LIMIT @limit`,
    )
    .all({ siteId, from: from ?? null, to: to ?? null, limit });
  return rowsToObjects(rows);
}

export function recordMisfire(db, input, { clock, actorId = null }) {
  getById(db, 'blast', input.blastId, { kind: 'blast' });
  const misfire = parseMisfire({
    ...input,
    discoveredBy: input.discoveredBy ?? actorId ?? 'unknown',
  });
  const now = clock.now();
  const row = {
    id: newId('rep'),
    blastId: misfire.blastId,
    holeNumbers: misfire.holeNumbers.join(','),
    kind: misfire.kind,
    discoveredAt: misfire.discoveredAt,
    discoveredBy: input.discoveredBy ?? actorId ?? null,
    explosiveEstimateKg: misfire.explosiveEstimateKg,
    description: misfire.description,
    reportedToRegulator: misfire.reportedToRegulator ? 1 : 0,
    createdAt: now,
  };
  return inTransaction(db, () => {
    insertRow(db, 'misfire', row);
    recordChange(
      db,
      {
        actorId,
        action: 'blast.misfire_recorded',
        entityKind: 'blast',
        entityId: misfire.blastId,
        before: null,
        after: { holes: misfire.holeNumbers, kind: misfire.kind },
        force: true,
      },
      { clock },
    );
    return row;
  });
}

export function listMisfires(db, blastId) {
  const rows = db
    .prepare('SELECT * FROM misfire WHERE blast_id = ? ORDER BY discovered_at')
    .all(blastId);
  return rowsToObjects(rows).map((row) => ({
    ...row,
    holeNumbers: row.holeNumbers.split(',').filter(Boolean).map(Number),
  }));
}

export function markMisfireSafe(db, misfireId, { clock, personId }) {
  const misfire = findById(db, 'misfire', misfireId);
  if (!misfire) {
    throw new ConflictError('there is no misfire with that id', { misfireId });
  }
  if (misfire.madeSafeAt) {
    throw new ConflictError('that misfire has already been made safe', { misfireId });
  }
  updateRow(db, 'misfire', misfireId, { madeSafeAt: clock.now(), madeSafeBy: personId ?? null });
  return findById(db, 'misfire', misfireId);
}

/** Whether the muckpile can be dug, read off what was recorded. */
export function diggability(db, blastId) {
  const inspection = findInspection(db, blastId);
  if (!inspection) {
    return {
      diggable: false,
      violations: [{ rule: 'postblast.not_inspected', message: 'nobody has walked it yet' }],
    };
  }
  const outstanding = listMisfires(db, blastId).filter((misfire) => !misfire.madeSafeAt);
  return actionsRequired(
    {
      blastId,
      faceStable: inspection.faceStable === 1,
      flyrockObserved: inspection.flyrockObserved === 1,
      fumeGrade: inspection.fumeGrade,
      toeGrade: inspection.toeGrade,
    },
    outstanding,
  );
}
