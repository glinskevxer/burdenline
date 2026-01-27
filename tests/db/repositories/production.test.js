import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, closeDatabase } from '../../../src/db/connection.js';
import { runMigrations } from '../../../src/db/migrate.js';
import { migration as core } from '../../../src/db/migrations/001_core.js';
import { migration as explosives } from '../../../src/db/migrations/002_explosives.js';
import { migration as blasting } from '../../../src/db/migrations/003_blasting.js';
import { migration as operations } from '../../../src/db/migrations/004_operations.js';
import { migration as production } from '../../../src/db/migrations/005_production.js';
import { createSite } from '../../../src/db/repositories/sites.js';
import {
  createBlast,
  transition,
  recordDesignTotals,
} from '../../../src/db/repositories/blasts.js';
import { recordInspection } from '../../../src/db/repositories/postblast.js';
import {
  recordSurvey,
  listSurveys,
  bestSurvey,
  recordDig,
  listDigRecords,
  diggingFor,
  recordSecondaryBreaking,
  listSecondaryBreaking,
  secondaryBreakingHours,
  yieldFor,
  surveysInPeriod,
} from '../../../src/db/repositories/production.js';
import { insertRow } from '../../../src/db/repository.js';
import { fixedClock } from '../../../src/lib/clock.js';
import { ConflictError, ValidationError } from '../../../src/lib/errors.js';

let db;
let siteId;
let blastId;
const clock = fixedClock('2026-01-28T09:00:00Z');
const context = { clock, actorId: 'per_1' };

function firedBlast(reference = 'MDW-2026-001') {
  const blast = createBlast(db, { siteId, reference }, { clock });
  transition(db, blast.id, 'complete_design', {}, { clock });
  transition(db, blast.id, 'submit', {}, { clock });
  transition(db, blast.id, 'approve', { approverId: 'per_1' }, { clock });
  recordDesignTotals(db, blast.id, { volumeM3: 3780, holeCount: 24 }, { clock });
  transition(db, blast.id, 'load', { shotfirerId: 'per_1' }, { clock });
  transition(db, blast.id, 'tie_in', {}, { clock });
  transition(db, blast.id, 'clear', { clearanceId: 'chk_1' }, { clock });
  transition(db, blast.id, 'fire', { shotfirerId: 'per_1', firedAt: clock.now() }, { clock });
  return blast.id;
}

function inspect(id = blastId) {
  return recordInspection(
    db,
    {
      blastId: id,
      inspectedAt: clock.now(),
      muckpileShape: 'moderate',
      throwM: 12,
      toeGrade: 'none',
    },
    { clock, holeCount: 24 },
  );
}

beforeEach(() => {
  db = openDatabase({ database: { file: ':memory:' } });
  runMigrations(db, [core, explosives, blasting, operations, production]);
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

describe('surveys', () => {
  it('records one and works the overbreak out against the design', () => {
    const survey = recordSurvey(db, { blastId, method: 'laser_scan', volumeM3: 3900 }, context);
    expect(survey.overbreakM3).toBe(120);
    expect(survey.tonnes).toBe(10530);
  });

  it('refuses one against a shot that has not been fired', () => {
    const draft = createBlast(db, { siteId, reference: 'MDW-2026-002' }, { clock });
    expect(() =>
      recordSurvey(db, { blastId: draft.id, method: 'laser_scan', volumeM3: 100 }, context),
    ).toThrow(ConflictError);
  });

  it('refuses a method nobody surveys with', () => {
    expect(() => recordSurvey(db, { blastId, method: 'pacing', volumeM3: 100 }, context)).toThrow(
      ValidationError,
    );
  });

  it('keeps every survey and prefers the one that can be trusted', () => {
    recordSurvey(db, { blastId, method: 'truck_count', volumeM3: 4100 }, context);
    recordSurvey(
      db,
      { blastId, method: 'laser_scan', volumeM3: 3900, surveyedAt: '2026-01-29T09:00:00.000Z' },
      context,
    );
    expect(listSurveys(db, blastId)).toHaveLength(2);
    expect(bestSurvey(db, blastId).method).toBe('laser_scan');
  });

  it('lists what was surveyed in a period with the shot reference on it', () => {
    recordSurvey(db, { blastId, method: 'laser_scan', volumeM3: 3900 }, context);
    const rows = surveysInPeriod(db, siteId, {
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-02-01T00:00:00.000Z',
    });
    expect(rows[0].reference).toBe('MDW-2026-001');
  });
});

describe('dig records', () => {
  it('refuses to record digging before anybody walked the muckpile', () => {
    expect(() => recordDig(db, { blastId, tonnes: 1400, hours: 8 }, context)).toThrow(
      /nobody has walked/,
    );
  });

  it('records one once the shot has been inspected', () => {
    inspect();
    const record = recordDig(db, { blastId, tonnes: 1400, hours: 8 }, context);
    expect(record.recordedOn).toBe('2026-01-28');
    expect(listDigRecords(db, blastId)).toHaveLength(1);
  });

  it('adds the days up into a rate', () => {
    inspect();
    recordDig(db, { blastId, tonnes: 1400, hours: 8, recordedOn: '2026-01-28' }, context);
    recordDig(
      db,
      {
        blastId,
        tonnes: 1650,
        hours: 9,
        recordedOn: '2026-01-29',
        delayMinutes: 30,
        delayReason: 'crusher',
      },
      context,
    );
    const rate = diggingFor(db, blastId);
    expect(rate.tonnes).toBe(3050);
    expect(rate.days).toBe(2);
    expect(rate.delaysByReason.crusher).toBe(30);
  });
});

describe('secondary breaking', () => {
  it('records a day with the hammer', () => {
    const record = recordSecondaryBreaking(
      db,
      { blastId, method: 'hydraulic_hammer', boulderCount: 14, hours: 6 },
      context,
    );
    expect(record.method).toBe('hydraulic_hammer');
    expect(listSecondaryBreaking(db, blastId)).toHaveLength(1);
  });

  it('adds the hours up for the costing', () => {
    recordSecondaryBreaking(db, { blastId, method: 'hydraulic_hammer', hours: 6 }, context);
    recordSecondaryBreaking(
      db,
      { blastId, method: 'pop_shooting', hours: 2, explosiveUsedKg: 4, carriedOutOn: '2026-01-29' },
      context,
    );
    expect(secondaryBreakingHours(db, blastId)).toBe(8);
  });

  it('refuses a method nobody uses', () => {
    expect(() =>
      recordSecondaryBreaking(db, { blastId, method: 'sledgehammer', hours: 1 }, context),
    ).toThrow(ConflictError);
  });
});

describe('yieldFor', () => {
  it('puts the design, the survey and the digging together', () => {
    inspect();
    recordSurvey(db, { blastId, method: 'laser_scan', volumeM3: 3900 }, context);
    recordDig(db, { blastId, tonnes: 5000, hours: 9 }, context);
    const result = yieldFor(db, blastId);
    expect(result.volume.verdict).toBe('as_designed');
    expect(result.digging.tonnesPerHour).toBeCloseTo(555.56, 2);
  });

  it('leaves the comparison out until something is surveyed', () => {
    expect(yieldFor(db, blastId).volume).toBe(null);
  });

  it('compares the weighbridge when it is handed one', () => {
    recordSurvey(db, { blastId, method: 'laser_scan', volumeM3: 1000 }, context);
    const result = yieldFor(db, blastId, { truckedTonnes: 2650 });
    expect(result.tonnage.withinTolerance).toBe(true);
  });
});
