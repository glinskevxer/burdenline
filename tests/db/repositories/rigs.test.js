import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openTestDatabase, closeTestDatabase } from '../../helpers/database.js';
import { createSite, createBench } from '../../../src/db/repositories/sites.js';
import { createPattern } from '../../../src/db/repositories/patterns.js';
import {
  createRig,
  getRig,
  listRigs,
  updateRig,
  rigsForPattern,
  recordShift,
  listShifts,
  rigProductivity,
  retireRig,
  RIG_STATES,
  SHIFTS,
} from '../../../src/db/repositories/rigs.js';
import { fixedClock } from '../../../src/lib/clock.js';
import { NotFoundError, ConflictError, ValidationError } from '../../../src/lib/errors.js';

let db;
let siteId;
let benchId;
const clock = fixedClock('2026-02-04T06:00:00Z');
const context = { clock };

function rig(overrides = {}) {
  return createRig(
    db,
    {
      siteId,
      fleetNumber: 'DR-01',
      make: 'Atlas',
      holeDiameterMinMm: 89,
      holeDiameterMaxMm: 115,
      ...overrides,
    },
    context,
  );
}

function pattern(diameter = 102) {
  return createPattern(
    db,
    {
      benchId,
      reference: `MDW-2026-${diameter}`,
      holeDiameterMm: diameter,
      nominalBurdenM: 3,
      nominalSpacingM: 3.5,
      rowCount: 2,
      holesPerRow: 8,
      benchHeightM: 15,
    },
    context,
  );
}

beforeEach(async () => {
  db = await openTestDatabase();
  siteId = createSite(db, { code: 'MDW', name: 'Midway' }, context).id;
  benchId = createBench(
    db,
    {
      siteId,
      name: 'North 60',
      crestLevelM: 84,
      toeLevelM: 69,
      rockType: 'dolerite',
      rockDensityKgM3: 2900,
    },
    context,
  ).id;
});

afterEach(() => closeTestDatabase(db));

describe('rigs', () => {
  it('creates one available with no hours on it', () => {
    const created = rig();
    expect(created.status).toBe('available');
    expect(created.hoursRun).toBe(0);
    expect(getRig(db, created.id).fleetNumber).toBe('DR-01');
  });

  it('refuses a diameter range that runs backwards', () => {
    expect(() => rig({ holeDiameterMaxMm: 50 })).toThrow(ValidationError);
  });

  it('refuses two rigs with the same fleet number on a site', () => {
    rig();
    expect(() => rig()).toThrow(ConflictError);
  });

  it('refuses one on a site that is not there', () => {
    expect(() => rig({ siteId: 'site_missing' })).toThrow(NotFoundError);
  });

  it('lists them and filters by status', () => {
    rig();
    rig({ fleetNumber: 'DR-02', status: 'down' });
    expect(listRigs(db, siteId)).toHaveLength(2);
    expect(listRigs(db, siteId, { status: 'down' })).toHaveLength(1);
  });

  it('retires one once and then refuses', () => {
    const created = rig();
    expect(retireRig(db, created.id, context).status).toBe('retired');
    expect(() => retireRig(db, created.id, context)).toThrow(ConflictError);
  });

  it('names its vocabularies', () => {
    expect(RIG_STATES).toContain('maintenance');
    expect(SHIFTS).toEqual(['day', 'back', 'night']);
  });
});

describe('rigsForPattern', () => {
  it('says which rig can drill it', () => {
    rig();
    const options = rigsForPattern(db, pattern(102).id);
    expect(options[0].suitable).toBe(true);
  });

  it('rules out a rig that does not drill that diameter', () => {
    rig({ holeDiameterMinMm: 76, holeDiameterMaxMm: 89 });
    const [option] = rigsForPattern(db, pattern(115).id);
    expect(option.suitable).toBe(false);
    expect(option.reasons[0]).toContain('76 to 89');
  });

  it('rules out a rig that is down', () => {
    rig({ status: 'down' });
    const [option] = rigsForPattern(db, pattern(102).id);
    expect(option.suitable).toBe(false);
    expect(option.reasons[0]).toContain('is down');
  });

  it('gives both reasons when both apply', () => {
    rig({ status: 'maintenance', holeDiameterMinMm: 60, holeDiameterMaxMm: 76 });
    const [option] = rigsForPattern(db, pattern(102).id);
    expect(option.reasons).toHaveLength(2);
  });
});

describe('shifts', () => {
  it('records one and adds the hours onto the rig', () => {
    const created = rig();
    recordShift(
      db,
      { rigId: created.id, shift: 'day', metresDrilled: 220, holesDrilled: 14, hours: 8 },
      context,
    );
    expect(getRig(db, created.id).hoursRun).toBe(8);
    expect(listShifts(db, created.id)).toHaveLength(1);
  });

  it('refuses two records for the same rig on the same shift', () => {
    const created = rig();
    const shift = { rigId: created.id, shift: 'day', shiftDate: '2026-02-04', hours: 8 };
    recordShift(db, shift, context);
    expect(() => recordShift(db, shift, context)).toThrow(ConflictError);
    expect(() => recordShift(db, { ...shift, shift: 'night' }, context)).not.toThrow();
  });

  it('refuses a shift nobody works', () => {
    const created = rig();
    expect(() =>
      recordShift(db, { rigId: created.id, shift: 'twilight', hours: 8 }, context),
    ).toThrow(ValidationError);
  });

  it('ties a shift to the pattern it was drilling', () => {
    const created = rig();
    const drilled = pattern(102);
    recordShift(db, { rigId: created.id, shift: 'day', hours: 8, patternId: drilled.id }, context);
    expect(listShifts(db, created.id)[0].patternId).toBe(drilled.id);
  });

  it('refuses a pattern that is not there', () => {
    const created = rig();
    expect(() =>
      recordShift(
        db,
        { rigId: created.id, shift: 'day', hours: 8, patternId: 'pat_missing' },
        context,
      ),
    ).toThrow(NotFoundError);
  });

  it('filters the shifts by date', () => {
    const created = rig();
    recordShift(
      db,
      { rigId: created.id, shift: 'day', shiftDate: '2026-02-04', hours: 8 },
      context,
    );
    recordShift(
      db,
      { rigId: created.id, shift: 'day', shiftDate: '2026-02-05', hours: 8 },
      context,
    );
    expect(listShifts(db, created.id, { from: '2026-02-05' })).toHaveLength(1);
  });
});

describe('rigProductivity', () => {
  it('reports metres per drilling hour rather than per hour on site', () => {
    const created = rig();
    recordShift(
      db,
      {
        rigId: created.id,
        shift: 'day',
        metresDrilled: 220,
        holesDrilled: 14,
        hours: 8,
        downtimeMinutes: 60,
        downtimeReason: 'bit change',
      },
      context,
    );
    const productivity = rigProductivity(db, created.id);
    expect(productivity.metresPerHour).toBeCloseTo(31.43, 2);
    expect(productivity.availability).toBeCloseTo(0.875, 3);
  });

  it('groups downtime by what caused it', () => {
    const created = rig();
    recordShift(
      db,
      {
        rigId: created.id,
        shift: 'day',
        shiftDate: '2026-02-04',
        hours: 8,
        downtimeMinutes: 45,
        downtimeReason: 'hydraulic hose',
      },
      context,
    );
    recordShift(
      db,
      { rigId: created.id, shift: 'day', shiftDate: '2026-02-05', hours: 8, downtimeMinutes: 30 },
      context,
    );
    const productivity = rigProductivity(db, created.id);
    expect(productivity.downtimeByReason['hydraulic hose']).toBe(45);
    expect(productivity.downtimeByReason['not recorded']).toBe(30);
  });

  it('has nothing to report before the rig has worked', () => {
    expect(rigProductivity(db, rig().id)).toMatchObject({ shifts: 0, metresPerHour: null });
  });

  it('takes a period', () => {
    const created = rig();
    recordShift(
      db,
      { rigId: created.id, shift: 'day', shiftDate: '2026-02-04', metresDrilled: 100, hours: 8 },
      context,
    );
    recordShift(
      db,
      { rigId: created.id, shift: 'day', shiftDate: '2026-03-04', metresDrilled: 200, hours: 8 },
      context,
    );
    expect(rigProductivity(db, created.id, { from: '2026-03-01' }).metres).toBe(200);
  });
});

describe('updateRig', () => {
  it('changes what it is allowed to', () => {
    const created = rig();
    const updated = updateRig(
      db,
      created.id,
      { status: 'maintenance', fleetNumber: 'DR-99' },
      context,
    );
    expect(updated.status).toBe('maintenance');
    expect(updated.fleetNumber).toBe('DR-01');
  });
});
