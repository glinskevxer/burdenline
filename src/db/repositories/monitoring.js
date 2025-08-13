/**
 * Receptors, monitor records and the fitted site laws.
 *
 * Records arrive in batches off a memory stick and the same file gets uploaded
 * twice more often than anyone admits, so the import is written to be safe to
 * repeat: a record is identified by the monitor and the instant it triggered,
 * and a second attempt at the same one is counted as a duplicate rather than
 * inserted again.
 *
 * A site law is never edited. A refit writes a new row and stamps the old one as
 * superseded, so a report produced last year can still say which law it used.
 */

import { newId } from '../../lib/ids.js';
import { ConflictError } from '../../lib/errors.js';
import { inTransaction } from '../connection.js';
import {
  insertRow,
  updateRow,
  getById,
  findById,
  listWhere,
  rowsToObjects,
} from '../repository.js';

export function createReceptor(db, input, { clock }) {
  getById(db, 'site', input.siteId, { kind: 'site' });
  const now = clock.now();
  const receptor = {
    id: input.id ?? newId('rec'),
    siteId: input.siteId,
    name: input.name,
    structureClass: input.structureClass,
    eastingM: input.easting ?? input.eastingM,
    northingM: input.northing ?? input.northingM,
    levelM: input.level ?? input.levelM ?? 0,
    occupied: input.occupied === false ? 0 : 1,
    limitMmPerSecond: input.limitMmPerSecond ?? null,
    airblastLimitDb: input.airblastLimitDb ?? null,
    typicalFrequencyHz: input.typicalFrequencyHz ?? null,
    monitored: input.monitored ? 1 : 0,
    notifiable: input.notifiable ? 1 : 0,
    note: input.note ?? null,
    createdAt: now,
    updatedAt: now,
  };
  insertRow(db, 'receptor', receptor);
  return receptor;
}

export function getReceptor(db, id) {
  return getById(db, 'receptor', id, { kind: 'receptor' });
}

export function listReceptors(db, siteId, options = {}) {
  const rows = listWhere(db, 'receptor', { siteId }, { orderBy: 'name', ...options });
  return rows
    .filter((row) => (options.monitoredOnly ? row.monitored === 1 : true))
    .map((row) => ({
      ...row,
      easting: row.eastingM,
      northing: row.northingM,
      level: row.levelM,
      occupied: row.occupied === 1,
      monitored: row.monitored === 1,
      notifiable: row.notifiable === 1,
    }));
}

export function updateReceptor(db, id, changes, { clock }) {
  getReceptor(db, id);
  const allowed = {};
  for (const key of [
    'name',
    'structureClass',
    'limitMmPerSecond',
    'airblastLimitDb',
    'typicalFrequencyHz',
    'note',
  ]) {
    if (changes[key] !== undefined) {
      allowed[key] = changes[key];
    }
  }
  for (const key of ['occupied', 'monitored', 'notifiable']) {
    if (changes[key] !== undefined) {
      allowed[key] = changes[key] ? 1 : 0;
    }
  }
  updateRow(db, 'receptor', id, { ...allowed, updatedAt: clock.now() });
  return getReceptor(db, id);
}

function recordRow(siteId, record, sourceFile, now) {
  return {
    id: newId('mon'),
    siteId,
    receptorId: record.receptorId ?? null,
    blastId: record.blastId ?? null,
    monitorSerial: record.monitorSerial,
    triggeredAt: record.triggeredAt,
    distanceM: record.distanceM ?? null,
    peakMmPerSecond: record.peakMmPerSecond,
    peakComponent: record.peakComponent ?? null,
    peakFrequencyHz: record.peakFrequencyHz ?? null,
    longitudinalMmPerSecond: record.longitudinal?.peakMmPerSecond ?? null,
    transverseMmPerSecond: record.transverse?.peakMmPerSecond ?? null,
    verticalMmPerSecond: record.vertical?.peakMmPerSecond ?? null,
    vectorSumMmPerSecond: record.vectorSumMmPerSecond ?? null,
    airblastDb: record.airblastDb ?? null,
    sourceFile: sourceFile ?? null,
    createdAt: now,
  };
}

/** Import a batch. Safe to run twice on the same file. */
export function importRecords(db, siteId, records, { clock, sourceFile = null } = {}) {
  getById(db, 'site', siteId, { kind: 'site' });
  const now = clock.now();
  return inTransaction(db, () => {
    const existing = db.prepare(
      'SELECT id FROM monitor_record WHERE monitor_serial = ? AND triggered_at = ?',
    );
    const inserted = [];
    let duplicates = 0;
    for (const record of records) {
      if (existing.get(record.monitorSerial, record.triggeredAt)) {
        duplicates += 1;
        continue;
      }
      const row = recordRow(siteId, record, sourceFile, now);
      insertRow(db, 'monitor_record', row);
      inserted.push(row.id);
    }
    return { inserted: inserted.length, duplicates, ids: inserted };
  });
}

export function listRecords(db, siteId, options = {}) {
  const rows = db
    .prepare(
      `SELECT * FROM monitor_record
       WHERE site_id = @siteId
         AND (@from IS NULL OR triggered_at >= @from)
         AND (@to IS NULL OR triggered_at <= @to)
         AND (@receptorId IS NULL OR receptor_id = @receptorId)
         AND (@blastId IS NULL OR blast_id = @blastId)
       ORDER BY triggered_at DESC
       LIMIT @limit`,
    )
    .all({
      siteId,
      from: options.from ?? null,
      to: options.to ?? null,
      receptorId: options.receptorId ?? null,
      blastId: options.blastId ?? null,
      limit: options.limit ?? 500,
    });
  return rowsToObjects(rows);
}

export function attachRecordToBlast(db, recordId, blastId) {
  const record = findById(db, 'monitor_record', recordId);
  if (!record) {
    throw new ConflictError('that record is not here', { recordId });
  }
  if (record.blastId && record.blastId !== blastId) {
    throw new ConflictError('that record is already attached to another shot', {
      recordId,
      blastId: record.blastId,
    });
  }
  updateRow(db, 'monitor_record', recordId, { blastId });
  return findById(db, 'monitor_record', recordId);
}

/** Store a fit and retire whatever it replaces. */
export function saveSiteLaw(db, input, { clock }) {
  getById(db, 'site', input.siteId, { kind: 'site' });
  const now = clock.now();
  return inTransaction(db, () => {
    db.prepare(
      `UPDATE site_law SET superseded_at = @now
       WHERE site_id = @siteId
         AND superseded_at IS NULL
         AND ((@receptorId IS NULL AND receptor_id IS NULL) OR receptor_id = @receptorId)`,
    ).run({ now, siteId: input.siteId, receptorId: input.receptorId ?? null });
    const law = {
      id: newId('rep'),
      siteId: input.siteId,
      receptorId: input.receptorId ?? null,
      k: input.k,
      b: input.b,
      scaling: input.scaling ?? 'square_root',
      recordCount: input.recordCount,
      rSquared: input.rSquared ?? null,
      residualStandardError: input.residualStandardError ?? null,
      fittedAt: input.fittedAt ?? now,
      superseded_at: null,
      createdAt: now,
    };
    insertRow(db, 'site_law', law);
    return law;
  });
}

export function currentSiteLaw(db, siteId, receptorId = null) {
  const row = db
    .prepare(
      `SELECT * FROM site_law
       WHERE site_id = @siteId AND superseded_at IS NULL
         AND ((@receptorId IS NULL AND receptor_id IS NULL) OR receptor_id = @receptorId)
       ORDER BY fitted_at DESC LIMIT 1`,
    )
    .get({ siteId, receptorId });
  if (row) {
    return rowsToObjects([row])[0];
  }
  if (receptorId === null) {
    return null;
  }
  return currentSiteLaw(db, siteId, null);
}

export function siteLawHistory(db, siteId) {
  const rows = db
    .prepare('SELECT * FROM site_law WHERE site_id = ? ORDER BY fitted_at DESC')
    .all(siteId);
  return rowsToObjects(rows);
}
