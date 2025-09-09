/**
 * Patterns and the holes in them.
 *
 * A pattern is written with its holes in one transaction, because a pattern with
 * half its holes in the database is worse than no pattern at all: the drill plan
 * goes out short and nobody notices until the rig is on the bench. The bulk
 * insert prepares its statement once and runs it inside a transaction, which is
 * the difference between a two hundred hole pattern taking a few milliseconds
 * and taking most of a second.
 */

import { newId } from '../../lib/ids.js';
import { pick } from '../../lib/guards.js';
import { ConflictError, ValidationError } from '../../lib/errors.js';
import { inTransaction } from '../connection.js';
import {
  insertRow,
  updateRow,
  findById,
  getById,
  listWhere,
  countWhere,
  rowsToObjects,
} from '../repository.js';

export function createPattern(db, input, { clock }) {
  getById(db, 'bench', input.benchId, { kind: 'bench' });
  const now = clock.now();
  const pattern = {
    id: input.id ?? newId('pat'),
    benchId: input.benchId,
    reference: input.reference,
    layout: input.layout ?? 'staggered',
    holeDiameterMm: input.holeDiameterMm,
    nominalBurdenM: input.nominalBurdenM,
    nominalSpacingM: input.nominalSpacingM,
    rowCount: input.rowCount,
    holesPerRow: input.holesPerRow,
    benchHeightM: input.benchHeightM,
    subdrillM: input.subdrillM ?? 0,
    inclinationDeg: input.inclinationDeg ?? 0,
    bearingDeg: input.bearingDeg ?? 0,
    status: input.status ?? 'draft',
    designedBy: input.designedBy ?? null,
    createdAt: now,
    updatedAt: now,
  };
  insertRow(db, 'pattern', pattern);
  return pattern;
}

export function getPattern(db, id) {
  return getById(db, 'pattern', id, { kind: 'pattern' });
}

export function findPatternByReference(db, reference) {
  const [found] = listWhere(db, 'pattern', { reference }, { pageSize: 1 });
  return found ?? null;
}

export function listPatterns(db, benchId, options = {}) {
  return listWhere(
    db,
    'pattern',
    { benchId, status: options.status },
    { orderBy: 'reference', ...options },
  );
}

export function updatePattern(db, id, changes, { clock }) {
  const pattern = getPattern(db, id);
  if (['fired', 'abandoned'].includes(pattern.status)) {
    throw new ConflictError(`a ${pattern.status} pattern cannot be changed`, { patternId: id });
  }
  const allowed = pick(changes, [
    'layout',
    'holeDiameterMm',
    'nominalBurdenM',
    'nominalSpacingM',
    'rowCount',
    'holesPerRow',
    'benchHeightM',
    'subdrillM',
    'inclinationDeg',
    'bearingDeg',
    'status',
    'designedBy',
  ]);
  updateRow(db, 'pattern', id, { ...allowed, updatedAt: clock.now() });
  return getPattern(db, id);
}

/** Write a whole laid out pattern at once. Replaces any holes already there. */
export function replaceHoles(db, patternId, holes, { clock }) {
  getPattern(db, patternId);
  if (!Array.isArray(holes) || holes.length === 0) {
    throw new ValidationError('a pattern needs at least one hole', [
      { path: 'holes', message: 'no holes given', kind: 'missing' },
    ]);
  }
  const now = clock.now();
  return inTransaction(db, () => {
    db.prepare('DELETE FROM hole WHERE pattern_id = ?').run(patternId);
    const statement = db.prepare(`
      INSERT INTO hole (id, pattern_id, hole_number, row_number, easting_m, northing_m,
        collar_level_m, designed_depth_m, diameter_mm, inclination_deg, bearing_deg,
        condition, status, created_at, updated_at)
      VALUES (@id, @patternId, @holeNumber, @rowNumber, @eastingM, @northingM,
        @collarLevelM, @designedDepthM, @diameterMm, @inclinationDeg, @bearingDeg,
        @condition, @status, @now, @now)
    `);
    const written = [];
    for (const hole of holes) {
      const row = {
        id: hole.id ?? newId('hole'),
        patternId,
        holeNumber: hole.holeNumber,
        rowNumber: hole.rowNumber,
        eastingM: hole.easting ?? hole.eastingM,
        northingM: hole.northing ?? hole.northingM,
        collarLevelM: hole.collarLevelM,
        designedDepthM: hole.designedDepthM,
        diameterMm: hole.diameterMm,
        inclinationDeg: hole.inclinationDeg ?? 0,
        bearingDeg: hole.bearingDeg ?? 0,
        condition: hole.condition ?? 'dry',
        status: hole.status ?? 'planned',
        now,
      };
      statement.run(row);
      written.push(row.id);
    }
    return { patternId, holeCount: written.length, holeIds: written };
  });
}

export function listHoles(db, patternId, options = {}) {
  const rows = db
    .prepare('SELECT * FROM hole WHERE pattern_id = ? ORDER BY hole_number LIMIT ? OFFSET ?')
    .all(patternId, options.limit ?? 1000, options.offset ?? 0);
  return rowsToObjects(rows);
}

export function getHole(db, id) {
  return getById(db, 'hole', id, { kind: 'hole' });
}

export function findHole(db, patternId, holeNumber) {
  const [found] = listWhere(db, 'hole', { patternId, holeNumber }, { pageSize: 1 });
  return found ?? null;
}

/** Record what the rig actually drilled, hole by hole, in one transaction. */
export function recordDrilling(db, patternId, rows, { clock }) {
  getPattern(db, patternId);
  const now = clock.now();
  return inTransaction(db, () => {
    const statement = db.prepare(`
      UPDATE hole SET drilled_depth_m = @drilledDepthM, condition = @condition,
        water_depth_m = @waterDepthM, status = @status, updated_at = @now
      WHERE pattern_id = @patternId AND hole_number = @holeNumber
    `);
    let updated = 0;
    const missing = [];
    for (const row of rows) {
      const result = statement.run({
        patternId,
        holeNumber: row.holeNumber,
        drilledDepthM: row.drilledDepthM ?? null,
        condition: row.condition ?? 'dry',
        waterDepthM: row.waterDepthM ?? null,
        status:
          row.drilledDepthM === null || row.drilledDepthM === undefined ? 'planned' : 'drilled',
        now,
      });
      if (result.changes === 0) {
        missing.push(row.holeNumber);
      } else {
        updated += result.changes;
      }
    }
    return { updated, missing };
  });
}

export function holeCount(db, patternId) {
  return countWhere(db, 'hole', { patternId });
}

export function findPattern(db, id) {
  return findById(db, 'pattern', id);
}
