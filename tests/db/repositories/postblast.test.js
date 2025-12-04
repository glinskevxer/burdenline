import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, closeDatabase } from '../../../src/db/connection.js';
import { runMigrations } from '../../../src/db/migrate.js';
import { migration as core } from '../../../src/db/migrations/001_core.js';
import { migration as explosives } from '../../../src/db/migrations/002_explosives.js';
import { migration as blasting } from '../../../src/db/migrations/003_blasting.js';
import { migration as operations } from '../../../src/db/migrations/004_operations.js';
import { createSite } from '../../../src/db/repositories/sites.js';
import { createBlast, transition } from '../../../src/db/repositories/blasts.js';
import {
  recordInspection,
  findInspection,
  listInspections,
  recordMisfire,
  listMisfires,
  markMisfireSafe,
  diggability,
} from '../../../src/db/repositories/postblast.js';
import { historyFor } from '../../../src/db/audit.js';
import { insertRow } from '../../../src/db/repository.js';
import { fixedClock } from '../../../src/lib/clock.js';
import { ConflictError, ValidationError } from '../../../src/lib/errors.js';

let db;
let siteId;
let blastId;
const clock = fixedClock('2025-12-05T15:00:00Z');
const context = { clock, actorId: 'per_1', holeCount: 24 };

function firedBlast(reference = 'MDW-2025-014') {
  const blast = createBlast(db, { siteId, reference }, { clock });
  transition(db, blast.id, 'complete_design', {}, { clock });
  transition(db, blast.id, 'submit', {}, { clock });
  transition(db, blast.id, 'approve', { approverId: 'per_1' }, { clock });
  transition(db, blast.id, 'load', { shotfirerId: 'per_1' }, { clock });
  transition(db, blast.id, 'tie_in', {}, { clock });
  transition(db, blast.id, 'clear', { clearanceId: 'chk_1' }, { clock });
  transition(db, blast.id, 'fire', { shotfirerId: 'per_1', firedAt: clock.now() }, { clock });
  return blast.id;
}

function inspection(overrides = {}) {
  return {
    blastId,
    inspectedAt: '2025-12-05T15:20:00.000Z',
    muckpileShape: 'moderate',
    throwM: 12,
    toeGrade: 'none',
    backbreakM: 0.8,
    oversizeCount: 4,
    ...overrides,
  };
}

beforeEach(() => {
  db = openDatabase({ database: { file: ':memory:' } });
  runMigrations(db, [core, explosives, blasting, operations]);
  siteId = createSite(db, { code: 'MDW', name: 'Midway' }, { clock }).id;
  insertRow(db, 'person', {
    id: 'per_1',
    name: 'M Cronin',
    roles: 'shotfirer',
    createdAt: clock.now(),
    updatedAt: clock.now(),
  });
  blastId = firedBlast();
});

afterEach(() => closeDatabase(db));

describe('recordInspection', () => {
  it('writes one and scores it', () => {
    const result = recordInspection(db, inspection(), context);
    expect(result.score.grade).toBe('good');
    expect(findInspection(db, blastId).score).toBe(result.score.total);
  });

  it('refuses a second inspection of the same shot', () => {
    recordInspection(db, inspection(), context);
    expect(() => recordInspection(db, inspection(), context)).toThrow(/already been inspected/);
  });

  it('refuses to inspect a shot that has not been fired', () => {
    const draft = createBlast(db, { siteId, reference: 'MDW-2025-015' }, { clock });
    expect(() => recordInspection(db, inspection({ blastId: draft.id }), context)).toThrow(
      ConflictError,
    );
  });

  it('refuses an inspection that is not one', () => {
    expect(() => recordInspection(db, inspection({ muckpileShape: 'flat' }), context)).toThrow(
      ValidationError,
    );
  });

  it('leaves an audit entry against the shot', () => {
    recordInspection(db, inspection(), context);
    const history = historyFor(db, 'blast', blastId);
    expect(history[0].action).toBe('blast.inspected');
  });

  it('lists them for a site newest first', () => {
    recordInspection(db, inspection(), context);
    const second = firedBlast('MDW-2025-016');
    recordInspection(
      db,
      inspection({ blastId: second, inspectedAt: '2025-12-06T15:20:00.000Z' }),
      context,
    );
    expect(listInspections(db, siteId).map((row) => row.blastId)).toEqual([second, blastId]);
  });

  it('filters the list by date', () => {
    recordInspection(db, inspection(), context);
    expect(listInspections(db, siteId, { from: '2026-01-01T00:00:00.000Z' })).toHaveLength(0);
  });
});

describe('misfires', () => {
  const misfire = () => ({
    blastId,
    holeNumbers: [14, 15],
    kind: 'unfired_hole',
    discoveredAt: '2025-12-05T15:25:00.000Z',
    description: 'two holes in row three are standing with the tube unfired',
  });

  it('records one with the holes named', () => {
    const written = recordMisfire(db, misfire(), context);
    expect(written.holeNumbers).toBe('14,15');
    expect(listMisfires(db, blastId)[0].holeNumbers).toEqual([14, 15]);
  });

  it('takes a second one found the next morning', () => {
    recordMisfire(db, misfire(), context);
    recordMisfire(
      db,
      { ...misfire(), holeNumbers: [22], discoveredAt: '2025-12-06T08:00:00.000Z' },
      context,
    );
    expect(listMisfires(db, blastId)).toHaveLength(2);
  });

  it('refuses one with nothing written down', () => {
    expect(() => recordMisfire(db, { ...misfire(), description: 'bad' }, context)).toThrow(
      ValidationError,
    );
  });

  it('marks one safe once and then refuses', () => {
    const written = recordMisfire(db, misfire(), context);
    const safe = markMisfireSafe(db, written.id, { clock, personId: 'per_1' });
    expect(safe.madeSafeAt).toBe(clock.now());
    expect(() => markMisfireSafe(db, written.id, { clock, personId: 'per_1' })).toThrow(
      ConflictError,
    );
  });

  it('refuses to mark one safe that is not there', () => {
    expect(() => markMisfireSafe(db, 'rep_missing', { clock })).toThrow(ConflictError);
  });
});

describe('diggability', () => {
  it('will not let a shot be dug before anybody has walked it', () => {
    const result = diggability(db, blastId);
    expect(result.diggable).toBe(false);
    expect(result.violations[0].rule).toBe('postblast.not_inspected');
  });

  it('lets a clean shot be dug', () => {
    recordInspection(db, inspection(), context);
    expect(diggability(db, blastId).diggable).toBe(true);
  });

  it('holds it while a misfire is outstanding', () => {
    recordInspection(db, inspection(), context);
    recordMisfire(
      db,
      {
        blastId,
        holeNumbers: [14],
        kind: 'unfired_hole',
        discoveredAt: '2025-12-05T15:25:00.000Z',
        description: 'one hole in row three did not go off at all',
      },
      context,
    );
    expect(diggability(db, blastId).diggable).toBe(false);
  });

  it('lets it be dug once the misfire is made safe', () => {
    recordInspection(db, inspection(), context);
    const written = recordMisfire(
      db,
      {
        blastId,
        holeNumbers: [14],
        kind: 'unfired_hole',
        discoveredAt: '2025-12-05T15:25:00.000Z',
        description: 'one hole in row three did not go off at all',
      },
      context,
    );
    markMisfireSafe(db, written.id, { clock, personId: 'per_1' });
    expect(diggability(db, blastId).diggable).toBe(true);
  });

  it('holds it while the face is unstable', () => {
    recordInspection(db, inspection({ faceStable: false }), context);
    expect(diggability(db, blastId).diggable).toBe(false);
  });
});
